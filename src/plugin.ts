import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { attachDispatcher } from './dispatcher';
import { HostClient } from './host-client';
import { type PluginHttpRequest } from './seams/http-routes';
import type { PluginApi } from './plugin-methods';
import { log } from './log';
import { createPluginPool } from './db/pool';
import { migrateUp } from './db/migrate';
import { createRepositories, type Repositories } from './db/repositories';
import { createAppGraph, type AppGraph } from './composition-root';

const token = process.env.FLIKS_PLUGIN_TOKEN ?? '';
const pluginSockPath = process.env.FLIKS_PLUGIN_SOCK;
const coreSockPath = process.env.FLIKS_CORE_SOCK;
const dbUrl = process.env.FLIKS_DB_URL;
const pluginId = process.env.FLIKS_PLUGIN_ID;

const host = coreSockPath ? new HostClient(coreSockPath) : null;

/** Populated once migrations succeed; stays null for the life of the process otherwise.
 *  Seam handlers that touch the database must check for null before using it. */
export let repositories: Repositories | null = null;

/** The composition root's output — built once, right after `repositories`, from the same
 *  guard. `job`/`http` handlers below must check for null exactly like `repositories`. */
export let appGraph: AppGraph | null = null;

type DbInit = { ok: true } | { ok: false; reason: string };

/** Runs once per spawn, before `hello` ever replies. Never throws: rejecting here would
 *  be an unhandled rejection in the window before anything awaits it (`hello` is the
 *  first thing that does) — the failure is carried in the return value instead. */
async function initDb(): Promise<DbInit> {
  if (!dbUrl || !pluginId) {
    return { ok: false, reason: 'FLIKS_DB_URL or FLIKS_PLUGIN_ID is not set' };
  }
  if (!host) {
    return { ok: false, reason: 'FLIKS_CORE_SOCK is not set' };
  }
  try {
    const pool = createPluginPool({ dsn: dbUrl, pluginId });
    pool.on('error', (err) => log.error(`pool error: ${err.message}`));
    await migrateUp(pool);
    repositories = createRepositories(pool);
    appGraph = createAppGraph(repositories, host);
    // Re-arms rows a previous run left `importing` — nothing is actually in flight
    // right after a fresh process start.
    await appGraph.completionPoller.init();
    return { ok: true };
  } catch (err) {
    log.error(`startup failed: ${(err as Error).message}`);
    return { ok: false, reason: 'startup did not complete — see plugin logs' };
  }
}

/** Kicked off at module load so it races the socket connect, not the `hello` round-trip. */
const dbInit: Promise<DbInit> = initDb();

/** Read alongside `plugin.js` on every `hello` — the manifest core sees is always exactly
 *  the one that shipped in this archive, never a copy baked into the bundle that could drift from it. */
function loadManifest(): unknown {
  const raw = fs.readFileSync(path.join(__dirname, 'plugin.json'), 'utf8');
  return JSON.parse(raw);
}

// `hello` and `health` are annotated off the restated contract, so a mirror that drifts from
// core's `plugin-methods.ts` stops compiling here instead of failing at a handshake.
const hello: PluginApi['hello'] = async () => {
  const db = await dbInit;
  if (!db.ok) throw new Error(`database not ready: ${db.reason}`);
  return { manifest: loadManifest(), token };
};

const requestHandlers: Record<string, (payload: unknown) => Promise<unknown>> = {
  hello: (payload) => hello(payload as Parameters<PluginApi['hello']>[0]),

  health: async () => {
    return { ok: true, detail: `core=${host?.isConnected ? 'connected' : 'disconnected'}` };
  },

  job: async (payload: unknown) => {
    const p = payload as { name: string; jobId: string; args?: unknown };
    if (!appGraph) throw new Error('plugin not ready — database not initialised, see plugin logs');
    const handler = appGraph.jobHandlers[p.name];
    if (!handler) throw new Error(`no handler registered for job "${p.name}"`);
    await handler(p.jobId, p.args);
    return { ok: true };
  },

  http: async (payload: unknown) => {
    const p = payload as PluginHttpRequest;
    if (!appGraph) {
      return { status: 503, headers: { 'content-type': 'application/json' }, body: { error: { key: 'download.http.errors.not_ready' } } };
    }
    const resolved = appGraph.routeTable.resolve(p.method, p.path);
    if (!resolved) {
      return { status: 404, headers: { 'content-type': 'application/json' }, body: { error: { key: 'download.http.errors.not_found' } } };
    }
    return resolved.handler(p, resolved.params);
  },

  shutdown: async () => {
    setTimeout(() => process.exit(0), 10); // let the reply flush before exiting
    return { ok: true };
  },
};

const noteHandlers: Record<string, (payload: unknown) => void> = {
  event: (payload) => {
    const p = payload as { name: string; payload: unknown };
    log.info(`event "${p.name}" received (no subscriber registered yet)`);
  },

  config: (payload) => {
    const p = payload as { changed: string[] };
    log.info(`config changed: ${p.changed.join(', ')} (takes effect on next restart)`);
  },
};

function main(): void {
  if (!pluginSockPath) {
    log.error('FLIKS_PLUGIN_SOCK is not set; cannot start');
    process.exit(1);
  }
  if (!coreSockPath) {
    log.error('FLIKS_CORE_SOCK is not set; cannot start');
    process.exit(1);
  }

  host?.connect();

  const socket = net.connect(pluginSockPath);
  socket.on('connect', () => log.info(`connected to ${pluginSockPath}`));
  socket.on('error', (err) => log.error(`plugin socket error: ${err.message}`));
  attachDispatcher(socket, requestHandlers, noteHandlers);

  log.info('fliks.download started');
}

main();
