import type { Principal } from '../principal';
import { GrabError, type ManualGrabInput } from '../grab/release-pipeline';
import type { IndexerService } from './indexers';
import type { DownloadClientsService } from './download-clients';
import type { DownloadGrabPipeline } from './grab-pipeline';
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
  indexerService: Pick<IndexerService, 'findAll'>;
  downloadClientsService: Pick<DownloadClientsService, 'findAll'>;
  grabPipeline: Pick<DownloadGrabPipeline, 'searchReleases' | 'grabRelease'>;
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

/** Catches every handler's rejection so a domain error becomes a structured, i18n-keyed
 *  response rather than an RPC-level `ERR` frame carrying a raw message. */
function wrap(handler: RouteHandler): RouteHandler {
  return async (req, params) => {
    try {
      return await handler(req, params);
    } catch (err) {
      if (err instanceof GrabError) return grabErrorResponse(err);
      log.error(`http handler failed: ${(err as Error).message}`);
      return jsonResponse(500, { error: { key: 'download.http.errors.internal', detail: (err as Error).message } });
    }
  };
}

/** The ten routes this plugin actually backs with data. `GET /delay-profiles` and
 *  `GET /queue` are declared in the manifest (`ROUTES`) but have no backing model in this
 *  plugin (`delay_profiles` stays core's table; no queue response shape is specified
 *  anywhere) — they are deliberately absent here, so they 404 like any unknown path. */
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
    { method: 'GET', path: '/download-clients', handler: () => handleListDownloadClients(deps) },
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
 *  `ROUTES`/`LEGACY_PATHS` arrays rather than a hand-copied list. */
export { ROUTES, LEGACY_PATHS };
