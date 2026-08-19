import type { Principal } from '../principal';
import type { MediaKind } from '../host-methods';
import type { HostCaller } from '../grab/types';
import { GrabError, type ManualGrabInput } from '../grab/release-pipeline';
import type { RankedRelease } from '../grab/release-scoring';
import { torrentProgressState } from '../grab/progress-state';
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
  type ClientTorrent,
  type CreateDownloadClientInput,
  type DownloadClientDriver,
  type DownloadClientsService,
  type TestDownloadClientInput,
  type UpdateDownloadClientInput,
} from './download-clients';
import type { DownloadGrabPipeline } from './grab-pipeline';
import type {
  BlocklistRepository,
  DownloadClientsRepository,
  DownloadHistoryRepository,
  IndexerStatsRepository,
} from '../db/repositories';
import type { DownloadHistoryRow, DownloadHistoryStatus, GrabSource } from '../db/rows';
import {  ROUTES } from '../../scripts/manifest-template';

/** Core's `media.resolve` refuses more than this many ids, and the queue resolves one per row.
 *  A page bigger than it cannot be labelled, so it is clamped rather than answered half-built. */
const MAX_PAGE_SIZE = 100;

function readPageSize(raw: unknown): number {
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(raw)) || 25));
}
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
  downloadHistory: Pick<DownloadHistoryRepository, 'findByStatuses' | 'listPage'>;
  /** Raw rows (credentials included) — unlike `downloadClientsService`, which redacts
   *  them before a driver call ever happens. */
  downloadClientsRepo: Pick<DownloadClientsRepository, 'listEnabled'>;
  downloadClientDrivers: Readonly<Record<string, DownloadClientDriver>>;
  host: HostCaller;
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
  return {
    implementation: b.implementation,
    settings: settings as Record<string, unknown>,
    ...(Number.isInteger(b.id) ? { id: b.id as number } : {}),
  };
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
  return {
    implementation: b.implementation,
    settings: settings as Record<string, unknown>,
    ...(Number.isInteger(b.id) ? { id: b.id as number } : {}),
  };
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
  // A bare array of core-vocabulary rows: these routes answer core's own URLs.
  return jsonResponse(200, releases.map(toWireRelease));
}

/** Core names the release source `sourceId`/`sourceName`; inside this plugin it is an indexer row. */
function toWireRelease({ indexerId, indexerName, ...rest }: RankedRelease): Record<string, unknown> {
  return { ...rest, sourceId: indexerId, sourceName: indexerName };
}

/** Core names the release source `sourceId`; inside this plugin that source is an indexer row. */
function readManualGrabInput(body: unknown): ManualGrabInput | undefined {
  const b = (body ?? {}) as Record<string, unknown>;
  const downloadUrl = b['downloadUrl'];
  if (typeof downloadUrl !== 'string' || !downloadUrl) return undefined;
  return {
    downloadUrl,
    sourceTitle: typeof b['sourceTitle'] === 'string' ? b['sourceTitle'] : undefined,
    indexerId: typeof b['sourceId'] === 'number' ? b['sourceId'] : undefined,
    force: b['force'] === true,
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

/** A bare array: the `providers` renderer reads the body as the row list, and a wrapper
 *  renders as an empty table with no error. */
async function handleListIndexers(deps: RouteDeps): Promise<PluginHttpResponse> {
  return jsonResponse(200, await deps.indexerService.findAll());
}

async function handleListDownloadClients(deps: RouteDeps): Promise<PluginHttpResponse> {
  return jsonResponse(200, await deps.downloadClientsService.findAll());
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
  const pageSize = readPageSize(req.query['pageSize']);
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

/** What the queue table page renders per row — `state` is always one of core's closed
 *  five progress values, never a client's own vocabulary (`progress-state.ts`). */
export interface QueueItemDto {
  id: number;
  title: string;
  quality: string;
  state: 'queued' | 'active' | 'stalled' | 'paused' | 'importing';
  /** Percent, 0-100 — the table renders it verbatim. Clients report a 0-1 fraction, which
   *  rounded to 0% for everything short of a finished download. */
  progress: number | null;
  bytesPerSecond: number | null;
  /** Total bytes of the torrent, null while no client row backs this one yet. */
  size: number | null;
  /** False when this row's own client could not be queried — `progress`/`bytesPerSecond`
   *  are then unknown, not zero. */
  clientReachable: boolean;
  /** Both null when the row's media can't be resolved — never guessed, since `table.open-media`
   *  renders no button without both. */
  mediaId: number | null;
  mediaType: MediaKind | null;
}

const QUEUE_STATUSES: DownloadHistoryStatus[] = ['grabbed', 'importing'];
const HISTORY_STATUSES: DownloadHistoryStatus[] = ['grabbed', 'importing', 'completed', 'failed', 'warning'];

interface ClientTorrentIndex {
  ok: boolean;
  byHash: Map<string, ClientTorrent>;
}

/** One `getTorrentsResult` per enabled client — each client's `ok` flag is kept, not
 *  collapsed, so a row can tell "client answered, torrent just isn't in it" apart from
 *  "client never answered". */
async function indexClientTorrents(
  deps: RouteDeps,
): Promise<{ byClientId: Map<number, ClientTorrentIndex>; anyUnreachable: boolean }> {
  const clients = await deps.downloadClientsRepo.listEnabled();
  const byClientId = new Map<number, ClientTorrentIndex>();
  let anyUnreachable = false;
  await Promise.all(
    clients.map(async (client) => {
      const driver = deps.downloadClientDrivers[client.implementation];
      if (!driver || !driver.supports(client)) return;
      const result = await driver.getTorrentsResult(client);
      if (!result.ok) anyUnreachable = true;
      byClientId.set(client.id, {
        ok: result.ok,
        byHash: new Map(result.torrents.map((t) => [t.hash.toLowerCase(), t])),
      });
    }),
  );
  return { byClientId, anyUnreachable };
}

/** `importing` is definitive regardless of the client (the download itself is already
 *  done); `grabbed` without a live torrent match means "unknown", never a guessed state. */
function toQueueItem(row: DownloadHistoryRow, byClientId: Map<number, ClientTorrentIndex>): QueueItemDto {
  const base = { id: row.id, title: row.sourceTitle, quality: row.quality, mediaId: row.mediaId, mediaType: null as MediaKind | null };
  if (row.status === 'importing') {
    return { ...base, state: 'importing', progress: 100, bytesPerSecond: null, size: null, clientReachable: true };
  }
  const index = row.downloadClientId != null ? byClientId.get(row.downloadClientId) : undefined;
  const torrent = index && row.torrentHash ? index.byHash.get(row.torrentHash.toLowerCase()) : undefined;
  if (torrent) {
    return {
      ...base,
      state: torrentProgressState(torrent),
      progress: torrent.progress * 100,
      bytesPerSecond: torrent.dlspeed,
      size: torrent.size,
      clientReachable: true,
    };
  }
  return {
    ...base,
    state: 'queued',
    progress: null,
    bytesPerSecond: null,
    size: null,
    clientReachable: index?.ok ?? false,
  };
}

/** `media.resolve` throws above 100 ids — bounding to the ids already on the rendered
 *  page (never the full, unpaged history) is what keeps a large queue from tripping that.
 *  A row whose media doesn't come back (or never had one) keeps `mediaType: null`, never
 *  a guessed kind. */
async function attachMediaTypes(deps: RouteDeps, pageItems: QueueItemDto[]): Promise<QueueItemDto[]> {
  const mediaIds = [...new Set(pageItems.map((item) => item.mediaId).filter((id): id is number => id != null))];
  if (!mediaIds.length) return pageItems;
  const resolved = await deps.host.call('media.resolve', { mediaIds });
  return pageItems.map((item) => {
    if (item.mediaId == null) return item;
    const hit = resolved[`media:${item.mediaId}`];
    return hit ? { ...item, mediaType: hit.kind } : item;
  });
}

/** One row of the history view. `status` and `statusMessage` are the point of it: a failed grab
 *  leaves the queue immediately and this is the only place it can still be read. */
interface HistoryItemDto {
  id: number;
  date: string;
  title: string;
  quality: string;
  status: DownloadHistoryStatus;
  statusMessage: string | null;
  grabSource: GrabSource;
  source: string;
  mediaId: number | null;
  mediaType: MediaKind | null;
}

/** Every grab ever recorded, newest first — the queue only shows what is still in flight.
 *  An unrecognised `status` is dropped, never forwarded to the repository. */
async function handleHistory(deps: RouteDeps, req: PluginHttpRequest): Promise<PluginHttpResponse> {
  const page = Math.max(1, Math.trunc(Number(req.query['page'])) || 1);
  const pageSize = readPageSize(req.query['pageSize']);
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
  const status = HISTORY_STATUSES.includes(req.query['status'] as DownloadHistoryStatus)
    ? (req.query['status'] as DownloadHistoryStatus)
    : undefined;

  const [{ rows, total }, indexers] = await Promise.all([
    deps.downloadHistory.listPage(pageSize, (page - 1) * pageSize, { ...(q ? { q } : {}), ...(status ? { status } : {}) }),
    deps.indexerService.findAll(),
  ]);
  const indexerNames = new Map(indexers.map((ix: { id: number; name: string }) => [ix.id, ix.name]));

  const items: HistoryItemDto[] = rows.map((row) => ({
    id: row.id,
    date: row.createdAt,
    title: row.sourceTitle,
    quality: row.quality,
    status: row.status,
    statusMessage: row.statusMessage,
    grabSource: row.grabSource,
    source: (row.indexerId != null ? indexerNames.get(row.indexerId) : undefined) ?? '',
    mediaId: row.mediaId,
    mediaType: null,
  }));

  // Same bound as the queue: `media.resolve` refuses more than 100 ids, and only this page's are sent.
  const data = await attachMediaTypes(deps, items as unknown as QueueItemDto[]);
  return jsonResponse(200, { data, total, page, pageSize });
}

/** Sourced from `download_history` (always available) and enriched from the live
 *  clients when they answer — never sourced from the clients alone, or a client outage
 *  would render as an empty queue instead of an unreachable one. */
async function handleQueue(deps: RouteDeps, req: PluginHttpRequest): Promise<PluginHttpResponse> {
  const page = Math.max(1, Math.trunc(Number(req.query['page'])) || 1);
  const pageSize = readPageSize(req.query['pageSize']);

  const [rows, { byClientId, anyUnreachable }] = await Promise.all([
    deps.downloadHistory.findByStatuses(QUEUE_STATUSES),
    indexClientTorrents(deps),
  ]);

  const items = rows.map((row) => toQueueItem(row, byClientId)).sort((a, b) => b.id - a.id);
  const start = (page - 1) * pageSize;
  // Slice to the page first — attachMediaTypes's host call must only ever see this page's ids.
  const data = await attachMediaTypes(deps, items.slice(start, start + pageSize));

  return jsonResponse(200, {
    data,
    total: items.length,
    page,
    pageSize,
    clientsUnreachable: anyUnreachable,
  });
}

/** One input a `providers` page's create/edit form renders — the same seven-shape
 *  `FieldDef` the manifest's own config pages use, restated here since a `process`
 *  plugin has no import access to that contract type. */
interface ImplementationFieldDef {
  key: string;
  type: 'text' | 'email' | 'password' | 'url' | 'number' | 'toggle' | 'select';
  labelKey: string;
  hint?: string;
  required?: boolean;
  secret?: boolean;
  default?: string | number | boolean;
  options?: { value: string; labelKey: string }[];
  topLevel?: boolean;
}

interface ImplementationDef {
  implementation: string;
  labelKey: string;
  fields: ImplementationFieldDef[];
}

/** `name`/`priority`/`enabled` are generic to every provider row (handled by the page
 *  itself) — only implementation-specific settings are listed here. `requestDelay` and
 *  `enableSearch` are `topLevel`: real columns on `indexers`, not `settings` keys. */
const INDEXER_IMPLEMENTATIONS: ImplementationDef[] = [
  {
    implementation: 'torznab',
    labelKey: 'download.config.indexers.implementations.torznab',
    fields: [
      { key: 'baseUrl', type: 'url', labelKey: 'download.config.indexers.fields.base_url', required: true },
      { key: 'apiKey', type: 'password', labelKey: 'download.config.indexers.fields.api_key', secret: true },
      {
        key: 'requestDelay',
        type: 'number',
        labelKey: 'download.config.indexers.fields.request_delay',
        hint: 'download.config.indexers.fields.request_delay_hint',
        default: 2,
        topLevel: true,
      },
      {
        key: 'enableSearch',
        type: 'toggle',
        labelKey: 'download.config.indexers.fields.enable_search',
        default: true,
        topLevel: true,
      },
      { key: 'minSeeders', type: 'number', labelKey: 'download.config.indexers.fields.min_seeders', default: 0 },
      {
        key: 'seedRatio',
        type: 'number',
        labelKey: 'download.config.indexers.fields.seed_ratio',
        hint: 'download.config.indexers.fields.seed_ratio_hint',
        default: 1,
      },
      {
        key: 'maxRetentionDays',
        type: 'number',
        labelKey: 'download.config.indexers.fields.max_retention_days',
        hint: 'download.config.indexers.fields.max_retention_days_hint',
      },
      {
        key: 'unknownLanguageIsoCode',
        type: 'text',
        labelKey: 'download.config.indexers.fields.unknown_language',
        hint: 'download.config.indexers.fields.unknown_language_hint',
      },
    ],
  },
];

const DOWNLOAD_CLIENT_IMPLEMENTATIONS: ImplementationDef[] = [
  {
    implementation: 'qbittorrent',
    labelKey: 'download.config.download_clients.implementations.qbittorrent',
    fields: [
      {
        key: 'host',
        type: 'text',
        labelKey: 'download.config.download_clients.fields.host',
        required: true,
        default: 'localhost',
      },
      { key: 'port', type: 'number', labelKey: 'download.config.download_clients.fields.port', default: 8080 },
      { key: 'useSsl', type: 'toggle', labelKey: 'download.config.download_clients.fields.use_ssl', default: false },
      { key: 'username', type: 'text', labelKey: 'download.config.download_clients.fields.username' },
      { key: 'password', type: 'password', labelKey: 'download.config.download_clients.fields.password', secret: true },
      { key: 'category', type: 'text', labelKey: 'download.config.download_clients.fields.category', default: 'fliks' },
      { key: 'movieCategory', type: 'text', labelKey: 'download.config.download_clients.fields.movie_category' },
      { key: 'seriesCategory', type: 'text', labelKey: 'download.config.download_clients.fields.series_category' },
    ],
  },
];

async function handleIndexerImplementations(): Promise<PluginHttpResponse> {
  return jsonResponse(200, INDEXER_IMPLEMENTATIONS);
}

async function handleDownloadClientImplementations(): Promise<PluginHttpResponse> {
  return jsonResponse(200, DOWNLOAD_CLIENT_IMPLEMENTATIONS);
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
 * Every route this plugin actually backs with a handler. `GET /delay-profiles` is not
 * declared in the manifest at all — `delay-profiles` stays core's table, no page here
 * needs it — so it 404s like any other unrecognised path.
 *
 * `/indexers/cooldowns`, `/indexers/implementations`, `/download-clients/implementations`
 * and `/blocklist/all` are declared ahead of their `:id` siblings: `createRouteTable`
 * resolves first-match-wins, so the literal segment must come first (see
 * `test/http-routes.test.ts`'s ordering assertions).
 */
function canonicalRoutes(deps: RouteDeps): { method: string; path: string; handler: RouteHandler }[] {
  const releases: RouteHandler = (req, params) => handleSearchReleases(deps, params, req);
  const grab: RouteHandler = (req, params) => handleGrab(deps, params, req);
  return [
    { method: 'GET', path: '/:id/releases', handler: releases },
    { method: 'POST', path: '/:id/grab', handler: grab },
    { method: 'GET', path: '/:id/seasons/:seasonId/releases', handler: releases },
    { method: 'POST', path: '/:id/seasons/:seasonId/grab', handler: grab },
    { method: 'GET', path: '/:id/episodes/:episodeId/releases', handler: releases },
    { method: 'POST', path: '/:id/episodes/:episodeId/grab', handler: grab },
    { method: 'GET', path: '/queue', handler: (req) => handleQueue(deps, req) },
    { method: 'GET', path: '/history', handler: (req) => handleHistory(deps, req) },
    { method: 'GET', path: '/indexers', handler: () => handleListIndexers(deps) },
    { method: 'POST', path: '/indexers', handler: (req) => handleCreateIndexer(deps, req) },
    { method: 'POST', path: '/indexers/test-connection', handler: (req) => handleTestIndexerConnection(deps, req) },
    { method: 'DELETE', path: '/indexers/cooldowns', handler: () => handleClearAllIndexerCooldowns(deps) },
    { method: 'GET', path: '/indexers/implementations', handler: () => handleIndexerImplementations() },
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
    { method: 'GET', path: '/download-clients/implementations', handler: () => handleDownloadClientImplementations() },
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
  return canonicalRoutes(deps).map((r) => ({
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
 *  `ROUTES` array rather than a hand-copied list. `canonicalRoutes` itself
 *  (not just `createRouteTable`'s resolution) is exposed so a parity test can diff its
 *  method+path keys against `ROUTES` directly, in both directions. */
export { ROUTES, canonicalRoutes };
