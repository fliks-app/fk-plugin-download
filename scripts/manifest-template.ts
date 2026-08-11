/**
 * Static manifest fields. `version` (from this repo's package.json) and
 * `files` (sha256 of the built bundle + logo) are filled in by
 * `scripts/build.ts` — this template is not the manifest itself.
 *
 * `fliks` was derived by reading `backend/package.json`'s `version` in the
 * Fliks repo at authoring time ("2.0.1") and picking the loosest range with
 * a mandatory upper bound that still covers it: the whole 2.x line, cut off
 * before an unknown-shape 3.0. `test/manifest.test.ts` re-checks this range
 * against a sibling checkout's real version when one is present.
 */
export const PLUGIN_ID = 'fliks.download';

/**
 * Single source of truth for this plugin's own permissions and route
 * policies — not core CASL subjects. A manifest declares raw, unnamespaced
 * names in `permissions[]`; core prepends `plugin:<id>:` itself to get the
 * CASL subject (`PLUGIN_PERMISSION_NAME_PATTERN` / `pluginPermissionSubject`
 * in `backend/src/common/constants/plugin-permissions.ts`), so
 * `routes[].policy` here builds the exact same string core will. Kept
 * behind one constant so reconciling a namespacing change is a one-line
 * edit, not a hunt through routes.
 */
export const PERMISSIONS = {
  releases: 'releases',
  indexers: 'indexers',
  downloadClients: 'download-clients',
  delayProfiles: 'delay-profiles',
  queue: 'queue',
  blocklist: 'blocklist',
} as const;

function subjectFor(name: string): string {
  return `plugin:${PLUGIN_ID}:${name}`;
}

/** `manage` (not `read`) backs every mutating route below — core's own equivalent
 *  controllers gate the same operations with a single `Action.Manage` check too. */
export const POLICY = {
  releasesRead: `read:${subjectFor(PERMISSIONS.releases)}`,
  releasesGrab: `grab:${subjectFor(PERMISSIONS.releases)}`,
  indexersRead: `read:${subjectFor(PERMISSIONS.indexers)}`,
  indexersManage: `manage:${subjectFor(PERMISSIONS.indexers)}`,
  downloadClientsRead: `read:${subjectFor(PERMISSIONS.downloadClients)}`,
  downloadClientsManage: `manage:${subjectFor(PERMISSIONS.downloadClients)}`,
  delayProfilesRead: `read:${subjectFor(PERMISSIONS.delayProfiles)}`,
  queueRead: `read:${subjectFor(PERMISSIONS.queue)}`,
  blocklistRead: `read:${subjectFor(PERMISSIONS.blocklist)}`,
  blocklistManage: `manage:${subjectFor(PERMISSIONS.blocklist)}`,
} as const;

/**
 * The 8 `Action.Grab`-era routes core keeps as declared aliases for one
 * major version (`media.controller.ts:198-302`), mirrored exactly —
 * `:id`/`:seasonId`/`:episodeId` match that controller's own param names —
 * plus the indexers/download-clients/blocklist admin CRUD this plugin backs
 * directly, the queue and each provider's `implementations` route. `GET
 * /delay-profiles` is not declared at all — `delay-profiles` stays core's
 * table, and no page here needs it yet.
 *
 * `/indexers/cooldowns`, `/indexers/implementations`,
 * `/download-clients/implementations` and `/blocklist/all` are declared
 * ahead of their same-length `:id` siblings — this table and the plugin's
 * own matcher (`src/seams/http-routes.ts`) both resolve first-match-wins, so
 * the literal segment must come first or it reads as an id.
 */
export const ROUTES: { method: string; path: string; policy: string; objectGuard?: string }[] = [
  { method: 'GET', path: '/:id/releases', policy: POLICY.releasesRead, objectGuard: 'mediaAccessible:id' },
  { method: 'POST', path: '/:id/grab', policy: POLICY.releasesGrab, objectGuard: 'mediaAccessible:id' },
  { method: 'GET', path: '/:id/upgrade-releases', policy: POLICY.releasesRead, objectGuard: 'mediaAccessible:id' },
  { method: 'POST', path: '/:id/upgrade', policy: POLICY.releasesGrab, objectGuard: 'mediaAccessible:id' },
  {
    method: 'GET',
    path: '/:id/seasons/:seasonId/releases',
    policy: POLICY.releasesRead,
    objectGuard: 'mediaAccessible:id',
  },
  {
    method: 'POST',
    path: '/:id/seasons/:seasonId/grab',
    policy: POLICY.releasesGrab,
    objectGuard: 'mediaAccessible:id',
  },
  {
    method: 'GET',
    path: '/:id/episodes/:episodeId/releases',
    policy: POLICY.releasesRead,
    objectGuard: 'mediaAccessible:id',
  },
  {
    method: 'POST',
    path: '/:id/episodes/:episodeId/grab',
    policy: POLICY.releasesGrab,
    objectGuard: 'mediaAccessible:id',
  },
  { method: 'GET', path: '/queue', policy: POLICY.queueRead },
  { method: 'GET', path: '/indexers', policy: POLICY.indexersRead },
  { method: 'POST', path: '/indexers', policy: POLICY.indexersManage },
  { method: 'POST', path: '/indexers/test-connection', policy: POLICY.indexersManage },
  { method: 'DELETE', path: '/indexers/cooldowns', policy: POLICY.indexersManage },
  { method: 'GET', path: '/indexers/implementations', policy: POLICY.indexersRead },
  { method: 'PUT', path: '/indexers/:id', policy: POLICY.indexersManage },
  { method: 'DELETE', path: '/indexers/:id', policy: POLICY.indexersManage },
  { method: 'DELETE', path: '/indexers/:id/cooldown', policy: POLICY.indexersManage },
  { method: 'GET', path: '/indexers/:id/stats', policy: POLICY.indexersRead },
  { method: 'GET', path: '/download-clients', policy: POLICY.downloadClientsRead },
  { method: 'POST', path: '/download-clients', policy: POLICY.downloadClientsManage },
  { method: 'POST', path: '/download-clients/test-connection', policy: POLICY.downloadClientsManage },
  { method: 'GET', path: '/download-clients/implementations', policy: POLICY.downloadClientsRead },
  { method: 'PUT', path: '/download-clients/:id', policy: POLICY.downloadClientsManage },
  { method: 'DELETE', path: '/download-clients/:id', policy: POLICY.downloadClientsManage },
  { method: 'GET', path: '/blocklist', policy: POLICY.blocklistRead },
  { method: 'DELETE', path: '/blocklist/all', policy: POLICY.blocklistManage },
  { method: 'DELETE', path: '/blocklist/:id', policy: POLICY.blocklistManage },
];

/** `POST /api/media/:id/grab` (and the 7 siblings) forwarded to the paths above, one major version. */
export const LEGACY_PATHS: Record<string, string> = {
  'GET /api/media/:id/releases': 'GET /:id/releases',
  'POST /api/media/:id/grab': 'POST /:id/grab',
  'GET /api/media/:id/upgrade-releases': 'GET /:id/upgrade-releases',
  'POST /api/media/:id/upgrade': 'POST /:id/upgrade',
  'GET /api/media/:id/seasons/:seasonId/releases': 'GET /:id/seasons/:seasonId/releases',
  'POST /api/media/:id/seasons/:seasonId/grab': 'POST /:id/seasons/:seasonId/grab',
  'GET /api/media/:id/episodes/:episodeId/releases': 'GET /:id/episodes/:episodeId/releases',
  'POST /api/media/:id/episodes/:episodeId/grab': 'POST /:id/episodes/:episodeId/grab',
};

/**
 * Mirrors `SchedulerService.SCHEDULERS`'s five acquisition-side entries
 * (`scheduler.service.ts`, `completion.service.ts`) — cron literals copied
 * from the live `CronExpression` enum values those `@Cron` decorators use
 * today, not re-derived. Core refuses a plugin job name colliding with
 * `CORE_SCHEDULER_JOB_NAMES`; these five stop colliding only once core's
 * own Phase 10.3 removes them from `SCHEDULERS`, which is expected
 * sequencing, not a bug in this manifest.
 */
export const JOBS: { name: string; cron: string; triggerable: boolean; labelKey: string }[] = [
  { name: 'SearchMissing', cron: '0 0-23/6 * * *', triggerable: true, labelKey: 'download.jobs.search_missing' },
  { name: 'RssSync', cron: '*/15 * * * *', triggerable: true, labelKey: 'download.jobs.rss_sync' },
  { name: 'ImportCompleted', cron: '*/1 * * * *', triggerable: true, labelKey: 'download.jobs.import_completed' },
  { name: 'CleanStalled', cron: '0 */5 * * * *', triggerable: true, labelKey: 'download.jobs.clean_stalled' },
  { name: 'CleanSeeded', cron: '0 */5 * * * *', triggerable: true, labelKey: 'download.jobs.clean_seeded' },
];

/**
 * The core tables `indexers`, `indexer_stats`, `download_clients`,
 * `download_history`, `stalled_checks` and `delay_profiles` FK into: none
 * (verified from each entity — `indexers`/`download_clients`/`delay_profiles`
 * carry no relation at all; `indexer_stats` only FKs its own `indexers`,
 * which travels with it). `download_history` FKs `media`/`episodes`/`seasons`
 * (`backend/src/modules/media/entities/download-history.entity.ts:24,39,52`).
 * `blocklist` — moving here too; every column is acquisition-domain and its
 * only other core reader is itself leaving — FKs `media`/`users`
 * (`backend/src/modules/blocklist/entities/blocklist-entry.entity.ts:33,43`).
 * Table names taken from each entity's own `@Entity(...)` name, not the
 * class name (`Episode` -> `episodes`, `Season` -> `seasons`, `User` -> `users`).
 */
export const CORE_REFS = ['episodes', 'media', 'seasons', 'users'] as const;

/** One scope per `PluginHostApi` method group (`src/host-methods.ts`) — this plugin is the
 *  only consumer of every group, so it requests all seven. */
export const SCOPES = [
  'media:read',
  'acquisition:candidates',
  'releases:score',
  'requests:progress',
  'ingest:write',
  'events:emit',
  'config:rw',
] as const;

/** Matches the documented `docker-compose.example.yml` convention ("Same path here and in
 *  your download client."); admin-editable after install. */
export const INGEST_ROOTS = ['/downloads'];

/**
 * `nav.acquisition` and `card.actions` are the only slots with a live client
 * renderer today (`nav-contributions.service.ts` + `layout.ts`, and
 * `card-actions.service.ts` respectively) — `settings.page`, `media.actions`
 * and `media.season.actions` have no consumer yet, so the `settings.page`
 * entries below render the section link but not yet its destination page.
 */
/** The settings-page links core puts in this plugin's own admin section — the
 *  section only renders when a plugin contributes at least one page.
 *  `:view` resolves against a `ui.configPages[]` id. */
/** `settings.page` renders inside the admin settings shell — its path must sit under
 *  that shell's own route, or the page opens in the main frame with the wrong sidebar. */
function settingsPagePath(view: string): string {
  return `/admin/settings/plugins/${PLUGIN_ID}/${view}`;
}

export const UI_CONTRIBUTIONS = [
  {
    id: 'fliks-download.settings.general',
    slot: 'settings.page',
    weight: 100,
    labelKey: 'download.config.general.title',
    icon: 'download',
    action: { kind: 'route' as const, path: settingsPagePath('general') },
  },
  {
    id: 'fliks-download.settings.indexers',
    slot: 'settings.page',
    weight: 110,
    labelKey: 'download.config.indexers.title',
    icon: 'search',
    action: { kind: 'route' as const, path: settingsPagePath('indexers') },
  },
  {
    id: 'fliks-download.settings.download-clients',
    slot: 'settings.page',
    weight: 120,
    labelKey: 'download.config.download_clients.title',
    icon: 'server',
    action: { kind: 'route' as const, path: settingsPagePath('download-clients') },
  },
  {
    // Main-navigation page, not a settings one — stays top-level, outside the admin shell.
    id: 'fliks-download.nav.queue',
    slot: 'nav.acquisition',
    weight: 100,
    labelKey: 'download.config.queue.title',
    icon: 'download',
    action: { kind: 'route' as const, path: `/plugins/${PLUGIN_ID}/queue` },
  },
];

/**
 * Four pages: one real, plugin-owned setting (`requests_auto_grab_on_approval`,
 * per the plan's "Gets split" table); the indexers and download-clients admin
 * surfaces, each a `providers` page over this plugin's own CRUD + `implementations`
 * routes; and a read-only `table` page over `GET /queue`. `delay-profiles` has
 * no page — no route backs it yet.
 */
export const CONFIG_PAGES = [
  {
    id: 'general',
    labelKey: 'download.config.general.title',
    icon: 'download',
    fields: [
      {
        key: 'requestsAutoGrabOnApproval',
        type: 'toggle' as const,
        labelKey: 'download.config.general.auto_grab_on_approval',
        hint: 'download.config.general.auto_grab_on_approval_hint',
        default: true,
      },
      // No default: an unset sample count means no cleanup, and this path deletes
      // torrents along with their files.
      {
        key: 'stall_samples',
        type: 'number' as const,
        labelKey: 'download.config.stall.samples',
        hint: 'download.config.stall.samples_hint',
      },
      {
        key: 'stall_interval_minutes',
        type: 'number' as const,
        labelKey: 'download.config.stall.interval_minutes',
        hint: 'download.config.stall.interval_minutes_hint',
        default: 60,
      },
      {
        key: 'stall_auto_restart',
        type: 'toggle' as const,
        labelKey: 'download.config.stall.auto_restart',
        hint: 'download.config.stall.auto_restart_hint',
        default: true,
      },
      {
        key: 'stall_include_manual_grabs',
        type: 'toggle' as const,
        labelKey: 'download.config.stall.include_manual_grabs',
        hint: 'download.config.stall.include_manual_grabs_hint',
        default: false,
      },
    ],
  },
  {
    id: 'indexers',
    kind: 'providers' as const,
    labelKey: 'download.config.indexers.title',
    icon: 'search',
    list: '/indexers',
    implementations: '/indexers/implementations',
    showPriority: true,
    defaultPriority: 25,
    labels: {
      newKey: 'download.config.indexers.labels.new',
      emptyKey: 'download.config.indexers.labels.empty',
      testKey: 'download.config.indexers.labels.test',
      deleteConfirmKey: 'download.config.indexers.labels.delete_confirm',
    },
    // "METHOD path" mirrors this same file's `LEGACY_PATHS` convention — `route` carries
    // no separate method field of its own.
    actions: [
      {
        id: 'stats',
        labelKey: 'download.config.indexers.actions.stats',
        route: 'GET /indexers/:id/stats',
        scope: 'row' as const,
      },
      {
        id: 'clear-cooldown',
        labelKey: 'download.config.indexers.actions.clear_cooldown',
        route: 'DELETE /indexers/:id/cooldown',
        scope: 'row' as const,
      },
      {
        id: 'clear-all-cooldowns',
        labelKey: 'download.config.indexers.actions.clear_all_cooldowns',
        route: 'DELETE /indexers/cooldowns',
        scope: 'list' as const,
      },
    ],
  },
  {
    id: 'download-clients',
    kind: 'providers' as const,
    labelKey: 'download.config.download_clients.title',
    icon: 'server',
    list: '/download-clients',
    implementations: '/download-clients/implementations',
    // Unlike the old core page (`showPriority: false`), priority genuinely gates
    // behaviour here — `pickClient` grabs to the first enabled client in priority order.
    showPriority: true,
    defaultPriority: 1,
    labels: {
      newKey: 'download.config.download_clients.labels.new',
      emptyKey: 'download.config.download_clients.labels.empty',
      testKey: 'download.config.download_clients.labels.test',
      deleteConfirmKey: 'download.config.download_clients.labels.delete_confirm',
    },
  },
  {
    id: 'queue',
    kind: 'table' as const,
    labelKey: 'download.config.queue.title',
    icon: 'download',
    list: '/queue',
    paged: true,
    pageSize: 25,
    columns: [
      { key: 'title', labelKey: 'download.config.queue.columns.title' },
      { key: 'state', labelKey: 'download.config.queue.columns.state' },
      { key: 'progress', labelKey: 'download.config.queue.columns.progress', format: 'percent' as const },
      { key: 'bytesPerSecond', labelKey: 'download.config.queue.columns.speed', format: 'bytes' as const },
    ],
    // Reads mediaId/mediaType straight off each row — core's own resolver renders no
    // button when either is null, so an unresolved row is simply inert, not broken.
    rowActions: [
      { kind: 'action' as const, labelKey: 'download.config.queue.actions.open_media', actionId: 'table.open-media' },
    ],
  },
];

export const I18N = {
  en: {
    'download.config.stall.samples': 'Stalled-download checks before cleanup',
    'download.config.stall.samples_hint':
      'Leave empty to never clean up stalled downloads. Removing one deletes the torrent and its files.',
    'download.config.stall.interval_minutes': 'Minutes between checks',
    'download.config.stall.interval_minutes_hint':
      'How long to wait before sampling a download\u2019s progress again.',
    'download.config.stall.auto_restart': 'Search again after cleanup',
    'download.config.stall.auto_restart_hint':
      'Look for another release once a stalled download has been removed.',
    'download.config.stall.include_manual_grabs':
      'Include downloads you started yourself',
    'download.config.stall.include_manual_grabs_hint':
      'By default only downloads the scheduler grabbed are cleaned up.',
    'download.config.general.title': 'General',
    'download.config.general.auto_grab_on_approval': 'Auto-grab on request approval',
    'download.config.general.auto_grab_on_approval_hint':
      'Start a search automatically when an admin approves a request.',
    'download.jobs.search_missing': 'Search missing',
    'download.jobs.rss_sync': 'RSS sync',
    'download.jobs.import_completed': 'Import completed downloads',
    'download.jobs.clean_stalled': 'Clean stalled downloads',
    'download.jobs.clean_seeded': 'Clean seeded downloads',
    // Connection-test outcomes: the key names the reason, `detail` carries the
    // indexer's own text or an HTTP status — the `rejections[].code` split.
    'download.indexers.test.ok': 'Capabilities read, connection OK',
    'download.indexers.test.base_url_missing': 'Base URL is empty',
    'download.indexers.test.http_error':
      'The indexer answered with an HTTP error',
    'download.indexers.test.torznab_error': 'The indexer reported an error',
    'download.indexers.test.unexpected_response':
      'Unexpected response — not a Torznab capabilities document',
    'download.indexers.test.network_error': 'Could not reach the indexer',
    'download.indexers.test.unknown_implementation':
      'This indexer type is not supported',
    'download.download_clients.test.ok': 'Connected successfully',
    'download.download_clients.test.host_missing': 'Host is required',
    'download.download_clients.test.auth_failed':
      'Authentication failed — check the credentials',
    'download.download_clients.test.network_error':
      'Could not reach the download client',
    'download.download_clients.test.unsupported_implementation':
      'This download client type is not supported',
    // Persisted as the value of `blocklist.note` and `statusMessage`, so a row
    // written today still renders in whatever language the reader picked.
    'download.download_clients.block.reason': 'Blocked from the activity queue',
    // Thrown by the grab pipeline (`GrabError.messageKey`), surfaced verbatim as the
    // `error.key` of an HTTP route's error response — see `src/seams/http-routes.ts`.
    'download.grab.errors.media_not_found': 'No media found for this request',
    'download.grab.errors.no_download_client': 'No enabled download client is configured',
    'download.grab.errors.unprofiled': 'This title has no quality profile — nothing to grab',
    'download.grab.errors.blocklisted': 'This release is blocklisted',
    'download.grab.errors.quality_not_allowed': "This release's quality is not allowed by the profile",
    'download.grab.errors.no_eligible_release': 'No eligible release was found',
    // The HTTP route table's own errors — unmatched path/resource, a malformed param or
    // body field, not-yet-ready, unexpected failure.
    'download.http.errors.not_found': 'Not found',
    'download.http.errors.not_ready': 'The plugin is still starting up',
    'download.http.errors.bad_param': 'Invalid or missing path parameter',
    'download.http.errors.bad_body': 'Invalid or missing field in the request body',
    'download.http.errors.internal': 'Something went wrong handling this request',
    'download.config.indexers.title': 'Indexers',
    'download.config.indexers.implementations.torznab': 'Torznab',
    'download.config.indexers.fields.base_url': 'Base URL',
    'download.config.indexers.fields.api_key': 'API key',
    'download.config.indexers.fields.request_delay': 'Request delay (seconds)',
    'download.config.indexers.fields.request_delay_hint':
      'Minimum time between two search requests sent to this indexer.',
    'download.config.indexers.fields.enable_search': 'Enable in search',
    'download.config.indexers.fields.min_seeders': 'Minimum seeders',
    'download.config.indexers.fields.seed_ratio': 'Seed ratio target',
    'download.config.indexers.fields.seed_ratio_hint':
      'A completed download is removed from the client once it reaches this ratio.',
    'download.config.indexers.fields.unknown_language': 'Unknown-language code',
    'download.config.indexers.fields.unknown_language_hint':
      'ISO 639-1 code to assume when a release does not name its language.',
    'download.config.indexers.labels.new': 'New indexer',
    'download.config.indexers.labels.empty': 'No indexers configured',
    'download.config.indexers.labels.test': 'Test connection',
    'download.config.indexers.labels.delete_confirm': 'Delete this indexer?',
    'download.config.indexers.actions.stats': 'Stats',
    'download.config.indexers.actions.clear_cooldown': 'Clear cooldown',
    'download.config.indexers.actions.clear_all_cooldowns': 'Clear all cooldowns',
    'download.config.download_clients.title': 'Download clients',
    'download.config.download_clients.implementations.qbittorrent': 'qBittorrent',
    'download.config.download_clients.fields.host': 'Host',
    'download.config.download_clients.fields.port': 'Port',
    'download.config.download_clients.fields.use_ssl': 'Use HTTPS',
    'download.config.download_clients.fields.username': 'Username',
    'download.config.download_clients.fields.password': 'Password',
    'download.config.download_clients.fields.category': 'Category',
    'download.config.download_clients.fields.movie_category': 'Movie category',
    'download.config.download_clients.fields.series_category': 'Series category',
    'download.config.download_clients.labels.new': 'New download client',
    'download.config.download_clients.labels.empty': 'No download clients configured',
    'download.config.download_clients.labels.test': 'Test connection',
    'download.config.download_clients.labels.delete_confirm': 'Delete this download client?',
    'download.config.queue.title': 'Queue',
    'download.config.queue.columns.title': 'Title',
    'download.config.queue.columns.state': 'State',
    'download.config.queue.columns.progress': 'Progress',
    'download.config.queue.columns.speed': 'Speed',
    'download.config.queue.actions.open_media': 'Open',
  },
};

export const MANIFEST_TEMPLATE = {
  id: PLUGIN_ID,
  pluginApi: 0,
  name: 'Download',
  fliks: '>=2.0.0 <3.0.0',
  author: 'Fliks',
  description: 'Indexer search, download-client management and the acquisition grab pipeline for Fliks.',
  license: 'MIT',
  logo: 'logo.svg',
  kind: 'process' as const,
  runtime: 'node' as const,
  memoryMb: 256,
  database: { schema: true, coreRefs: [...CORE_REFS] as string[] },
  routes: ROUTES,
  legacyPaths: LEGACY_PATHS,
  scopes: [...SCOPES] as string[],
  ingestRoots: INGEST_ROOTS,
  jobs: JOBS,
  permissions: Object.values(PERMISSIONS) as string[],
  ui: {
    contributions: UI_CONTRIBUTIONS,
    configPages: CONFIG_PAGES,
  },
  i18n: I18N,
};
