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

const PLUGIN_ID = 'fliks.download';
const SCHEMA = pluginSchemaName(PLUGIN_ID);
const SIX_TABLES = ['indexers', 'download_clients', 'indexer_stats', 'download_history', 'blocklist', 'stalled_checks'];

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
    socket.on('data', () => {}); // no host-method call is made this phase — nothing to answer
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
    ['_migrations', ...SIX_TABLES].sort(),
    'hello must not reply until migrateUp has actually created the six tables',
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
    path: '/queue',
    query: {},
    body: null,
    principal: { kind: 'system' },
  });
  assert.equal(notFound.status, 404, 'a declared route with no registered handler yet must 404, not fake a response');

  await assert.rejects(
    channel.call('job', { name: 'SearchMissing', jobId: '1' }),
    /no handler registered for job "SearchMissing"/,
    'a declared job with no registered handler yet must fail the call, not claim it ran',
  );

  const shutdown = await channel.call<{ ok: boolean }>('shutdown', {});
  assert.equal(shutdown.ok, true);

  const exitCode = await waitForExit(child, 5_000);
  assert.equal(exitCode, 0, 'must exit cleanly after shutdown');
  assert.equal(coreDialedIn, true, 'the plugin must dial out to FLIKS_CORE_SOCK for its host-method client');
});
