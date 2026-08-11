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
} as const;

function subjectFor(name: string): string {
  return `plugin:${PLUGIN_ID}:${name}`;
}

export const POLICY = {
  releasesRead: `read:${subjectFor(PERMISSIONS.releases)}`,
  releasesGrab: `grab:${subjectFor(PERMISSIONS.releases)}`,
  indexersRead: `read:${subjectFor(PERMISSIONS.indexers)}`,
  downloadClientsRead: `read:${subjectFor(PERMISSIONS.downloadClients)}`,
  delayProfilesRead: `read:${subjectFor(PERMISSIONS.delayProfiles)}`,
  queueRead: `read:${subjectFor(PERMISSIONS.queue)}`,
} as const;

/**
 * The 8 `Action.Grab`-era routes core keeps as declared aliases for one
 * major version (`media.controller.ts:198-302`), mirrored exactly —
 * `:id`/`:seasonId`/`:episodeId` match that controller's own param names —
 * plus one read-only listing route per admin resource this plugin owns.
 * Mutating routes for indexers/download-clients/delay-profiles are left
 * out: their wire shape belongs to the "providers" view kind, which has no
 * renderer yet (see the README), and guessing it now risks building it
 * twice once that PR lands.
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
  { method: 'GET', path: '/indexers', policy: POLICY.indexersRead },
  { method: 'GET', path: '/download-clients', policy: POLICY.downloadClientsRead },
  { method: 'GET', path: '/delay-profiles', policy: POLICY.delayProfilesRead },
  { method: 'GET', path: '/queue', policy: POLICY.queueRead },
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
 * and `media.season.actions` have no consumer yet. Even so, the *destination*
 * of this nav entry (the `table` view kind for `/plugins/fliks.download/queue`)
 * has no renderer either (`plugin-view.ts` resolves every view kind to
 * "unavailable" until a later PR) — see the README for what that leaves unshippable.
 */
export const UI_CONTRIBUTIONS = [
  {
    id: 'fliks-download.nav.queue',
    slot: 'nav.acquisition' as const,
    weight: 100,
    labelKey: 'download.nav.queue',
    icon: 'download',
    action: { kind: 'route' as const, path: '/plugins/fliks.download/queue' },
  },
];

/**
 * One real, plugin-owned setting (`requests_auto_grab_on_approval`, per the
 * plan's "Gets split" table) — not the indexers/download-clients/delay-profiles
 * admin surfaces, which are collections, not a config form, and belong to the
 * (also unshipped) "providers" view kind instead.
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
    ],
  },
];

export const I18N = {
  en: {
    'download.nav.queue': 'Queue',
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
