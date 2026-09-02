/**
 * Proves the built plugin speaks the real wire protocol with no core
 * running: spawns `dist/plugin.js` under exactly the env allowlist and
 * `node --permission` flags the Fliks supervisor uses (see
 * `backend/src/modules/plugins/supervisor/spawn-plan.ts`), plays the core
 * side of both unix sockets, and drives hello -> health -> event -> config
 * -> http -> job -> shutdown.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { build } from '../scripts/build';
import { FrameReader, encodeFrame, parseFrame, isReq, type Note, type Req } from '../src/protocol';
import { isDatabaseReachable, adminPool, MIGTEST_DSN } from './db-test-helpers';
import { pluginSchemaName } from '../src/db/pool';

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const DATA_DIR = path.join(DIST, 'data');

function resolvePermissionFlag(): string {
  const probe = spawnSync(process.execPath, ['--permission', '-e', '0']);
  return probe.status === 0 ? '--permission' : '--experimental-permission';
}

/** Stands in for core's `RpcChannel` on the one connection the plugin dials
 *  into `FLIKS_PLUGIN_SOCK` — sends requests, collects notes and replies. */
class CoreSideChannel {
  private reader = new FrameReader();
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly notesReceived: Note[] = [];

  constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      for (const line of this.reader.push(chunk)) {
        const frame = parseFrame(line);
        if (isReq(frame)) continue; // the plugin never calls core on this socket
        if ('i' in frame && frame.i !== undefined && !('m' in frame)) {
          const call = this.pending.get((frame as { i: number }).i);
          if (!call) continue;
          this.pending.delete((frame as { i: number }).i);
          const res = frame as { i: number; r?: unknown; e?: { c: string; m: string } };
          if (res.e) call.reject(new Error(`${res.e.c}: ${res.e.m}`));
          else call.resolve(res.r);
        } else {
          this.notesReceived.push(frame as Note);
        }
      }
    });
  }

  call<T = unknown>(method: string, payload: unknown, deadlineMs = 5000): Promise<T> {
    const i = this.nextId++;
    const req: Req = { i, m: method, p: payload };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(i);
        reject(new Error(`timeout waiting for "${method}"`));
      }, deadlineMs);
      this.pending.set(i, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket.write(encodeFrame(req));
    });
  }

  sendNote(note: Note): void {
    this.socket.write(encodeFrame(note));
  }
}

function waitForConnection(server: net.Server, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no connection within deadline')), timeoutMs);
    server.once('connection', (socket) => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('did not exit within deadline')), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Set once the real `public.media` row for the "resolvable" queue test exists — read by
 *  `cannedHostReply`'s `media.resolve` case, which otherwise has nothing to resolve. */
let resolvableMediaId: number | undefined;

/** Canned replies for the one host method the five jobs actually reach on an empty DB
 *  (`CleanStalled`'s `config.get` — every other job returns before calling out, since
 *  no indexer/client rows exist) plus the handful the http drive's grab paths hit.
 *  `media.resolve` mirrors core's own behaviour: only ids it actually knows come back —
 *  everything else (including any id before `resolvableMediaId` is set) resolves to nothing. */
function cannedHostReply(method: string, payload: unknown): unknown {
  switch (method) {
    case 'config.get':
      return {};
    case 'media.acquisitionContext':
      return null;
    case 'acquisition.candidates':
      return { items: [], cursor: null };
    case 'releases.match':
      return [];
    case 'releases.score':
      return [];
    case 'media.resolve': {
      const { mediaIds = [] } = payload as { mediaIds?: number[] };
      const out: Record<string, { title: string; kind: string; libraryId: number }> = {};
      if (resolvableMediaId != null && mediaIds.includes(resolvableMediaId)) {
        out[`media:${resolvableMediaId}`] = { title: 'Harness Media', kind: 'movie', libraryId: 1 };
      }
      return out;
    }
    default:
      return null;
  }
}

const PLUGIN_ID = 'fliks.download';
const SCHEMA = pluginSchemaName(PLUGIN_ID);
const SIX_TABLES = ['indexers', 'download_clients', 'indexer_stats', 'download_history', 'blocklist', 'stalled_checks'];
/** Created by this plugin rather than ported from Fliks, so it is listed apart. */
const OWN_TABLES = ['indexer_sources'];

let runtimeDir: string;
let coreSockPath: string;
let pluginSockPath: string;
let coreServer: net.Server;
let pluginServer: net.Server;
let child: ChildProcess;
let stdout = '';
let stderr = '';
let coreDialedIn = false;
let reachable = false;
let admin: ReturnType<typeof adminPool> | undefined;
const token = randomBytes(32).toString('hex');

before(async () => {
  // `hello` never replies until migrations have run, so this harness needs a real
  // database; skips (see the test body) rather than fails when migtest is absent.
  reachable = await isDatabaseReachable();
  if (reachable) {
    admin = adminPool();
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
  }

  build();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fkplugin-harness-'));
  coreSockPath = path.join(runtimeDir, 'core.sock');
  pluginSockPath = path.join(runtimeDir, 'plugin.sock');

  coreServer = net.createServer((socket) => {
    coreDialedIn = true;
    const reader = new FrameReader();
    socket.on('data', (chunk: Buffer) => {
      for (const line of reader.push(chunk)) {
        const frame = parseFrame(line);
        if (!isReq(frame)) continue;
        socket.write(encodeFrame({ i: (frame as Req).i, r: cannedHostReply((frame as Req).m, (frame as Req).p) }));
      }
    });
  });
  pluginServer = net.createServer();
  await Promise.all([
    new Promise<void>((r) => coreServer.listen(coreSockPath, r)),
    new Promise<void>((r) => pluginServer.listen(pluginSockPath, r)),
  ]);

  if (!reachable) return; // nothing to spawn — the test below skips itself

  const permFlag = resolvePermissionFlag();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    NODE_ENV: 'test',
    TZ: 'UTC',
    HOME: DATA_DIR,
    FLIKS_CORE_SOCK: coreSockPath,
    FLIKS_PLUGIN_SOCK: pluginSockPath,
    FLIKS_PLUGIN_TOKEN: token,
    FLIKS_PLUGIN_ID: PLUGIN_ID,
    FLIKS_API_VERSION: '0',
    FLIKS_DB_URL: MIGTEST_DSN,
  };
  const args = [
    permFlag,
    `--allow-fs-read=${DIST}`,
    `--allow-fs-write=${DATA_DIR}`,
    '--max-old-space-size=256',
    '--disable-proto=delete',
    path.join(DIST, 'plugin.js'),
  ];

  child = spawn(process.execPath, args, { cwd: DATA_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
  child.stderr?.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
});

after(async () => {
  if (reachable) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already exited
    }
  }
  coreServer?.close();
  pluginServer?.close();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  if (admin) {
    if (resolvableMediaId != null) await admin.query(`DELETE FROM public."media" WHERE id = $1`, [resolvableMediaId]);
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.end();
  }
  console.log('--- plugin stdout ---\n' + stdout.trimEnd());
  console.log('--- plugin stderr ---\n' + stderr.trimEnd());
});

test('speaks the full protocol without core: connect, hello, health, event, config, http, job, shutdown', async (t) => {
  if (!reachable) {
    t.skip('fliks-migtest not reachable on 127.0.0.1:55432');
    return;
  }
  const socket = await waitForConnection(pluginServer, 10_000);
  const channel = new CoreSideChannel(socket);

  const hello = await channel.call<{ manifest: { id: string; kind: string }; token: string }>(
    'hello',
    { pluginApi: 0, coreVersion: '2.0.1', config: {} },
    10_000,
  );
  assert.equal(hello.token, token, 'hello must echo FLIKS_PLUGIN_TOKEN verbatim');
  assert.equal(hello.manifest.id, 'fliks.download');
  assert.equal(hello.manifest.kind, 'process');

  const { rows: tables } = await admin!.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
    [SCHEMA],
  );
  assert.deepEqual(
    tables.map((r) => r.table_name),
    ['_migrations', ...SIX_TABLES, ...OWN_TABLES].sort(),
    'hello must not reply until migrateUp has actually created every table',
  );

  const health = await channel.call<{ ok: boolean }>('health', {});
  assert.equal(health.ok, true);

  channel.sendNote({ m: 'event', p: { name: 'media.acquisition.requested', payload: { mediaIds: [1] } } });
  channel.sendNote({ m: 'config', p: { changed: ['plugin.fliks.download.requestsAutoGrabOnApproval'] } });
  await new Promise((r) => setTimeout(r, 200)); // let the fire-and-forget notes land

  const healthAfterNotes = await channel.call<{ ok: boolean }>('health', {});
  assert.equal(healthAfterNotes.ok, true, 'notes must never wedge the process or block health');

  const notFound = await channel.call<{ status: number }>('http', {
    method: 'GET',
    path: '/delay-profiles',
    query: {},
    body: null,
    principal: { kind: 'system' },
  });
  assert.equal(notFound.status, 404, 'a declared route with no backing model still 404s, not a fake response');

  // The queue and implementations routes this task adds — the exact payload shape a
  // renderer will receive, over the real socket, against the real (migrated) DB.
  const emptyQueue = await channel.call<{
    status: number;
    body: { data: unknown[]; total: number; page: number; pageSize: number; clientsUnreachable: boolean };
  }>('http', { method: 'GET', path: '/queue', query: {}, body: null, principal: { kind: 'system' } });
  assert.equal(emptyQueue.status, 200);
  assert.deepEqual(emptyQueue.body, { data: [], total: 0, page: 1, pageSize: 25, clientsUnreachable: false });

  const indexerImpls = await channel.call<{
    status: number;
    body: { implementation: string; labelKey: string; fields: { key: string }[] }[];
  }>('http', { method: 'GET', path: '/indexers/implementations', query: {}, body: null, principal: { kind: 'system' } });
  assert.equal(indexerImpls.status, 200);
  assert.ok(Array.isArray(indexerImpls.body), 'the shape must be a list even with one implementation');
  assert.deepEqual(indexerImpls.body.map((i) => i.implementation), ['torznab']);
  assert.ok(indexerImpls.body[0]!.fields.some((f) => f.key === 'baseUrl'));

  const clientImpls = await channel.call<{
    status: number;
    body: { implementation: string; fields: { key: string }[] }[];
  }>('http', {
    method: 'GET',
    path: '/download-clients/implementations',
    query: {},
    body: null,
    principal: { kind: 'system' },
  });
  assert.equal(clientImpls.status, 200);
  assert.deepEqual(clientImpls.body.map((i) => i.implementation), ['qbittorrent']);
  assert.ok(clientImpls.body[0]!.fields.some((f) => f.key === 'host'));

  // An enabled client with no host configured fails `getTorrentsResult` inline, with no
  // network call — deterministic proof of the unreachable-client case the queue route
  // must convey rather than hide behind an empty page.
  const { rows: unreachableClientRows } = await admin!.query<{ id: number }>(
    `INSERT INTO "${SCHEMA}"."download_clients" ("name", "implementation", "settings")
       VALUES ('Unreachable qBittorrent', 'qbittorrent', '{}') RETURNING "id"`,
  );
  const unreachableClientId = unreachableClientRows[0]!.id;
  await admin!.query(
    `INSERT INTO "${SCHEMA}"."download_history"
       ("sourceTitle", "quality", "torrentHash", "status", "downloadClientId")
     VALUES ('Harness In-Flight Grab', '1080p', 'deadbeef', 'grabbed', $1)`,
    [unreachableClientId],
  );

  interface QueueRowLike {
    id: number;
    /** The media's own name once it resolves; the release name until then. */
    title: string;
    sourceTitle: string;
    quality: string;
    state: string;
    progress: number | null;
    clientReachable: boolean;
    mediaId: number | null;
    mediaType: string | null;
  }

  const queueWithUnreachableClient = await channel.call<{
    status: number;
    body: {
      data: QueueRowLike[];
      total: number;
      clientsUnreachable: boolean;
      notice?: { messageKey: string; count?: number };
    };
  }>('http', { method: 'GET', path: '/queue', query: {}, body: null, principal: { kind: 'system' } });
  assert.equal(queueWithUnreachableClient.status, 200);
  // A queue lists what the clients report: with none of them answering there is nothing to list,
  // and the notice is what keeps that from reading as "nothing is downloading".
  assert.deepEqual(queueWithUnreachableClient.body.data, []);
  assert.equal(queueWithUnreachableClient.body.total, 0);
  assert.equal(queueWithUnreachableClient.body.clientsUnreachable, true, 'the client-down case must be flagged, not hidden');
  assert.equal(
    queueWithUnreachableClient.body.notice?.messageKey,
    'download.config.queue.notice.hidden_client_unreachable',
  );
  assert.equal(queueWithUnreachableClient.body.notice?.count, 1, 'the row it could not show is counted');

  // A second in-flight row, this one linked to a real core media id via `download_history`'s
  // own FK into `public.media` — proves the queue resolves mediaId/mediaType for a real row,
  // bounded to this page, over the real socket, not just carries the id through unresolved.
  const { rows: mediaRows } = await admin!.query<{ id: number }>(
    `INSERT INTO public."media" ("title", "type") VALUES ('Harness Media', 'movie') RETURNING "id"`,
  );
  resolvableMediaId = mediaRows[0]!.id;
  // No client and no hash on purpose: this row is here for the label resolution, and a row whose
  // client answers nothing is now hidden from the queue (see the notice asserted above).
  await admin!.query(
    `INSERT INTO "${SCHEMA}"."download_history"
       ("sourceTitle", "quality", "status", "mediaId")
     VALUES ('Harness Media Grab', '1080p', 'grabbed', $1)`,
    [resolvableMediaId],
  );

  const queueWithMedia = await channel.call<{
    status: number;
    body: { data: QueueRowLike[]; total: number; notice?: { messageKey: string; count?: number } };
  }>('http', {
    method: 'GET',
    path: '/queue',
    query: {},
    body: null,
    principal: { kind: 'system' },
  });
  assert.equal(queueWithMedia.status, 200);
  assert.equal(queueWithMedia.body.total, 1, 'the listable row is the one no client has to vouch for');
  // Rows are found by their release name, which never moves; `title` is what the resolve
  // replaced, and asserting on it is what this test is here to check.
  const resolvedRow = queueWithMedia.body.data.find((r) => r.sourceTitle === 'Harness Media Grab');
  assert.ok(resolvedRow, 'the media-linked row must be present');
  assert.equal(
    queueWithMedia.body.data.find((r) => r.sourceTitle === 'Harness In-Flight Grab'),
    undefined,
    'the row behind an unreachable client is not listed as if it were running',
  );
  assert.equal(queueWithMedia.body.notice?.count, 1, 'and the notice still accounts for it');
  assert.equal(resolvedRow!.title, 'Harness Media', 'a resolved row is titled by its media, not by the release');
  assert.equal(resolvedRow!.mediaId, resolvableMediaId, 'carries the real core media id straight off the row');
  assert.equal(resolvedRow!.mediaType, 'movie', 'resolved via media.resolve, over the real socket, keyed "media:<id>"');

  // The composition root's real proof: all five manifest job names dispatch into a real
  // handler over the real socket, against the real (empty) fliks-migtest schema.
  const jobNames = ['SearchMissing', 'RssSync', 'ImportCompleted', 'CleanStalled', 'CleanSeeded'];
  const jobResults = await Promise.all(
    jobNames.map((name) => channel.call<{ ok: boolean }>('job', { name, jobId: `job-${name}` }, 15_000)),
  );
  jobResults.forEach((r, i) => assert.equal(r.ok, true, `job "${jobNames[i]}" must run through its wired handler and ack`));

  // A representative wired route: real matching, real service, real (empty) DB read.
  const indexersResp = await channel.call<{ status: number; body: unknown[] }>('http', {
    method: 'GET',
    path: '/indexers',
    query: {},
    body: null,
    principal: { kind: 'system' },
  });
  assert.equal(indexersResp.status, 200);
  assert.deepEqual(indexersResp.body, [], 'a bare array: a wrapper renders as an empty table with no error');

  // The write surface this task adds: create -> read back -> update -> delete, all over the
  // real socket against the real (migrated) DB, proving core can actually reach every one of
  // them and that the apiKey secret never round-trips back out.
  const createResp = await channel.call<{ status: number; body: Record<string, unknown> }>('http', {
    method: 'POST',
    path: '/indexers',
    query: {},
    body: {
      name: 'Harness Indexer',
      implementation: 'torznab',
      settings: { baseUrl: 'https://example.invalid', apiKey: 'super-secret' },
    },
    principal: { kind: 'delegated', userId: 7 },
  });
  assert.equal(createResp.status, 201);
  const createdId = createResp.body['id'] as number;
  assert.equal(typeof createdId, 'number');
  assert.equal((createResp.body['settings'] as Record<string, unknown>)['apiKey'], undefined, 'create must never echo the apiKey back');

  const listAfterCreate = await channel.call<{ status: number; body: Record<string, unknown>[] }>('http', {
    method: 'GET',
    path: '/indexers',
    query: {},
    body: null,
    principal: { kind: 'system' },
  });
  const readBack = listAfterCreate.body.find((ix) => ix['id'] === createdId);
  assert.ok(readBack, 'the created indexer must be readable back from the list');
  assert.equal(readBack!['name'], 'Harness Indexer');
  assert.equal((readBack!['settings'] as Record<string, unknown>)['apiKey'], undefined, 'a read-back row must never carry the apiKey either');

  const updateResp = await channel.call<{ status: number; body: Record<string, unknown> }>('http', {
    method: 'PUT',
    path: `/indexers/${createdId}`,
    query: {},
    body: {
      name: 'Harness Indexer Renamed',
      implementation: 'torznab',
      settings: { baseUrl: 'https://example.invalid', apiKey: '' },
    },
    principal: { kind: 'delegated', userId: 7 },
  });
  assert.equal(updateResp.status, 200);
  assert.equal(updateResp.body['name'], 'Harness Indexer Renamed');
  assert.equal((updateResp.body['settings'] as Record<string, unknown>)['apiKey'], undefined, 'update must not echo the apiKey either');

  // The response can never prove the secret survived (it is always redacted) — read the
  // column directly to prove a blank apiKey on update kept the one already stored.
  const { rows: storedRows } = await admin!.query<{ settings: { apiKey?: string } }>(
    `SELECT "settings" FROM "${SCHEMA}"."indexers" WHERE "id" = $1`,
    [createdId],
  );
  assert.equal(storedRows[0]?.settings.apiKey, 'super-secret', 'a blank apiKey on update must not blank the one already stored');

  const deleteResp = await channel.call<{ status: number }>('http', {
    method: 'DELETE',
    path: `/indexers/${createdId}`,
    query: {},
    body: null,
    principal: { kind: 'delegated', userId: 7 },
  });
  assert.equal(deleteResp.status, 200);

  const listAfterDelete = await channel.call<{ status: number; body: Record<string, unknown>[] }>('http', {
    method: 'GET',
    path: '/indexers',
    query: {},
    body: null,
    principal: { kind: 'system' },
  });
  assert.equal(
    listAfterDelete.body.some((ix) => ix['id'] === createdId),
    false,
    'the deleted indexer must not reappear',
  );

  // A search reaches the real grab pipeline, which round-trips `media.acquisitionContext`
  // over the mocked core socket.
  const searchResp = await channel.call<{ status: number; body: { error: { key: string; detail?: string } } }>('http', {
    method: 'GET',
    path: '/1/releases',
    query: {},
    body: null,
    principal: { kind: 'delegated', userId: 7 },
  });
  assert.equal(searchResp.status, 404);
  assert.equal(searchResp.body.error.key, 'download.grab.errors.media_not_found');
  assert.equal(searchResp.body.error.detail, '1');

  // A ".." path segment where a numeric id is expected: the shape still matches (one
  // segment, whatever its content) but the handler's own param validation rejects it.
  const traversalResp = await channel.call<{ status: number }>('http', {
    method: 'GET',
    path: '/../releases',
    query: {},
    body: null,
    principal: { kind: 'system' },
  });
  assert.equal(traversalResp.status, 400, '".." is not a valid id — rejected by validation, not treated as a path');

  const shutdown = await channel.call<{ ok: boolean }>('shutdown', {});
  assert.equal(shutdown.ok, true);

  const exitCode = await waitForExit(child, 5_000);
  assert.equal(exitCode, 0, 'must exit cleanly after shutdown');
  assert.equal(coreDialedIn, true, 'the plugin must dial out to FLIKS_CORE_SOCK for its host-method client');
});
