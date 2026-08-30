/**
 * Static manifest fields. `version` (from this repo's package.json) and
 * `files` (sha256 of the built bundle + logo) are filled in by
 * `scripts/build.ts` — this template is not the manifest itself.
 *
 * `fliks` covers the whole 3.x line, cut off before an unknown-shape 4.0 — the upper bound
 * is mandatory, both here and in the catalog's CI. Plugins are a 3.0 feature; the 2.x range
 * this carried before only ever served development. `test/manifest.test.ts` re-checks the
 * range against a sibling checkout's real version when one is present.
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
  /** Separate from `queue`: reading what is downloading and reaching into the download client
   *  to stop or delete it are different powers, and core grants `Manage` on any plugin
   *  permission a user holds — so sharing one name would hand control to every queue viewer. */
  queueControl: 'queue-control',
  blocklist: 'blocklist',
} as const;

function subjectFor(name: string): string {
  return `plugin:${PLUGIN_ID}:${name}`;
}

/** Hides every control from a viewer who could not use it anyway — the routes themselves are
 *  CASL-guarded, so this is presentation, not the boundary. */
const WHEN_QUEUE_CONTROL = [`hasPermission:${subjectFor(PERMISSIONS.queueControl)}`];

/** Shared by both tables. Every value is already on the row, so this needs no route — and a row
 *  that carries none of a field simply omits the line, which is what lets one declaration serve a
 *  running queue row and a finished history one. */
const DETAIL_ACTION = {
  kind: 'detail' as const,
  labelKey: 'download.config.queue.actions.info',
  titleKey: 'download.config.queue.detail_title',
  fields: [
    { key: 'sourceTitle', labelKey: 'download.config.queue.detail.release' },
    { key: 'quality', labelKey: 'download.config.history.columns.quality' },
    { key: 'size', labelKey: 'download.config.queue.columns.size', format: 'bytes' as const },
    { key: 'source', labelKey: 'download.config.queue.detail.indexer' },
    {
      key: 'grabSource',
      labelKey: 'download.config.queue.detail.grab_source',
      labelKeys: {
        auto: 'download.config.history.grab_source.auto',
        manual: 'download.config.history.grab_source.manual',
      },
    },
    { key: 'date', labelKey: 'download.config.history.columns.date', format: 'date' as const },
    {
      kind: 'link' as const,
      key: 'infoUrl',
      labelKey: 'download.config.queue.detail.indexer_page',
      textKey: 'download.config.queue.detail.indexer_page_open',
    },
  ],
};

/** Shared by both tables: the same three controls, gated on the row's live state. `importing`
 *  appears in none of them — its files are already being moved. */
const QUEUE_CONTROL_ACTIONS = (stateKey: 'state') => [
  {
    kind: 'proxy' as const,
    labelKey: 'download.config.queue.actions.pause',
    method: 'POST' as const,
    path: '/queue/:id/pause',
    when: WHEN_QUEUE_CONTROL,
    visibleWhen: { key: stateKey, in: ['queued', 'active', 'stalled'] },
  },
  {
    kind: 'proxy' as const,
    labelKey: 'download.config.queue.actions.resume',
    method: 'POST' as const,
    path: '/queue/:id/resume',
    when: WHEN_QUEUE_CONTROL,
    visibleWhen: { key: stateKey, in: ['paused'] },
  },
  {
    kind: 'proxy' as const,
    labelKey: 'download.config.queue.actions.remove',
    method: 'DELETE' as const,
    path: '/queue/:id',
    confirmKey: 'download.config.queue.actions.remove_confirm',
    confirmToggle: { labelKey: 'download.config.queue.actions.remove_delete_files', param: 'deleteFiles' },
    tone: 'danger' as const,
    when: WHEN_QUEUE_CONTROL,
    visibleWhen: { key: stateKey, in: ['queued', 'active', 'stalled', 'paused'] },
  },
];

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
  queueControl: `manage:${subjectFor(PERMISSIONS.queueControl)}`,
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
  { method: 'GET', path: '/history', policy: POLICY.queueRead },
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
  { method: 'POST', path: '/queue/:id/pause', policy: POLICY.queueControl },
  { method: 'POST', path: '/queue/:id/resume', policy: POLICY.queueControl },
  { method: 'DELETE', path: '/queue/:id', policy: POLICY.queueControl },
  { method: 'DELETE', path: '/history/all', policy: POLICY.queueControl },
  { method: 'DELETE', path: '/history/:id', policy: POLICY.queueControl },
  { method: 'GET', path: '/blocklist', policy: POLICY.blocklistRead },
  { method: 'DELETE', path: '/blocklist/all', policy: POLICY.blocklistManage },
  { method: 'DELETE', path: '/blocklist/:id', policy: POLICY.blocklistManage },
];

/** `POST /api/media/:id/grab` (and the 7 siblings) forwarded to the paths above, one major version. */
/** Fills core's release picker: core prefixes each with the proxy path and substitutes the ids. */
export const RELEASE_PICKER = {
  movie: { search: '/:id/releases', grab: '/:id/grab' },
  season: { search: '/:id/seasons/:seasonId/releases', grab: '/:id/seasons/:seasonId/grab' },
  episode: { search: '/:id/episodes/:episodeId/releases', grab: '/:id/episodes/:episodeId/grab' },
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
  {
    id: 'fliks-download.settings.history',
    slot: 'settings.page',
    weight: 130,
    labelKey: 'download.config.history.title',
    icon: 'history',
    action: { kind: 'route' as const, path: settingsPagePath('history') },
  },
  {
    // Core owns the release picker and declares these two action ids; this plugin only
    // contributes the entries that open it, so nothing about grabbing shows without it.
    //
    // One submenu rather than two rows at the top level: the media menu groups its
    // actions now, and acquisition is this plugin's group to fill. The gate stays on
    // the parent — an empty group is dropped by core, so repeating it per child would
    // only make the two disagree later.
    id: 'fliks-download.media.group',
    slot: 'media.actions',
    weight: 1000,
    labelKey: 'download.media.group',
    icon: 'download',
    when: ['hasPermission:media.grab', '!mediaType:series', 'hasQualityProfile'],
    action: { kind: 'submenu' as const },
    children: [
      {
        id: 'fliks-download.media.grab-best',
        slot: 'media.actions',
        weight: 10,
        labelKey: 'download.media.grab_best',
        icon: 'download',
        action: { kind: 'action' as const, actionId: 'media.grab-best' },
      },
      {
        id: 'fliks-download.media.search-releases',
        slot: 'media.actions',
        weight: 20,
        labelKey: 'download.media.search_releases',
        icon: 'search',
        action: { kind: 'action' as const, actionId: 'media.search-releases' },
      },
    ],
  },
  {
    id: 'fliks-download.season.search-releases',
    slot: 'media.season.actions',
    weight: 500,
    labelKey: 'download.season.search_releases',
    icon: 'package',
    when: ['hasPermission:media.grab', 'hasQualityProfile'],
    action: { kind: 'action' as const, actionId: 'season.search-releases' },
  },
  {
    id: 'fliks-download.season.grab-best',
    slot: 'media.season.actions',
    weight: 600,
    labelKey: 'download.season.grab_best',
    icon: 'download',
    when: ['hasPermission:media.grab', 'hasQualityProfile'],
    action: { kind: 'action' as const, actionId: 'season.grab-best' },
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
    subtitleKey: 'download.config.general.subtitle',
    icon: 'download',
    fields: [
      {
        key: 'requestsAutoGrabOnApproval',
        type: 'toggle' as const,
        labelKey: 'download.config.general.auto_grab_on_approval',
        hint: 'download.config.general.auto_grab_on_approval_hint',
        default: true,
      },
      {
        key: 'search_budget_seconds',
        type: 'number' as const,
        labelKey: 'download.config.general.search_budget_seconds',
        hint: 'download.config.general.search_budget_seconds_hint',
        default: 30,
        min: 5,
        max: 120,
      },
      // No default: an unset sample count means no cleanup, and this path deletes
      // torrents along with their files.
      // Bounded, unlike before: the two multiply into the detection window, and an unbounded pair
      // could ask for one longer than the retention that feeds it.
      {
        key: 'stall_samples',
        type: 'number' as const,
        labelKey: 'download.config.stall.samples',
        hint: 'download.config.stall.samples_hint',
        min: 2,
        max: 100,
      },
      {
        key: 'stall_interval_minutes',
        type: 'number' as const,
        labelKey: 'download.config.stall.interval_minutes',
        hint: 'download.config.stall.interval_minutes_hint',
        default: 60,
        min: 5,
        max: 1440,
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
    subtitleKey: 'download.config.indexers.subtitle',
    icon: 'search',
    list: '/indexers',
    implementations: '/indexers/implementations',
    testConnection: { route: '/indexers/test-connection' },
    showPriority: true,
    defaultPriority: 25,
    labels: {
      newKey: 'download.config.indexers.labels.new',
      emptyKey: 'download.config.indexers.labels.empty',
      testKey: 'download.config.indexers.labels.test',
      deleteConfirmKey: 'download.config.indexers.labels.delete_confirm',
      createTitleKey: 'download.config.indexers.labels.create_title',
      editTitleKey: 'download.config.indexers.labels.edit_title',
    },
    actions: [
      {
        id: 'stats',
        labelKey: 'download.config.indexers.actions.stats',
        method: 'GET' as const,
        route: '/indexers/:id/stats',
        scope: 'row' as const,
        // Columns of `dailyStats` — a `GET` without them renders no button at all.
        result: {
          kind: 'table' as const,
          emptyKey: 'download.config.indexers.stats.empty',
          columns: [
            { key: 'date', labelKey: 'download.config.indexers.stats.date' },
            { key: 'queries', labelKey: 'download.config.indexers.stats.queries' },
            { key: 'avgResponseMs', labelKey: 'download.config.indexers.stats.avg_response' },
            { key: 'totalResults', labelKey: 'download.config.indexers.stats.results' },
            { key: 'errors', labelKey: 'download.config.indexers.stats.errors' },
          ],
        },
      },
      {
        id: 'clear-cooldown',
        labelKey: 'download.config.indexers.actions.clear_cooldown',
        method: 'DELETE' as const,
        route: '/indexers/:id/cooldown',
        scope: 'row' as const,
        // Renders beside the cooldown it clears rather than as a fourth button per row.
        slot: 'cooldown-reset' as const,
        confirmKey: 'download.config.indexers.actions.clear_cooldown_confirm',
      },
      {
        id: 'clear-all-cooldowns',
        labelKey: 'download.config.indexers.actions.clear_all_cooldowns',
        method: 'DELETE' as const,
        route: '/indexers/cooldowns',
        scope: 'list' as const,
      },
    ],
  },
  {
    id: 'download-clients',
    kind: 'providers' as const,
    labelKey: 'download.config.download_clients.title',
    subtitleKey: 'download.config.download_clients.subtitle',
    icon: 'server',
    list: '/download-clients',
    implementations: '/download-clients/implementations',
    testConnection: { route: '/download-clients/test-connection' },
    // Unlike the old core page (`showPriority: false`), priority genuinely gates
    // behaviour here — `pickClient` grabs to the first enabled client in priority order.
    showPriority: true,
    defaultPriority: 1,
    labels: {
      newKey: 'download.config.download_clients.labels.new',
      emptyKey: 'download.config.download_clients.labels.empty',
      testKey: 'download.config.download_clients.labels.test',
      deleteConfirmKey: 'download.config.download_clients.labels.delete_confirm',
      createTitleKey: 'download.config.download_clients.labels.create_title',
      editTitleKey: 'download.config.download_clients.labels.edit_title',
    },
  },
  {
    id: 'queue',
    kind: 'table' as const,
    labelKey: 'download.config.queue.title',
    subtitleKey: 'download.config.queue.subtitle',
    icon: 'download',
    list: '/queue',
    paged: true,
    pageSize: 25,
    columns: [
      {
        key: 'title',
        labelKey: 'download.config.queue.columns.title',
        // The media, not the release name: the queue is read to see which film is downloading,
        // and the title is what you click to reach it. Everything else about the row, the
        // release name included, is one button away in the detail dialog.
        linkActionId: 'table.open-media' as const,
        // Which tracker the release came from, badged under the name rather than costing a column.
        subValues: [{ key: 'source', badges: { '*': 'neutral' as const } }],
      },
      {
        key: 'state',
        labelKey: 'download.config.queue.columns.state',
        // `handleQueue` answers one of five closed values; without these the cell printed the
        // raw enum, in English, whatever the UI language.
        labelKeys: {
          queued: 'download.config.queue.states.queued',
          active: 'download.config.queue.states.active',
          stalled: 'download.config.queue.states.stalled',
          paused: 'download.config.queue.states.paused',
          importing: 'download.status.importing',
        },
        badges: {
          queued: 'neutral' as const,
          active: 'info' as const,
          stalled: 'warning' as const,
          paused: 'ghost' as const,
          importing: 'primary' as const,
        },
        // The percentage fills this badge instead of holding a column of its own: it says what
        // the state beside it is doing, and a column of bare numbers read as unrelated to it.
        progressField: 'progress',
      },
      { key: 'size', labelKey: 'download.config.queue.columns.size', format: 'bytes' as const },
      { key: 'bytesPerSecond', labelKey: 'download.config.queue.columns.speed', format: 'speed' as const },
    ],
    // Rows enter and leave on `queue.updated`; the percentages and speeds between two such
    // events answer to nothing, so those are the only reason this page polls at all.
    refreshOn: ['queue.updated'],
    refreshMs: 10_000,
    // Reads mediaId/mediaType straight off each row — core's own resolver renders no
    // button when either is null, so an unresolved row is simply inert, not broken.
    rowActions: [DETAIL_ACTION, ...QUEUE_CONTROL_ACTIONS('state')],
  },
  {
    // The queue holds what is in flight; a row that completes or fails leaves it immediately.
    // Without this page a failed grab is readable only in the logs.
    id: 'history',
    kind: 'table' as const,
    labelKey: 'download.config.history.title',
    subtitleKey: 'download.config.history.subtitle',
    icon: 'history',
    list: '/history',
    paged: true,
    pageSize: 25,
    filters: [
      { kind: 'search' as const, key: 'q', placeholderKey: 'download.config.history.filters.search_placeholder' },
      {
        kind: 'select' as const,
        key: 'status',
        labelKey: 'download.config.history.filters.status_label',
        options: [
          { value: '', labelKey: 'download.config.history.filters.status_all' },
          { value: 'grabbed', labelKey: 'download.config.history.filters.status_grabbed' },
          { value: 'importing', labelKey: 'download.status.importing' },
          { value: 'completed', labelKey: 'download.config.history.filters.status_completed' },
          { value: 'failed', labelKey: 'download.config.history.filters.status_failed' },
          { value: 'warning', labelKey: 'download.config.history.filters.status_warning' },
        ],
      },
    ],
    columns: [
      { key: 'date', labelKey: 'download.config.history.columns.date', format: 'date' as const },
      {
        key: 'title',
        labelKey: 'download.config.history.columns.title',
        // Same as the queue: the media, and the title is the way to it.
        linkActionId: 'table.open-media' as const,
        // Quality and tracker belong with the release's name; as columns of their own they
        // spent the width the title needed. Every quality value is worth badging: `*`.
        subValues: [
          { key: 'quality', badges: { '*': 'ghost' as const } },
          { key: 'source', badges: { '*': 'neutral' as const } },
          { key: 'size', format: 'bytes' as const, badges: { '*': 'ghost' as const } },
        ],
      },
      { key: 'grabSource', labelKey: 'download.config.history.columns.grab_source', nowrap: true },
      {
        key: 'status',
        labelKey: 'download.config.history.columns.status',
        labelKeys: {
          grabbed: 'download.config.history.filters.status_grabbed',
          importing: 'download.status.importing',
          completed: 'download.config.history.filters.status_completed',
          failed: 'download.config.history.filters.status_failed',
          warning: 'download.config.history.filters.status_warning',
        },
        badges: {
          grabbed: 'info' as const,
          importing: 'primary' as const,
          completed: 'success' as const,
          failed: 'error' as const,
          warning: 'warning' as const,
        },
        // The reason a grab failed reads in a dialog; as a column it stretched every row.
        detailField: 'statusMessage',
        detailTitleKey: 'download.config.history.detail_title',
        // A row still running carries its live percentage; a terminal one reports none and
        // the badge stays flat.
        progressField: 'progress',
      },
    ],
    // The same controls as the queue, gated on the live `state` this view now resolves too —
    // a row read here is often the one an operator wants to stop, and sending them to another
    // page to do it is the kind of gap that makes a feature go unused.
    rowActions: [
      DETAIL_ACTION,
      ...QUEUE_CONTROL_ACTIONS('state'),
      {
        kind: 'proxy' as const,
        labelKey: 'download.config.history.actions.delete',
        method: 'DELETE' as const,
        path: '/history/:id',
        confirmKey: 'download.config.history.actions.delete_confirm',
        tone: 'danger' as const,
        when: WHEN_QUEUE_CONTROL,
      },
    ],
    listActions: [
      {
        labelKey: 'download.config.history.actions.clear',
        method: 'DELETE' as const,
        path: '/history/all',
        confirmKey: 'download.config.history.actions.clear_confirm',
      },
    ],
  },
];

export const I18N = {
  en: {
    'download.config.general.subtitle': 'Grab and import behaviour.',
    'download.config.indexers.subtitle': 'Torznab trackers queried when searching for a release.',
    'download.config.download_clients.subtitle': 'Clients a grabbed release is sent to.',
    'download.config.queue.subtitle': 'Downloads in progress, across every client.',
    'download.config.history.subtitle': 'Recorded grabs and their outcome.',
    'download.config.queue.states.queued': 'Queued',
    'download.config.queue.states.active': 'Downloading',
    'download.config.queue.states.stalled': 'Stalled',
    'download.config.queue.states.paused': 'Paused',
    'download.status.importing': 'Importing',
    'download.config.history.title': 'Download history',
    'download.config.history.detail_title': 'Reason',
    'download.config.history.columns.date': 'Date',
    'download.config.history.columns.title': 'Release',
    'download.config.history.columns.grab_source': 'Grabbed',
    'download.config.history.columns.status': 'Status',
    'download.config.history.filters.search_placeholder': 'Search releases',
    'download.config.history.filters.status_label': 'Status',
    'download.config.history.filters.status_all': 'All statuses',
    'download.config.history.filters.status_grabbed': 'Grabbed',
    'download.config.history.filters.status_completed': 'Completed',
    'download.config.history.filters.status_failed': 'Failed',
    'download.config.history.filters.status_warning': 'Warning',
    'download.config.indexers.fields.max_retention_days': 'Maximum seeding days',
    'download.config.indexers.fields.max_retention_days_hint':
      'Remove a finished torrent this many days after it completed, even if the share ratio is not reached. Leave empty to wait for the ratio alone.',
    'download.config.indexers.labels.create_title': 'New indexer',
    'download.config.indexers.labels.edit_title': 'Edit indexer',
    'download.config.download_clients.labels.create_title': 'New download client',
    'download.config.download_clients.labels.edit_title': 'Edit download client',
    'download.season.search_releases': 'View packs',
    'download.season.grab_best': 'Download the season',
    'download.media.group': 'Downloads',
    'download.media.grab_best': 'Grab the best release',
    'download.media.search_releases': 'Search releases',
    'download.config.general.search_budget_seconds': 'Seconds allowed for a release search',
    'download.config.general.search_budget_seconds_hint':
      'Indexers slower than this are dropped from the round and the results already returned are kept. Raise it for slow trackers.',
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
      'Search again for downloads you started yourself too',
    'download.config.stall.include_manual_grabs_hint':
      'A stalled download is removed either way \u2014 this only decides whether a replacement is searched for.',
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
    'download.queue.removed_by_user': 'Removed from the queue by an operator',
    'download.queue.errors.not_controllable': 'This download can no longer be controlled',
    'download.queue.errors.no_torrent': 'No download client holds this release yet',
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
    'download.config.indexers.stats.date': 'Date',
    'download.config.indexers.stats.queries': 'Queries',
    'download.config.indexers.stats.avg_response': 'Avg response (ms)',
    'download.config.indexers.stats.results': 'Results',
    'download.config.indexers.stats.errors': 'Errors',
    'download.config.indexers.stats.empty': 'No query recorded in the last 30 days.',
    'download.config.indexers.actions.clear_cooldown': 'Clear cooldown',
    'download.config.indexers.actions.clear_cooldown_confirm':
      'Query this indexer again right away? Its backoff is there because it failed or asked to be left alone.',
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
    'download.config.queue.actions.info': 'Info',
    'download.config.queue.detail_title': 'Download details',
    'download.config.queue.detail.release': 'Release',
    'download.config.queue.detail.indexer': 'Indexer',
    'download.config.queue.detail.indexer_page': 'Torrent page',
    'download.config.queue.detail.indexer_page_open': 'Open on the indexer',
    'download.config.queue.detail.grab_source': 'Grab method',
    'download.config.history.columns.quality': 'Quality',
    'download.config.history.grab_source.auto': 'Automatic',
    'download.config.history.grab_source.manual': 'Manual',
    'download.config.queue.actions.pause': 'Pause',
    'download.config.queue.actions.resume': 'Resume',
    'download.config.queue.actions.remove': 'Remove',
    'download.config.queue.actions.remove_confirm':
      'Remove this download from its client? It will stop and leave the queue.',
    'download.config.queue.actions.remove_delete_files': 'Also delete the downloaded files',
    'download.config.history.actions.delete': 'Delete',
    'download.config.history.actions.delete_confirm': 'Delete this history entry?',
    'download.config.history.actions.clear': 'Clear history',
    'download.config.history.actions.clear_confirm':
      'Delete every finished, failed and warned entry? Downloads still running are kept.',
    'download.config.queue.columns.speed': 'Speed',
    'download.config.queue.columns.size': 'Size',
  },
  // Vocabulary matches Fliks' own fr.json for the same ideas (priorité, tester la connexion,
  // clé API, client de téléchargement, profil de qualité) rather than inventing new terms.
  fr: {
    'download.config.general.subtitle': 'Comportement de récupération et d\'import.',
    'download.config.indexers.subtitle': 'Trackers Torznab interrogés lors d\'une recherche de release.',
    'download.config.download_clients.subtitle': 'Clients auxquels une release récupérée est transmise.',
    'download.config.queue.subtitle': 'Téléchargements en cours, tous clients confondus.',
    'download.config.history.subtitle': 'Récupérations enregistrées et leur résultat.',
    'download.config.queue.states.queued': 'En file d\'attente',
    'download.config.queue.states.active': 'Téléchargement',
    'download.config.queue.states.stalled': 'Bloqué',
    'download.config.queue.states.paused': 'En pause',
    'download.status.importing': 'Import en cours',
    'download.config.history.title': 'Historique des téléchargements',
    'download.config.history.detail_title': 'Raison',
    'download.config.history.columns.date': 'Date',
    'download.config.history.columns.title': 'Release',
    'download.config.history.columns.grab_source': 'Récupéré',
    'download.config.history.columns.status': 'Statut',
    'download.config.history.filters.search_placeholder': 'Rechercher des releases',
    'download.config.history.filters.status_label': 'Statut',
    'download.config.history.filters.status_all': 'Tous les statuts',
    'download.config.history.filters.status_grabbed': 'Récupéré',
    'download.config.history.filters.status_completed': 'Terminé',
    'download.config.history.filters.status_failed': 'Échoué',
    'download.config.history.filters.status_warning': 'Avertissement',
    'download.config.indexers.fields.max_retention_days': 'Jours de partage maximum',
    'download.config.indexers.fields.max_retention_days_hint':
      "Supprime un torrent terminé ce nombre de jours après sa fin, même si le ratio de partage n'est pas atteint. Laisser vide pour n'attendre que le ratio.",
    'download.config.indexers.labels.create_title': 'Nouvel indexeur',
    'download.config.indexers.labels.edit_title': "Modifier l'indexeur",
    'download.config.download_clients.labels.create_title': 'Nouveau client de téléchargement',
    'download.config.download_clients.labels.edit_title': 'Modifier le client de téléchargement',
    'download.season.search_releases': 'Voir les packs',
    'download.season.grab_best': 'Télécharger la saison',
    'download.media.group': 'Téléchargements',
    'download.media.grab_best': 'Récupérer la meilleure release',
    'download.media.search_releases': 'Rechercher des releases',
    'download.config.general.search_budget_seconds': 'Secondes accordées à une recherche de release',
    'download.config.general.search_budget_seconds_hint':
      'Les indexeurs plus lents sont écartés du tour et les résultats déjà reçus sont conservés. À augmenter pour des trackers lents.',
    'download.config.stall.samples': 'Vérifications avant nettoyage d’un téléchargement bloqué',
    'download.config.stall.samples_hint':
      'Laissez vide pour ne jamais nettoyer les téléchargements bloqués. Supprimer un torrent efface aussi ses fichiers.',
    'download.config.stall.interval_minutes': 'Minutes entre deux vérifications',
    'download.config.stall.interval_minutes_hint':
      'Délai d’attente avant de vérifier à nouveau la progression d’un téléchargement.',
    'download.config.stall.auto_restart': 'Relancer une recherche après nettoyage',
    'download.config.stall.auto_restart_hint':
      'Cherche une autre release une fois le téléchargement bloqué supprimé.',
    'download.config.stall.include_manual_grabs':
      'Relancer aussi une recherche pour les téléchargements lancés manuellement',
    'download.config.stall.include_manual_grabs_hint':
      'Un téléchargement bloqué est supprimé dans tous les cas \u2014 ceci décide seulement si une autre release est cherchée.',
    'download.config.general.title': 'Général',
    'download.config.general.auto_grab_on_approval': 'Télécharger automatiquement après l’approbation d’une demande',
    'download.config.general.auto_grab_on_approval_hint':
      'Lance une recherche automatiquement quand un administrateur approuve une demande.',
    'download.jobs.search_missing': 'Recherche des médias manquants',
    'download.jobs.rss_sync': 'Synchronisation RSS',
    'download.jobs.import_completed': 'Import des téléchargements terminés',
    'download.jobs.clean_stalled': 'Nettoyage des torrents bloqués',
    'download.jobs.clean_seeded': 'Nettoyage des torrents seedés',
    'download.indexers.test.ok': 'Capacités lues, connexion OK',
    'download.indexers.test.base_url_missing': 'L’URL de base est vide',
    'download.indexers.test.http_error':
      'L’indexeur a répondu avec une erreur HTTP',
    'download.indexers.test.torznab_error': 'L’indexeur a signalé une erreur',
    'download.indexers.test.unexpected_response':
      'Réponse inattendue — pas un document de capacités Torznab',
    'download.indexers.test.network_error': 'Impossible de contacter l’indexeur',
    'download.indexers.test.unknown_implementation':
      'Ce type d’indexeur n’est pas pris en charge',
    'download.download_clients.test.ok': 'Connexion réussie',
    'download.download_clients.test.host_missing': 'L’hôte est obligatoire',
    'download.download_clients.test.auth_failed':
      'Authentification échouée — vérifiez les identifiants',
    'download.download_clients.test.network_error':
      'Impossible de contacter le client de téléchargement',
    'download.download_clients.test.unsupported_implementation':
      'Ce type de client de téléchargement n’est pas pris en charge',
    'download.download_clients.block.reason': 'Bloqué depuis la file d’activité',
    'download.grab.errors.media_not_found': 'Aucun média trouvé pour cette demande',
    'download.grab.errors.no_download_client': 'Aucun client de téléchargement actif n’est configuré',
    'download.grab.errors.unprofiled': 'Ce titre n’a pas de profil de qualité — rien à télécharger',
    'download.grab.errors.blocklisted': 'Cette release est sur liste de blocage',
    'download.queue.removed_by_user': "Retiré de la file d'attente par un opérateur",
    'download.queue.errors.not_controllable': 'Ce téléchargement ne peut plus être piloté',
    'download.queue.errors.no_torrent': 'Aucun client de téléchargement ne détient encore cette release',
    'download.grab.errors.quality_not_allowed': 'La qualité de cette release n’est pas autorisée par le profil',
    'download.grab.errors.no_eligible_release': 'Aucune release éligible n’a été trouvée',
    'download.http.errors.not_found': 'Introuvable',
    'download.http.errors.not_ready': 'Le plugin est encore en cours de démarrage',
    'download.http.errors.bad_param': 'Paramètre d’URL invalide ou manquant',
    'download.http.errors.bad_body': 'Champ invalide ou manquant dans le corps de la requête',
    'download.http.errors.internal': 'Une erreur est survenue lors du traitement de cette requête',
    'download.config.indexers.title': 'Indexeurs',
    'download.config.indexers.implementations.torznab': 'Torznab',
    'download.config.indexers.fields.base_url': 'URL de base',
    'download.config.indexers.fields.api_key': 'Clé API',
    'download.config.indexers.fields.request_delay': 'Délai entre requêtes (secondes)',
    'download.config.indexers.fields.request_delay_hint':
      'Délai minimum entre deux requêtes de recherche envoyées à cet indexeur.',
    'download.config.indexers.fields.enable_search': 'Activer dans la recherche',
    'download.config.indexers.fields.min_seeders': 'Nombre minimum de seeders',
    'download.config.indexers.fields.seed_ratio': 'Ratio de partage cible',
    'download.config.indexers.fields.seed_ratio_hint':
      'Un téléchargement terminé est retiré du client une fois ce ratio atteint.',
    'download.config.indexers.fields.unknown_language': 'Code de langue par défaut',
    'download.config.indexers.fields.unknown_language_hint':
      'Code ISO 639-1 à utiliser quand une release ne précise pas sa langue.',
    'download.config.indexers.labels.new': 'Nouvel indexeur',
    'download.config.indexers.labels.empty': 'Aucun indexeur configuré',
    'download.config.indexers.labels.test': 'Tester la connexion',
    'download.config.indexers.labels.delete_confirm': 'Supprimer cet indexeur ?',
    'download.config.indexers.actions.stats': 'Stats',
    'download.config.indexers.stats.date': 'Date',
    'download.config.indexers.stats.queries': 'Requêtes',
    'download.config.indexers.stats.avg_response': 'Réponse moy. (ms)',
    'download.config.indexers.stats.results': 'Résultats',
    'download.config.indexers.stats.errors': 'Erreurs',
    'download.config.indexers.stats.empty': 'Aucune requête enregistrée sur les 30 derniers jours.',
    'download.config.indexers.actions.clear_cooldown': 'Réinitialiser le cooldown',
    'download.config.indexers.actions.clear_cooldown_confirm':
      'Interroger de nouveau cet indexeur immédiatement ? Sa pause existe parce qu’il a échoué ou demandé à être laissé tranquille.',
    'download.config.indexers.actions.clear_all_cooldowns': 'Réinitialiser tous les cooldowns',
    'download.config.download_clients.title': 'Clients de téléchargement',
    'download.config.download_clients.implementations.qbittorrent': 'qBittorrent',
    'download.config.download_clients.fields.host': 'Hôte',
    'download.config.download_clients.fields.port': 'Port',
    'download.config.download_clients.fields.use_ssl': 'Utiliser HTTPS',
    'download.config.download_clients.fields.username': 'Nom d’utilisateur',
    'download.config.download_clients.fields.password': 'Mot de passe',
    'download.config.download_clients.fields.category': 'Catégorie',
    'download.config.download_clients.fields.movie_category': 'Catégorie films',
    'download.config.download_clients.fields.series_category': 'Catégorie séries',
    'download.config.download_clients.labels.new': 'Nouveau client de téléchargement',
    'download.config.download_clients.labels.empty': 'Aucun client de téléchargement configuré',
    'download.config.download_clients.labels.test': 'Tester la connexion',
    'download.config.download_clients.labels.delete_confirm': 'Supprimer ce client de téléchargement ?',
    'download.config.queue.title': 'File d’attente',
    'download.config.queue.columns.title': 'Titre',
    'download.config.queue.columns.state': 'État',
    'download.config.queue.actions.info': 'Info',
    'download.config.queue.detail_title': 'Détails du téléchargement',
    'download.config.queue.detail.release': 'Release',
    'download.config.queue.detail.indexer': 'Indexeur',
    'download.config.queue.detail.indexer_page': 'Page du torrent',
    'download.config.queue.detail.indexer_page_open': "Ouvrir sur l'indexeur",
    'download.config.queue.detail.grab_source': 'Méthode de récupération',
    'download.config.history.columns.quality': 'Qualité',
    'download.config.history.grab_source.auto': 'Automatique',
    'download.config.history.grab_source.manual': 'Manuelle',
    'download.config.queue.actions.pause': 'Mettre en pause',
    'download.config.queue.actions.resume': 'Reprendre',
    'download.config.queue.actions.remove': 'Supprimer',
    'download.config.queue.actions.remove_confirm':
      "Retirer ce téléchargement de son client ? Il s'arrêtera et quittera la file d'attente.",
    'download.config.queue.actions.remove_delete_files': 'Supprimer aussi les fichiers téléchargés',
    'download.config.history.actions.delete': 'Supprimer',
    'download.config.history.actions.delete_confirm': 'Supprimer cette entrée de l’historique ?',
    'download.config.history.actions.clear': 'Vider l’historique',
    'download.config.history.actions.clear_confirm':
      'Supprimer toutes les entrées terminées, échouées et en avertissement ? Les téléchargements en cours sont conservés.',
    'download.config.queue.columns.speed': 'Vitesse',
    'download.config.queue.columns.size': 'Taille',
  },
};

export const MANIFEST_TEMPLATE = {
  id: PLUGIN_ID,
  pluginApi: 0,
  name: 'Download',
  // 3.7.0 is the first core that reads `visibleWhen`, `confirmToggle` and `progressField`, and
  // the first whose data table substitutes `:id` into a proxy row action. An older client ignores
  // all four in silence — which would render every control unconditionally and drop the
  // "delete the files" answer, so the floor is a correctness bound, not a courtesy.
  fliks: '>=3.7.0 <4.0.0',
  author: 'Fliks',
  description: 'Indexer search, download-client management and the acquisition grab pipeline for Fliks.',
  license: 'AGPL-3.0-or-later',
  logo: 'logo.svg',
  kind: 'process' as const,
  runtime: 'node' as const,
  memoryMb: 256,
  database: { schema: true, coreRefs: [...CORE_REFS] as string[] },
  routes: ROUTES,
  scopes: [...SCOPES] as string[],
  ingestRoots: INGEST_ROOTS,
  jobs: JOBS,
  permissions: Object.values(PERMISSIONS) as string[],
  ui: {
    contributions: UI_CONTRIBUTIONS,
    configPages: CONFIG_PAGES,
    releasePicker: RELEASE_PICKER,
  },
  i18n: I18N,
};
