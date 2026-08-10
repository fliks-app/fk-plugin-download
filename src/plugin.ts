import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { attachDispatcher } from './dispatcher';
import { HostClient } from './host-client';
import { ROUTE_HANDLERS, type PluginHttpRequest } from './seams/http-routes';
import { JOB_HANDLERS } from './seams/jobs';
import { log } from './log';

const token = process.env.FLIKS_PLUGIN_TOKEN ?? '';
const pluginSockPath = process.env.FLIKS_PLUGIN_SOCK;
const coreSockPath = process.env.FLIKS_CORE_SOCK;

const host = coreSockPath ? new HostClient(coreSockPath) : null;

/** Read alongside `plugin.js` on every `hello` — the manifest core sees is always exactly
 *  the one that shipped in this archive, never a copy baked into the bundle that could drift from it. */
function loadManifest(): unknown {
  const raw = fs.readFileSync(path.join(__dirname, 'plugin.json'), 'utf8');
  return JSON.parse(raw);
}

const requestHandlers: Record<string, (payload: unknown) => Promise<unknown>> = {
  hello: async () => {
    return { manifest: loadManifest(), token };
  },

  health: async () => {
    return { ok: true, detail: `core=${host?.isConnected ? 'connected' : 'disconnected'}` };
  },

  job: async (payload: unknown) => {
    const p = payload as { name: string; jobId: string; args?: unknown };
    const handler = JOB_HANDLERS[p.name];
    if (!handler) throw new Error(`no handler registered for job "${p.name}"`);
    await handler(p.jobId, p.args);
    return { ok: true };
  },

  http: async (payload: unknown) => {
    const p = payload as PluginHttpRequest;
    const handler = ROUTE_HANDLERS[`${p.method} ${p.path}`];
    if (!handler) return { status: 404, headers: { 'content-type': 'application/json' }, body: { error: 'not found' } };
    return handler(p);
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
