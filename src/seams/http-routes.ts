import type { Principal } from '../principal';
import { GrabError, type ManualGrabInput } from '../grab/release-pipeline';
import {
  IndexerNotFoundError,
  UnknownIndexerImplementationError,
  type CreateIndexerInput,
  type IndexerService,
  type TestIndexerConnectionInput,
  type UpdateIndexerInput,
} from './indexers';
import {
  DownloadClientNotFoundError,
  UnsupportedDownloadClientError,
  type CreateDownloadClientInput,
  type DownloadClientsService,
  type TestDownloadClientInput,
  type UpdateDownloadClientInput,
} from './download-clients';
import type { DownloadGrabPipeline } from './grab-pipeline';
import type { BlocklistRepository, IndexerStatsRepository } from '../db/repositories';
import { LEGACY_PATHS, ROUTES } from '../../scripts/manifest-template';
import { log } from '../log';

export interface PluginHttpRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  principal: Principal;
}

export interface PluginHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type RouteHandler = (req: PluginHttpRequest, params: Record<string, string>) => Promise<PluginHttpResponse>;

export interface RouteDeps {
  indexerService: Pick<
    IndexerService,
    'findAll' | 'create' | 'update' | 'remove' | 'testConnection' | 'clearCooldown' | 'clearAllCooldowns'
  >;
  downloadClientsService: Pick<DownloadClientsService, 'findAll' | 'create' | 'update' | 'remove' | 'testConnection'>;
  grabPipeline: Pick<DownloadGrabPipeline, 'searchReleases' | 'grabRelease'>;
  indexerStats: Pick<IndexerStatsRepository, 'dailyStats'>;
  blocklist: Pick<BlocklistRepository, 'list' | 'findById' | 'remove' | 'clear'>;
}

export interface ResolvedRoute {
  handler: RouteHandler;
  params: Record<string, string>;
}

export interface RouteTable {
  resolve(method: string, path: string): ResolvedRoute | null;
}

function jsonResponse(status: number, body: unknown): PluginHttpResponse {
  return { status, headers: { 'content-type': 'application/json' }, body };
}

function badRequest(param: string): PluginHttpResponse {
  return jsonResponse(400, { error: { key: 'download.http.errors.bad_param', detail: param } });
}

function badBody(field: string): PluginHttpResponse {
  return jsonResponse(400, { error: { key: 'download.http.errors.bad_body', detail: field } });
}

function notFoundResponse(detail: string): PluginHttpResponse {
  return jsonResponse(404, { error: { key: 'download.http.errors.not_found', detail } });
}

/** `media_not_found` reads as "no such resource"; every other `GrabError` reads as "this
 *  exists but can't be grabbed right now" — a real distinction for a caller to branch on. */
function grabErrorResponse(err: GrabError): PluginHttpResponse {
  const status = err.messageKey === 'download.grab.errors.media_not_found' ? 404 : 409;
  return jsonResponse(status, { error: { key: err.messageKey, detail: err.detail } });
}

function describePrincipal(p: Principal): string {
  return p.kind === 'delegated' ? `user #${p.userId}` : 'system';
}

/** Core's `mediaAccessible:id` objectGuard already validates `:id` is a strict positive
 *  integer before forwarding — `:seasonId`/`:episodeId` carry no such guard, so this is
 *  the only check standing between a malformed value and a call into the grab pipeline. */
function requireIntParam(params: Record<string, string>, name: string): number | null {
  return /^[1-9]\d*$/.test(params[name] ?? '') ? Number(params[name]) : null;
}

/** Reads an optional numeric param: absent -> `undefined` (fine), present-but-invalid -> `null`. */
function optionalIntParam(params: Record<string, string>, name: string): number | null | undefined {
  if (!(name in params)) return undefined;
  const n = /^[1-9]\d*$/.test(params[name]!) ? Number(params[name]) : null;
  return n;
}

/** Returns the field name that failed a required check, or a fully-typed input. */
function readCreateIndexerInput(body: unknown): CreateIndexerInput | 'name' | 'implementation' {
  const b = (body ?? {}) as Partial<CreateIndexerInput>;
  if (typeof b.name !== 'string' || !b.name.trim()) return 'name';
  if (typeof b.implementation !== 'string' || !b.implementation) return 'implementation';
  return {
    name: b.name,
    implementation: b.implementation,
    settings: typeof b.settings === 'object' && b.settings !== null ? (b.settings as Record<string, unknown>) : undefined,
    enableRss: typeof b.enableRss === 'boolean' ? b.enableRss : undefined,
    enableSearch: typeof b.enableSearch === 'boolean' ? b.enableSearch : undefined,
    priority: typeof b.priority === 'number' ? b.priority : undefined,
    requestDelay: typeof b.requestDelay === 'number' ? b.requestDelay : undefined,
    enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
  };
}

/** Every field optional — `IndexerService.update` only applies what is present. */
function readUpdateIndexerInput(body: unknown): UpdateIndexerInput {
  const b = (body ?? {}) as Partial<UpdateIndexerInput>;
  return {
    name: typeof b.name === 'string' ? b.name : undefined,
    implementation: typeof b.implementation === 'string' ? b.implementation : undefined,
    settings: typeof b.settings === 'object' && b.settings !== null ? (b.settings as Record<string, unknown>) : undefined,
    enableRss: typeof b.enableRss === 'boolean' ? b.enableRss : undefined,
    enableSearch: typeof b.enableSearch === 'boolean' ? b.enableSearch : undefined,
    priority: typeof b.priority === 'number' ? b.priority : undefined,
    requestDelay: typeof b.requestDelay === 'number' ? b.requestDelay : undefined,
    enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
  };
}

function readTestIndexerConnectionInput(body: unknown): TestIndexerConnectionInput | null {
  const b = (body ?? {}) as Partial<TestIndexerConnectionInput>;
  if (typeof b.implementation !== 'string') return null;
  const settings = typeof b.settings === 'object' && b.settings !== null ? b.settings : {};
  return { implementation: b.implementation, settings: settings as Record<string, unknown> };
}

function readCreateDownloadClientInput(body: unknown): CreateDownloadClientInput | 'name' | 'implementation' {
  const b = (body ?? {}) as Partial<CreateDownloadClientInput>;
  if (typeof b.name !== 'string' || !b.name.trim()) return 'name';
  if (typeof b.implementation !== 'string' || !b.implementation) return 'implementation';
  return {
    name: b.name,
    implementation: b.implementation,
    settings: typeof b.settings === 'object' && b.settings !== null ? (b.settings as Record<string, unknown>) : undefined,
    enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
    priority: typeof b.priority === 'number' ? b.priority : undefined,
  };
}

/** Every field optional — `DownloadClientsService.update` only applies what is present. */
function readUpdateDownloadClientInput(body: unknown): UpdateDownloadClientInput {
  const b = (body ?? {}) as Partial<UpdateDownloadClientInput>;
  return {
    name: typeof b.name === 'string' ? b.name : undefined,
    implementation: typeof b.implementation === 'string' ? b.implementation : undefined,
    settings: typeof b.settings === 'object' && b.settings !== null ? (b.settings as Record<string, unknown>) : undefined,
    enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
    priority: typeof b.priority === 'number' ? b.priority : undefined,
  };
}

function readTestDownloadClientInput(body: unknown): TestDownloadClientInput | null {
  const b = (body ?? {}) as Partial<TestDownloadClientInput>;
  if (typeof b.implementation !== 'string') return null;
  const settings = typeof b.settings === 'object' && b.settings !== null ? b.settings : {};
  return { implementation: b.implementation, settings: settings as Record<string, unknown> };
}

async function handleSearchReleases(deps: RouteDeps, params: Record<string, string>, req: PluginHttpRequest): Promise<PluginHttpResponse> {
  const mediaId = requireIntParam(params, 'id');
  if (mediaId === null) return badRequest('id');
  const seasonId = optionalIntParam(params, 'seasonId');
  if (seasonId === null) return badRequest('seasonId');
  const episodeId = optionalIntParam(params, 'episodeId');
  if (episodeId === null) return badRequest('episodeId');
  const customQuery = typeof req.query?.['q'] === 'string' ? req.query['q'] : undefined;

  const releases = await deps.grabPipeline.searchReleases(mediaId, seasonId, episodeId, customQuery);
  return jsonResponse(200, { releases });
}

function readManualGrabInput(body: unknown): ManualGrabInput | undefined {
  const b = (body ?? {}) as Partial<ManualGrabInput>;
  if (typeof b.downloadUrl !== 'string' || !b.downloadUrl) return undefined;
  return {
    downloadUrl: b.downloadUrl,
    sourceTitle: typeof b.sourceTitle === 'string' ? b.sourceTitle : undefined,
    indexerId: typeof b.indexerId === 'number' ? b.indexerId : undefined,
  };
}

async function handleGrab(deps: RouteDeps, params: Record<string, string>, req: PluginHttpRequest): Promise<PluginHttpResponse> {
  const mediaId = requireIntParam(params, 'id');
  if (mediaId === null) return badRequest('id');
  const seasonId = optionalIntParam(params, 'seasonId');
  if (seasonId === null) return badRequest('seasonId');
  const episodeId = optionalIntParam(params, 'episodeId');
  if (episodeId === null) return badRequest('episodeId');

  log.info(`grab http request for media #${mediaId} by ${describePrincipal(req.principal)}`);
  const result = await deps.grabPipeline.grabRelease(mediaId, seasonId, episodeId, readManualGrabInput(req.body));
  return jsonResponse(200, result);
}

async function handleListIndexers(deps: RouteDeps): Promise<PluginHttpResponse> {
  const indexers = await deps.indexerService.findAll();
  return jsonResponse(200, { indexers });
}

async function handleListDownloadClients(deps: RouteDeps): Promise<PluginHttpResponse> {
  const downloadClients = await deps.downloadClientsService.findAll();
  return jsonResponse(200, { downloadClients });
}

async function handleCreateIndexer(deps: RouteDeps, req: PluginHttpRequest): Promise<PluginHttpResponse> {
  const input = readCreateIndexerInput(req.body);
  if (typeof input === 'string') return badBody(input);
  return jsonResponse(201, await deps.indexerService.create(input));
}

async function handleUpdateIndexer(deps: RouteDeps, params: Record<string, string>, req: PluginHttpRequest): Promise<PluginHttpResponse> {
  const id = requireIntParam(params, 'id');
  if (id === null) return badRequest('id');
  return jsonResponse(200, await deps.indexerService.update(id, readUpdateIndexerInput(req.body)));
}

async function handleDeleteIndexer(deps: RouteDeps, params: Record<string, string>): Promise<PluginHttpResponse> {
  const id = requireIntParam(params, 'id');
  if (id === null) return badRequest('id');
  await deps.indexerService.remove(id);
  return jsonResponse(200, {});
}

async function handleTestIndexerConnection(deps: RouteDeps, req: PluginHttpRequest): Promise<PluginHttpResponse> {
  const input = readTestIndexerConnectionInput(req.body);
  if (!input) return badBody('implementation');
  return jsonResponse(200, await deps.indexerService.testConnection(input));
}

/** Same 30-day window as core's own `IndexersController.getStats` — no existence
 *  check, an unknown id just reads back no rows, matching that behaviour exactly. */
async function handleIndexerStats(deps: RouteDeps, params: Record<string, string>): Promise<PluginHttpResponse> {
  const id = requireIntParam(params, 'id');
  if (id === null) return badRequest('id');
  const since = new Date();
  since.setDate(since.getDate() - 30);
  return jsonResponse(200, await deps.indexerStats.dailyStats(id, since.toISOString()));
}

async function handleClearIndexerCooldown(deps: RouteDeps, params: Record<string, string>): Promise<PluginHttpResponse> {
  const id = requireIntParam(params, 'id');
  if (id === null) return badRequest('id');
  return jsonResponse(200, await deps.indexerService.clearCooldown(id));
}

async function handleClearAllIndexerCooldowns(deps: RouteDeps): Promise<PluginHttpResponse> {
  return jsonResponse(200, deps.indexerService.clearAllCooldowns());
}

async function handleCreateDownloadClient(deps: RouteDeps, req: PluginHttpRequest): Promise<PluginHttpResponse> {
  const input = readCreateDownloadClientInput(req.body);
  if (typeof input === 'string') return badBody(input);
  return jsonResponse(201, await deps.downloadClientsService.create(input));
}

async function handleUpdateDownloadClient(
  deps: RouteDeps,
  params: Record<string, string>,
  req: PluginHttpRequest,
): Promise<PluginHttpResponse> {
  const id = requireIntParam(params, 'id');
  if (id === null) return badRequest('id');
  return jsonResponse(200, await deps.downloadClientsService.update(id, readUpdateDownloadClientInput(req.body)));
}

async function handleDeleteDownloadClient(deps: RouteDeps, params: Record<string, string>): Promise<PluginHttpResponse> {
  const id = requireIntParam(params, 'id');
  if (id === null) return badRequest('id');
  await deps.downloadClientsService.remove(id);
  return jsonResponse(200, {});
}

async function handleTestDownloadClientConnection(deps: RouteDeps, req: PluginHttpRequest): Promise<PluginHttpResponse> {
  const input = readTestDownloadClientInput(req.body);
  if (!input) return badBody('implementation');
  return jsonResponse(200, await deps.downloadClientsService.testConnection(input));
}

async function handleListBlocklist(deps: RouteDeps, req: PluginHttpRequest): Promise<PluginHttpResponse> {
  const page = Math.max(1, Math.trunc(Number(req.query['page'])) || 1);
  const pageSize = Math.max(1, Math.trunc(Number(req.query['pageSize'])) || 25);
  const { items, total } = await deps.blocklist.list(pageSize, (page - 1) * pageSize);
  return jsonResponse(200, { data: items, total, page, pageSize });
}

async function handleClearBlocklist(deps: RouteDeps): Promise<PluginHttpResponse> {
  await deps.blocklist.clear();
  return jsonResponse(200, {});
}

async function handleRemoveBlocklistEntry(deps: RouteDeps, params: Record<string, string>): Promise<PluginHttpResponse> {
  const id = requireIntParam(params, 'id');
  if (id === null) return badRequest('id');
  const existing = await deps.blocklist.findById(id);
  if (!existing) return notFoundResponse(String(id));
  await deps.blocklist.remove(id);
  return jsonResponse(200, {});
}

/** Catches every handler's rejection so a domain error becomes a structured, i18n-keyed
 *  response rather than an RPC-level `ERR` frame carrying a raw message. */
function wrap(handler: RouteHandler): RouteHandler {
  return async (req, params) => {
    try {
      return await handler(req, params);
    } catch (err) {
      if (err instanceof GrabError) return grabErrorResponse(err);
      if (err instanceof IndexerNotFoundError || err instanceof DownloadClientNotFoundError) {
        return notFoundResponse((err as Error).message);
      }
      if (err instanceof UnknownIndexerImplementationError || err instanceof UnsupportedDownloadClientError) {
        return badBody('implementation');
      }
      log.error(`http handler failed: ${(err as Error).message}`);
      return jsonResponse(500, { error: { key: 'download.http.errors.internal', detail: (err as Error).message } });
    }
  };
}

/**
 * Every route this plugin actually backs with a handler. `GET /delay-profiles` and
 * `GET /queue` are declared in the manifest (`ROUTES`) but have no backing model in this
 * plugin — deliberately absent here, so they 404 like any unknown path.
 *
 * `/indexers/cooldowns` and `/blocklist/all` are declared ahead of their `:id` siblings:
 * `createRouteTable` resolves first-match-wins, so the literal segment must come first
 * (see `test/http-routes.test.ts`'s ordering assertions).
 */
function canonicalRoutes(deps: RouteDeps): { method: string; path: string; handler: RouteHandler }[] {
  const releases: RouteHandler = (req, params) => handleSearchReleases(deps, params, req);
  const grab: RouteHandler = (req, params) => handleGrab(deps, params, req);
  return [
    { method: 'GET', path: '/:id/releases', handler: releases },
    { method: 'POST', path: '/:id/grab', handler: grab },
    { method: 'GET', path: '/:id/upgrade-releases', handler: releases },
    { method: 'POST', path: '/:id/upgrade', handler: grab },
    { method: 'GET', path: '/:id/seasons/:seasonId/releases', handler: releases },
    { method: 'POST', path: '/:id/seasons/:seasonId/grab', handler: grab },
    { method: 'GET', path: '/:id/episodes/:episodeId/releases', handler: releases },
    { method: 'POST', path: '/:id/episodes/:episodeId/grab', handler: grab },
    { method: 'GET', path: '/indexers', handler: () => handleListIndexers(deps) },
    { method: 'POST', path: '/indexers', handler: (req) => handleCreateIndexer(deps, req) },
    { method: 'POST', path: '/indexers/test-connection', handler: (req) => handleTestIndexerConnection(deps, req) },
    { method: 'DELETE', path: '/indexers/cooldowns', handler: () => handleClearAllIndexerCooldowns(deps) },
    { method: 'PUT', path: '/indexers/:id', handler: (req, params) => handleUpdateIndexer(deps, params, req) },
    { method: 'DELETE', path: '/indexers/:id', handler: (_req, params) => handleDeleteIndexer(deps, params) },
    { method: 'DELETE', path: '/indexers/:id/cooldown', handler: (_req, params) => handleClearIndexerCooldown(deps, params) },
    { method: 'GET', path: '/indexers/:id/stats', handler: (_req, params) => handleIndexerStats(deps, params) },
    { method: 'GET', path: '/download-clients', handler: () => handleListDownloadClients(deps) },
    { method: 'POST', path: '/download-clients', handler: (req) => handleCreateDownloadClient(deps, req) },
    {
      method: 'POST',
      path: '/download-clients/test-connection',
      handler: (req) => handleTestDownloadClientConnection(deps, req),
    },
    { method: 'PUT', path: '/download-clients/:id', handler: (req, params) => handleUpdateDownloadClient(deps, params, req) },
    { method: 'DELETE', path: '/download-clients/:id', handler: (_req, params) => handleDeleteDownloadClient(deps, params) },
    { method: 'GET', path: '/blocklist', handler: (req) => handleListBlocklist(deps, req) },
    { method: 'DELETE', path: '/blocklist/all', handler: () => handleClearBlocklist(deps) },
    { method: 'DELETE', path: '/blocklist/:id', handler: (_req, params) => handleRemoveBlocklistEntry(deps, params) },
  ];
}

type PathSegment = string | { param: string };

interface CompiledRoute {
  method: string;
  segments: PathSegment[];
  handler: RouteHandler;
}

function compileTemplate(path: string): PathSegment[] {
  return path.split('/').map((seg) => (seg.startsWith(':') ? { param: seg.slice(1) } : seg));
}

/** `null` on malformed percent-encoding — a request that can't even be decoded matches
 *  nothing, rather than crashing the match attempt. */
function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Splits on the raw (still percent-encoded) `/` *before* decoding each segment — the order
 * that keeps a `%2F` inside one segment's value from ever being mistaken for an extra path
 * separator. Matching is case-sensitive throughout (method and every literal segment):
 * core's own proxy route table matches case-insensitively, but this plugin's declared paths
 * have exactly one casing and a caller sending another must not silently get through.
 */
function matchOne(route: CompiledRoute, method: string, rawSegments: string[]): Record<string, string> | null {
  if (route.method !== method) return null;
  if (route.segments.length !== rawSegments.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < route.segments.length; i++) {
    const tmpl = route.segments[i]!;
    const decoded = safeDecode(rawSegments[i]!);
    if (decoded === null) return null;
    if (typeof tmpl === 'string') {
      if (tmpl !== decoded) return null;
    } else {
      params[tmpl.param] = decoded;
    }
  }
  return params;
}

function buildCompiledRoutes(deps: RouteDeps): CompiledRoute[] {
  const canonical = canonicalRoutes(deps);
  const byKey = new Map(canonical.map((r) => [`${r.method} ${r.path}`, r]));

  const legacy = Object.entries(LEGACY_PATHS).flatMap(([oldKey, newKey]) => {
    const target = byKey.get(newKey);
    if (!target) return []; // manifest.test.ts already proves every legacyPaths value names a declared route
    const spaceAt = oldKey.indexOf(' ');
    const method = oldKey.slice(0, spaceAt);
    const path = oldKey.slice(spaceAt + 1);
    return [{ method, path, handler: target.handler }];
  });

  return [...canonical, ...legacy].map((r) => ({
    method: r.method,
    segments: compileTemplate(r.path),
    handler: wrap(r.handler),
  }));
}

export function createRouteTable(deps: RouteDeps): RouteTable {
  const routes = buildCompiledRoutes(deps);
  return {
    resolve(method, path) {
      const rawSegments = path.split('/');
      for (const route of routes) {
        const params = matchOne(route, method, rawSegments);
        if (params) return { handler: route.handler, params };
      }
      return null;
    },
  };
}

/** Re-exported for tests that want to prove the table's shape against the manifest's own
 *  `ROUTES`/`LEGACY_PATHS` arrays rather than a hand-copied list. `canonicalRoutes` itself
 *  (not just `createRouteTable`'s resolution) is exposed so a parity test can diff its
 *  method+path keys against `ROUTES` directly, in both directions. */
export { ROUTES, LEGACY_PATHS, canonicalRoutes };
