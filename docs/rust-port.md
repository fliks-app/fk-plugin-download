# Rust port (pluginApi 2): fk-plugin-download

Spec for porting `fliks.download` from Node/TypeScript (pluginApi 1, `runtime: "node"`) to a Rust
WebAssembly component (pluginApi 2, `runtime: "wasm"`, target `wasm32-wasip2`). Phase 2, milestone
S8. Docs only: no code, no build, nothing else in this repository changes with this file.

Sources read in full at `v0.12.1` (`3a57e4c`): everything under `src/`, `migrations/`, `scripts/`,
`test/` names. Tags: `[ts:path:line]` is a line of this repository at that commit, `[new]` a
decision of this port, `[assumed]` a guess to confirm in the S8 spike. The host side is
`server/docs/spec/plugins.md` (merged), cited as `plugins.md rule N` or `plugins.md <section>`.
`fk-plugin-notify` has the sibling spec; it references section 6 (the SDK list) from here.

Contents: 1 inventory, 2 mapping onto the WIT world, 3 state and where it moves, 4 database,
5 crate layout, 6 SDK requirements, 7 test plan, 8 packaging and catalog, 9 deviations,
10 decisions and open questions.

## 0. Findings that shape the port

1. **Migrations are 8, not 7.** `migrations/index.ts:12-21` lists `0001` to `0008`. `plan` §8.3 and
   `plugins.md` spike criterion 5 say 7. The port ships all 8 byte-for-byte (same names, same SQL)
   so the `_migrations` ledger of an installed plugin adopts without re-running anything.
2. **No transaction spans two `db` calls.** `plugins.md` rule 35: one statement per call, the
   connection is `DISCARD ALL`-ed when it returns to the pool. A `SELECT ... FOR UPDATE` in one
   call and an `UPDATE` in the next holds no lock. Every read-modify-write below is therefore one
   statement (CTE with `FOR UPDATE`, or `INSERT ... ON CONFLICT DO UPDATE ... WHERE`).
3. **Deadlines are traps.** A call past its deadline drops the instance and counts toward the
   breaker (6 in 10 minutes, `plugins.md` rule 42, C105). Node plugins could run long; here every
   long loop needs an in-guest time budget and, for the `scheduled` lane (5 min [assumed]), a
   resume key. Section 3.3.
4. **`scheduled` deadline is shorter than `library.ingest`.** Host deadline for ingest is 30 min,
   `scheduled` 5 min. `ImportCompleted` therefore stays a declared job (60 min, `job` lane); it is
   not turned into a `schedule-call` poller. Plan §8.3 item 2 wording ("the completion poller
   re-arms from `start` with `schedule-call`") is read as: the boot re-arm (`init`) moves to
   `start`, plus a lease so a trapped job instance cannot strand rows. Decided (section 10, D1).
5. **`fliks.download` newly asks for `network: {internal: true}`** (qBittorrent and Torznab on the
   LAN were reachable by any process plugin before). `plugins.md` rule 4: an upgrade that newly
   requests it is skipped by catalog auto-update and needs the admin's confirm. Decided (D3): on an
   upgrade from a pluginApi 1 package with the same id and the same signing key the host carries the
   grant forward (specified in `plugins.md`, not here), so auto-update installs this version; any
   permission requested later still fails closed.

## 1. Inventory of behaviour

### 1.1 Manifest today [ts:scripts/manifest-template.ts:1216-1246]

| Field | Value now | Value in the port |
|---|---|---|
| `id` | `fliks.download` | same |
| `pluginApi` | `1` | `2` |
| `fliks` | `>=4.0.0 <5.0.0` | `>=5.0.0 <6.0.0` |
| `runtime` / `kind` | `node` / `process` | `wasm` / `process` |
| `memoryMb` | `256` | `128` [assumed, measure in the spike; applies per instance, up to 13 instances] |
| `database` | `{schema: true, coreRefs: [episodes, media, seasons, users]}` | same |
| `scopes` | all 7 [ts:scripts/manifest-template.ts:252-260] | 6: `requests:progress` dropped, never called (DL9) |
| `ingestRoots` | `['/downloads']` [ts:scripts/manifest-template.ts:264] | same |
| `network` | absent | `{internal: true}` (DL8) |
| `permissions` | `releases indexers download-clients queue queue-control blocklist` [ts:scripts/manifest-template.ts:21-33] | same |
| `jobs` | 5, section 1.3 | same, same crons |
| `ui`, `i18n` (en, fr) | 64 KB of JSON | copied verbatim, section 1.7 |
| `files` | `plugin.js`, `logo.svg` hashes | `plugin.wasm`, `logo.svg` hashes |

The manifest stops being generated from TypeScript. It becomes a checked-in JSON template
(`plugin.template.json`, section 5) holding every key except `version` and `files`, which the build
adds. A test diffs the template against the published `0.12.1` `plugin.json` in the catalog (every
key outside `pluginApi`, `fliks`, `runtime`, `memoryMb`, `scopes`, `network`, `version`, `files`
must be equal).

### 1.2 Routes (39), proxied through `ALL /api/plugins/fliks.download/*`

Policies are unchanged (`<action>:plugin:fliks.download:<permission>`). Handlers live in
`src/seams/http-routes.ts`; the table is `canonicalRoutes` [ts:src/seams/http-routes.ts:1222] and must
equal `ROUTES` of the manifest in both directions (a test pins this today; keep it).

| Routes | Permission | Handler [ts:src/seams/http-routes.ts] | Notes |
|---|---|---|---|
| `GET /:id/releases`, `GET /:id/seasons/:seasonId/releases`, `GET /:id/episodes/:episodeId/releases` | `read` releases, object guard `mediaAccessible:id` | `handleSearchReleases` :306 | `q` custom query, `sid` search-stream id (only for `delegated` principal); body is a bare array of `toWireRelease` rows |
| `POST /:id/grab`, `POST /:id/seasons/:seasonId/grab`, `POST /:id/episodes/:episodeId/grab` | `grab` releases, object guard | `handleGrab` :356 | body `downloadUrl, sourceTitle, sourceId, infoUrl, force`; `infoUrl` kept only if absolute http(s) :333 |
| `GET /queue`, `GET /history` | `read` queue | `handleQueue` :993, `handleHistory` :933 | `page`, `pageSize` clamped 1..100 :53; `history` also `q`, `status`; `media.resolve` batched to this page's ids :734 |
| `GET /indexers`, `POST /indexers`, `PUT /indexers/:id`, `DELETE /indexers/:id`, `POST /indexers/test-connection`, `GET /indexers/implementations`, `GET /indexers/:id/stats` | `read`/`manage` indexers | :371 :379 :386 :394 :401 :1150 :409 | create answers 201, `useFor` projected onto three boolean columns :173 |
| `DELETE /indexers/cooldowns`, `DELETE /indexers/:id/cooldown` | `manage` indexers | :423 :417 | literal route declared before `:id` siblings |
| `GET/POST /indexer-sources`, `PUT/DELETE /indexer-sources/:id`, `POST /indexer-sources/test-connection`, `GET /indexer-sources/implementations`, `POST /indexer-sources/:id/import` | `read`/`manage` indexers | :427 :431 :437 :447 :454 :1154 :462 | Prowlarr and Jackett |
| `GET/POST /download-clients`, `PUT/DELETE /download-clients/:id`, `POST /download-clients/test-connection`, `GET /download-clients/implementations` | `read`/`manage` download-clients | :375 :468 :474 :484 :491 :1158 | qBittorrent only |
| `POST /queue/:id/pause`, `POST /queue/:id/resume`, `DELETE /queue/:id`, `POST /queue/:id/retry-import` | `manage` queue-control | :574 :598 :618 | pause/resume wait up to 4 s for the client to settle :570 |
| `DELETE /history/all`, `DELETE /history/:id` | `manage` queue-control | :661 :644 | `:id` refused (409) while a client still holds the torrent |
| `GET /blocklist`, `DELETE /blocklist/all`, `DELETE /blocklist/:id` | `read`/`manage` blocklist | :497 :504 :509 | |

Response contract (frozen by `test/http-routes.test.ts`, 100 tests): error bodies are
`{error: {key, detail?}}` with i18n keys; `wrap` maps `GrabError` to 404/409, not-found errors to
404, unknown implementation to 400 `bad_body`, source errors to 400 `{key, detail}`, download
client errors to 502 `download.http.errors.download_client`, anything else to 500
[ts:src/seams/http-routes.ts:1164-1215]. Not ready 503 and unresolved route 404 come from the
dispatcher [ts:src/plugin.ts:102-112]. The port keeps every status, key and field name.
C106 check: no route is literally `/logo`, `/export`, `/import`, `/enable`, `/disable`, `/restart`
or `/events/test`, so none is refused at registration.

The plugin matches paths itself (core forwards the raw sub-path): `matchOne` splits on the raw `/`
before percent-decoding each segment, first match wins, case-sensitive
[ts:src/seams/http-routes.ts:1305-1330]. See DL7.

### 1.3 Jobs (5) [ts:scripts/manifest-template.ts:227-233, ts:src/seams/jobs.ts:25-43]

| Job | Cron (server zone) | Body | Triggerable |
|---|---|---|---|
| `SearchMissing` | `0 0-23/6 * * *` | `searchMissing(args.mediaIds?)` [ts:src/grab/scheduler.ts:39-68] | yes |
| `RssSync` | `*/15 * * * *` | `rssSync()` [ts:src/grab/scheduler.ts:102-145] | yes |
| `ImportCompleted` | `*/1 * * * *` | `poll()` [ts:src/grab/completion-poller.ts:159-230] | yes |
| `CleanStalled` | `0 */5 * * * *` (6 fields) | `cleanStalled()` [ts:src/grab/completion-poller.ts:625-690] | yes |
| `CleanSeeded` | `0 */5 * * * *` (6 fields) | `cleanSeeded()` [ts:src/grab/completion-poller.ts:734-775] | yes |

Each job gets its own instance (`job` lane, 60 min deadline, no-overlap guard by the host).

### 1.4 Events consumed

Core forwards every domain event as a note; the plugin acts on one:
`media.acquisition.requested` with `{mediaIds: number[]}` [ts:src/grab/on-acquisition-requested.ts:10-62].
It dedupes ids with an in-memory in-flight set, checks setting `requestsAutoGrabOnApproval`
(unset reads as on), then runs `searchMissing(ids)` detached.

### 1.5 Config keys (`plugin.fliks.download.<key>`, read with `config.get`, no env)

| Key | Parse | Used by |
|---|---|---|
| `auto_acquisition_paused` | only the string `'true'` pauses [ts:src/grab/scheduler.ts:16-23] | `SearchMissing`, `RssSync`, re-read per page |
| `requestsAutoGrabOnApproval` | only `'false'` disables [ts:src/grab/on-acquisition-requested.ts:12-15] | event handler |
| `search_budget_seconds` | int, clamped 5..120, default 30 [ts:src/search-budget.ts:9-45] | every search |
| `stall_samples` | int >= 2 else cleanup off [ts:src/grab/stall-config.ts:28-52] | `CleanStalled` |
| `stall_interval_minutes` | int > 0, default 60 | same |
| `stall_min_speed_kib` | float > 0, default 8 | same |
| `stall_auto_restart` | `!== 'false'` | same |
| `stall_include_manual_grabs` | `=== 'true'` | same |

All are form fields of the `general` config page. Nothing is read at `hello`; the plugin ignores
`config-changed` (every read is per use).

### 1.6 Database (schema `plugin_fliks_download`, role of the same name)

Tables after migrations `0001`-`0008` [ts:migrations/]: `indexers`, `download_clients`,
`indexer_stats` (FK `indexers` cascade), `download_history` (FKs `public.media` cascade,
`public.episodes`/`seasons` set null, `indexers`/`download_clients` set null, 5 coverage columns,
`size`, `infoUrl`), `blocklist` (unique index on `lower("sourceTitle")`, FKs `public.media`/`users`
set null), `stalled_checks`, `indexer_sources`. Ledger table `_migrations("name","appliedAt")`.
Section 4 for the new migrations.

Column types in use, relevant to the host `db` driver (`plugins.md` rule 35): `int4`, `int8`
(`size`, `downloadedBytes`; node-pg parser returned a JS number [ts:src/db/pool.ts:20-30]),
`varchar`/`text`, `bool`, `jsonb` (`settings`), `timestamptz`. Results cast to text or int in
SQL (`COUNT(*)::text`, `AVG(...)::int`, `DATE(...)::text`). No array or numeric result column.
Parameters used: text, int, bool, float, null, json, text-list (`ANY($1::text[])`), int-list
(`ANY($1::int[])`).

### 1.7 UI (data in the manifest, served by the host)

- Contributions: `settings.page` x5 (general, indexers, indexer-sources, download-clients,
  history), `nav.acquisition` x1 (queue), `media.actions` group with `grab-best` and
  `search-releases`, `media.season.actions` x2 [ts:scripts/manifest-template.ts:282-396].
- Config pages: `general` (form, 8 fields, section 1.5), `indexers`, `indexer-sources`,
  `download-clients` (`providers`, list route + `implementations` route, per-row actions),
  `queue`, `history` (`table`, paged, row actions `proxy` to the queue routes)
  [ts:scripts/manifest-template.ts:397-767].
- `releasePicker`: movie, season, episode, each `{search, grab}` [ts:scripts/manifest-template.ts:212-217].
- `i18n`: `en` and `fr`, every key under `download.`.
- The three `implementations` routes return static field definitions
  [ts:src/seams/http-routes.ts:1049-1160]; they are plugin code, not manifest data, and port as
  `const` tables.

### 1.8 Health, shutdown, logging

`health` answers `{ok: true, detail: 'core=connected'}` [ts:src/plugin.ts:89-91]. `shutdown` replies
then exits. Logging goes to stdout/stderr, one line per call, DSN credentials redacted
[ts:src/log.ts:1-19].

### 1.9 Outbound calls

- Host calls (all through `PluginHostApi`): `media.acquisitionContext` (1 site), `acquisition.candidates`
  (4), `releases.match` (1), `releases.score` (2), `media.resolve` (2), `library.ingest` (1),
  `events.publish` (7), `notifications.dispatch` (1), `events.emitOwn` (1, search stream),
  `progress.set` (1), `config.get` (4). Never called: `requests.markInProgress`, `counts.set`,
  `media.exists`, `config.set`.
- Network, all through `wasi:http` in the port: Torznab (`t=caps`, `t=search|tvsearch|movie`, RSS)
  with 10 s caps probe, 60 s RSS, `0.83 x budget` search [ts:src/indexers/torznab.ts:116-492];
  indexer download URLs and their redirect chain by hand (5 hops, magnet `Location`)
  [ts:src/download-clients/qbittorrent-driver.ts:142-165]; qBittorrent Web API v2 (login cookie,
  `torrents/info|files|add|delete|stop|start|pause|resume`) [ts:src/download-clients/qbittorrent-driver.ts:61-426];
  Prowlarr `GET /api/v1/indexer`, Jackett `GET /api/v2.0/indexers?configured=true` with a hand-walked
  cookie jar over redirects [ts:src/indexer-sources/drivers.ts:42-95, 139-213].
- No inbound network, no filesystem, no environment (the plugin used `FLIKS_*` env for sockets and
  the DSN only).

### 1.10 Code that is not ported (unreachable from any route, job or event)

`DownloadClientsService.blockTorrent` and `onMediaBlocklisted` [ts:src/download-clients/service.ts:149-177,
ts:src/composition-root.ts:120-122], `annotateStalledStrikes` :208, `getTorrents`, `StalledChecksRepository.findRecentForHashes`,
`DownloadHistoryRepository.countActive`, `findRecentGrabbedForMedia`, `findBySourceTitleForMedia`,
`findLatestBySourceTitle`, `findAll`, `reimport`, `IndexersRepository.listEnabledForRss`,
`countEnabled` (both repositories), `DownloadGrabPipeline.searchAndGrab`, `migrateDown` and
`migrate-cli.ts`. The port writes none of them (`grep` at the pinned commit finds no caller). If a
reviewer wants one back, it comes back with its route.

## 2. Mapping onto the WIT world `fliks:plugin@2.0.0`

| Export | Download behaviour |
|---|---|
| `hello(core-version, config)` | SDK answers `manifest-check {id, version, plugin-api}`. Nothing else: no database access (Node waited for migrations before replying [ts:src/plugin.ts:80-84]). |
| `start()` (once per plugin start, on the `core` instance, 15 min) | 1. `db.migrate` with the 11 migrations of section 4. 2. Re-arm: the lease sweep of 3.4 (replaces `completionPoller.init()` [ts:src/plugin.ts:60]; unconditional would re-arm a row whose ingest core may still be running after a restart). 3. `poller_state['progressResync'] = true` (replaces `firstProgressTick`). Errors fail `start`, which the host treats as a crash, except a database outage (`db` `unavailable`), which leaves the plugin `degraded` and re-runs `start` (host C109). |
| `health()` | `SELECT 1`; `ok:false` with the error text if it fails. Two misses degrade the plugin (proxy 503) [plugins.md rule 42]. DL17. |
| `job(name, job-id, args)` | `SearchMissing`, `RssSync`, `ImportCompleted`, `CleanStalled`, `CleanSeeded`; any other name is `Err("no handler registered for job ...")` [ts:src/plugin.ts:93-100]. Budgets in 3.3. |
| `scheduled(key, payload, attempt)` | Dispatch on the key prefix: `search:<mediaId>`, `caps:<indexerId>`, `grab-started:<historyId>`. Unknown prefix: warn and `Ok` (drops a call written by a later version). Handlers are idempotent and accept unknown payload fields (calls survive upgrades, rule 55). |
| `http(request)` | The 39-route router (SDK `Router`), `principal` threaded into search streaming. |
| `event(name, payload)` | `media.acquisition.requested` only: `config.get(requestsAutoGrabOnApproval)`, then `schedule-call("search:<id>", 0, {})` per distinct integer id. Everything else is ignored silently. Events arriving before `ready` wait in the host ring (DL16). |
| `config-changed(keys)` | log at info, nothing else. |
| `shutdown()` | nothing to flush; all state is in the database. |

Lanes (`plugins.md` rule 40): `core` x1; `event` x1 (a few DB-free host calls per event); `http`
0 to 4 (releases search holds one for up to 150 s); `task` 0 to 2 (`caps:`, `grab-started:`,
`search:`); `job` one per declared job = 5. Worst case 13 instances.

The five jobs, the HTTP routes and the task calls run in different instances, so any two of them
can touch the same row at the same time. Every cross-call invariant is in Postgres (section 3).

## 3. In-memory state and where it moves

### 3.1 Inventory

| State | Where today | Kind | Destination |
|---|---|---|---|
| Per-indexer serial chain (`chains`) | `indexers/throttle.ts:23` | correctness | `indexer_throttle."busyUntil"` lease, 3.2 |
| Minimum interval (`nextAllowedAt`) | `throttle.ts:26,45-64` | correctness | `indexer_throttle."nextAllowedAt"` |
| Failure ladder (`failureCount`) | `throttle.ts:28,80-92` | correctness | `indexer_throttle."failureCount"` |
| Cooldown window and reason (`cooldownUntil`) | `throttle.ts:32,137-144` | correctness | `indexer_throttle."cooldown*"` columns |
| `inFlight` media set | `grab/on-acquisition-requested.ts:29` | correctness (dedupe) | scheduled call key `search:<mediaId>`; a second event replaces the pending call |
| `reportedMediaIds`, `firstProgressTick` | `grab/completion-poller.ts:90-95` | correctness | `poller_state` rows `reportedMediaIds`, `progressResync` |
| Stranded `importing` rows | `completionPoller.init()` `plugin.ts:60` | correctness | `start` re-arm plus `"importLeaseUntil"` sweep, 3.4 |
| Search budget (`budgetMs`) | `search-budget.ts:19` | derived | re-read from `config.get` at the top of each search and passed down as a value; no global |
| `scopeCache` (history id to season/episode numbers) | `completion-poller.ts:87,379-403` | derived | dropped: `media.resolve` per call over the in-flight rows only, batched as today (50 season ids plus 50 episode ids per call) |
| `unidentifiedHashes`, `untrackedStallHashes`, `stallSkipReason` | `completion-poller.ts:84,98,100` | cosmetic (log dedupe) | stay in the `job` instance; a re-created instance logs the line again |
| `normalisedTitles` WeakMap | `grab/torrent-name-matcher.ts:82` | perf | local memo per call |
| `seasonsGrabbedAsPack` | `grab/scheduler.ts:53` | per call | local; across a resumed slice the pending-grab check (coverage columns) makes it redundant |
| Caps mutated on the row object after a probe | `torznab.ts:165-170,292` | per call | local mutable row inside one call |
| Search streamer (`entries`, `ranking`, `again`) | `grab/search-stream.ts:49-51` | per call | local to one `http` call |
| `repositories`, `appGraph`, `onAcquisitionRequested`, `host` singletons | `plugin.ts:21-33` | wiring | per-instance context built at first use, immutable |
| `HostClient.pending`, `nextId` | `host-client.ts:50-52` | transport | gone (host imports are synchronous) |

No instance holds anything a later call needs.

### 3.2 `indexers/throttle.ts` into the plugin schema

Node semantics to keep [ts:src/indexers/throttle.ts:7-19, 36-179]:
one request in flight per indexer; the wait before a request is `min(nextAllowedAt - now, requestDelay)`
(a long penalty window is the caller's to respect through `filterReadyIndexers`, never slept out);
after every request, success or throw, `nextAllowedAt = end + requestDelay` (a plain assignment that
overwrites an earlier bump); failures escalate 30 s, 2 min, 15 min, 1 h, 6 h, at most one step per
elapsed window and none while a window is open; a 429/503 `Retry-After` (seconds or HTTP date) opens
a `rate-limit` window and, being open, suppresses failure escalation; success resets the ladder and
the window; `clearCooldown` also clears `nextAllowedAt`; the cooldown bump (`bumpCooldown`) is
monotonic on both `cooldownUntil` and `nextAllowedAt`. Order matters and is kept: the post-request
assignment runs inside `run`, and `setRetryAfter`/`notifyFailure` run after it, outside the slot
[ts:src/indexers/torznab.ts:131-143, 262-266]. "Success" is the transport: a 200 carrying a Torznab
`<error>` resets the ladder, then `notifyFailure` opens step 1 again (kept as is).

Table (migration `0009`):

```sql
CREATE TABLE IF NOT EXISTS "indexer_throttle" (
  "indexerId"            integer PRIMARY KEY REFERENCES "indexers"("id") ON DELETE CASCADE,
  "busyToken"            text,
  "busyUntil"            timestamptz,
  "nextAllowedAt"        timestamptz,
  "failureCount"         integer NOT NULL DEFAULT 0,
  "cooldownUntil"        timestamptz,
  "cooldownReason"       text,
  "cooldownFailureCount" integer,
  "cooldownDetail"       text,
  "updatedAt"            timestamptz NOT NULL DEFAULT now()
);
```

All times are the database clock (`now()`), so instances never compare guest clocks.

Each transition is one statement (finding 2). The claim is the serialisation point:

```sql
-- claim: 0 rows = another instance holds the slot; the caller sleeps ~250 ms and retries
-- $1 indexer id, $2 token (16 random bytes, hex), $3 lease seconds, $4 requestDelay in ms
INSERT INTO "indexer_throttle" ("indexerId", "busyToken", "busyUntil")
VALUES ($1, $2, now() + make_interval(secs => $3))
ON CONFLICT ("indexerId") DO UPDATE
   SET "busyToken" = EXCLUDED."busyToken", "busyUntil" = EXCLUDED."busyUntil", "updatedAt" = now()
 WHERE "indexer_throttle"."busyUntil" IS NULL OR "indexer_throttle"."busyUntil" <= now()
RETURNING GREATEST(0, LEAST($4::bigint, COALESCE(
  (EXTRACT(EPOCH FROM ("indexer_throttle"."nextAllowedAt" - now())) * 1000)::bigint, 0))) AS "waitMs"
```

The lease covers the whole hold: `requestDelay` (the longest `waitMs`) plus the request's own
timeout plus 10 s [assumed margin]. After the claim the guest sleeps `waitMs` (wasi monotonic clock),
sends, then releases, fenced by its token so a holder whose lease ran out cannot free a later
holder's slot:

```sql
-- release; $2 token, $3 requestDelay seconds,
-- $4 outcome: 'resolved', 'threw', 'cancelled' (cut after it was sent) or 'not-started'
UPDATE "indexer_throttle"
   SET "busyToken" = NULL, "busyUntil" = NULL,
       "nextAllowedAt" = CASE WHEN $4::text = 'not-started' THEN "nextAllowedAt"
                              ELSE now() + make_interval(secs => $3) END,
       "failureCount" = CASE WHEN $4::text = 'resolved' THEN 0 ELSE "failureCount" END,
       "cooldownUntil" = CASE WHEN $4::text = 'resolved' THEN NULL ELSE "cooldownUntil" END,
       "cooldownReason" = CASE WHEN $4::text = 'resolved' THEN NULL ELSE "cooldownReason" END,
       "cooldownFailureCount" = CASE WHEN $4::text = 'resolved' THEN NULL ELSE "cooldownFailureCount" END,
       "cooldownDetail" = CASE WHEN $4::text = 'resolved' THEN NULL ELSE "cooldownDetail" END,
       "updatedAt" = now()
 WHERE "indexerId" = $1 AND "busyToken" = $2
```

The claim returns a guard; its `Drop` runs the release with outcome `cancelled`, or `not-started`
when the request was never sent (`db` imports are synchronous, so `Drop` can call them). A request
cancelled by its budget (DL6) therefore frees the slot at once, and one that never started leaves
the spacing as it was; only a trapped instance leaves the slot to the lease.

Failure escalation reads then writes, so it is a CTE with `FOR UPDATE` (same statement):

```sql
-- notifyFailure: no-op while a window is open (0 rows), otherwise one ladder step
WITH cur AS (
  SELECT "failureCount" + 1 AS n FROM "indexer_throttle"
   WHERE "indexerId" = $1 AND ("cooldownUntil" IS NULL OR "cooldownUntil" <= now()) FOR UPDATE),
step AS (
  SELECT n, now() + CASE LEAST(n, 5) WHEN 1 THEN interval '30 seconds'
     WHEN 2 THEN interval '2 minutes' WHEN 3 THEN interval '15 minutes'
     WHEN 4 THEN interval '1 hour' ELSE interval '6 hours' END AS until FROM cur)
UPDATE "indexer_throttle" t SET
  "failureCount" = step.n, "cooldownUntil" = step.until,
  "nextAllowedAt" = GREATEST(COALESCE(t."nextAllowedAt", '-infinity'), step.until),
  "cooldownReason" = 'failures', "cooldownFailureCount" = step.n, "cooldownDetail" = $2, "updatedAt" = now()
FROM step WHERE t."indexerId" = $1
```

A racing second failure blocks on the row lock, re-evaluates the `cur` filter against the committed
row, finds the window open and updates nothing.

`setRetryAfter` is one `UPDATE` with `until = now() + $2 ms`: `nextAllowedAt = GREATEST(nextAllowedAt,
until)` always, and the `cooldown*` columns (`reason 'rate-limit'`, `cooldownFailureCount NULL`,
`detail` the header) only when `until` exceeds the stored `cooldownUntil` (row-level `CASE`, no
read needed). `clearCooldown(id)` must answer the old state, which a plain `UPDATE ... RETURNING`
cannot (it returns the new row), so it is
`WITH old AS (SELECT "indexerId", COALESCE("cooldownUntil" > now(), false) AS had ... FOR UPDATE)
UPDATE ... SET cooldown* = NULL, "failureCount" = 0, "nextAllowedAt" = NULL FROM old ... RETURNING old.had`;
`clearAll` is the same over every row with a cooldown or a non-zero ladder, wrapped in
`SELECT count(*) FILTER (WHERE had)`.

Readers: `filterReadyIndexers` is one `SELECT` of rows with `"cooldownUntil" > now()` (remaining ms
computed in SQL); `GET /indexers` left-joins the table to build the `cooldown` object
(`reason, remainingMs, until, failureCount?, detail?`, the optional keys absent, not null, when the
column is null) [ts:src/indexers/service.ts:111-129].

Waiting for the slot is bounded by the caller's budget: past it the indexer contributes
`{failed: 'timeout'}` to the round, exactly as `runOne` does [ts:src/grab/release-search.ts:49-63];
unlike Node the queued work never starts.

Existing data: none (the throttle was memory only). Migration `0009` backfills one row per existing
indexer with all columns null/0 (`INSERT ... SELECT "id" FROM "indexers" ON CONFLICT DO NOTHING`); an
indexer created later gets its row from its first claim.

### 3.3 Time budgets and resume (deadlines are traps)

Budgets are fractions of the host deadlines (`plugins.md` rule 43); the SDK carries them (SDK-5).

| Entry | Host deadline | Guest budget | On exhaustion |
|---|---|---|---|
| `http` | 180 s | 150 s, passed to every outbound request as `min(own timeout, remaining)` | structured 502/504-style body from the handler, never a trap (C105: a 504 would drop the instance and count toward the breaker) |
| `event` | 60 s | 50 s | n/a (a few host calls) |
| `scheduled` | 5 min [assumed] | 4 min | `search:<id>`: re-schedule the same key with `{resume: {seasonId, episodeId}}`, then `Ok` |
| `job` | 60 min | 50 min | `SearchMissing`: store `poller_state['searchMissingResume']` (last `(mediaId, seasonId, episodeId)` handled; candidates are sorted by exactly that tuple, `plugins.md` rule 31) and stop; the next run starts after it and clears the key when it reaches the end. The resume key belongs to the unscoped sweep only (a `mediaIds` run starts from the top); a season pack is `(mediaId, seasonId, null)` and sorts before its episodes. `ImportCompleted`: start no new import with less than 32 min left before the 60 min host deadline (ingest is up to 30 min); remaining rows wait for the next tick. `RssSync`: stop at the budget; the next tick re-reads the feeds, so nothing is resumed. |

Resuming is safe because auto-grab is idempotent: a target that was grabbed is skipped by the
pending-grab check [ts:src/grab/scheduler.ts:72-85], so replaying a slice only re-searches targets
that found nothing. `RssSync` is not bounded by the indexer count: every matched release runs a
full `searchScored` round [ts:src/grab/scheduler.ts:142], so a large feed can outlast the deadline;
it stops at its budget. `CleanStalled` hands its re-search to `search:<mediaId>` scheduled calls
instead of awaiting `searchMissing` inline [ts:src/grab/completion-poller.ts:686-689]; it and
`CleanSeeded` are then bounded by the client count and need no budget logic.

### 3.4 Import lease

Node re-armed `importing` rows once per process start [ts:src/grab/completion-poller.ts:151-153]. Here a
`job` instance can trap (deadline, out of memory) while the core instance lives, and `start` does not
run again; `poll()` only imports rows in `grabbed|failed|import_failed|warning` [ts:src/grab/completion-poller.ts:174],
so a stranded `importing` row would stay forever. Fix at the source:

- `markImporting(id)` also sets `"importLeaseUntil" = now() + interval '35 minutes'` (ingest 30 min plus margin).
- Top of `poll()` and `start`: `UPDATE download_history SET status='grabbed', "importLeaseUntil"=NULL
  WHERE status='importing' AND ("importLeaseUntil" IS NULL OR "importLeaseUntil" < now())`.
- `library.ingest` keeps its idempotency key `download-history:<id>`
  [ts:src/grab/completion-poller.ts:555], so a re-armed row that core already ingested lands in
  `alreadyPresent` and completes.
- `HostCallError.outcome === 'unknown'` maps to host error code `ERR_TIMEOUT` (core never confirmed);
  `'rejected'` to every other code [ts:src/grab/completion-poller.ts:215-221]. The 31 min client-side
  timeout constant [ts:src/grab/completion-poller.ts:29] goes away; the host call deadline is 30 min.

### 3.5 Work that was fire-and-forget

A guest cannot run after its call returns. Each detached promise has a durable or inline form:

| Today | Port |
|---|---|
| `void refreshCaps(saved)` after indexer create/update [ts:src/indexers/service.ts:102,170] | `schedule-call("caps:<id>", 0, {})`, handled on the `task` lane; the handler re-reads the row (Node used the in-hand copy). The import-from-source loop schedules one key per created indexer. |
| `void deps.host.call('events.publish', grabbed)` [ts:src/grab/grab-executor.ts:99-108] | awaited inline (a few ms), failure logged |
| `void deps.host.call('notifications.dispatch', grab.started)` [ts:src/grab/grab-executor.ts:110-115] | `schedule-call("grab-started:<historyId>", 0, {title, quality, sourceTitle})`; the handler dispatches and returns `Ok` even if dispatch fails (logged), as Node did. Inline would add the sender timeouts (up to 10 s each) to the user's Grab click. |
| `void stats.record(...)` (5 sites, [ts:src/indexers/torznab.ts:243,254,267,336,347]) | awaited inline, one `INSERT` |
| `void markSearchFallback` [ts:src/indexers/torznab.ts:289] | awaited inline |
| `media.acquisition.requested` runs `searchMissing` detached | `search:<mediaId>` scheduled call (3.3 for the time budget) |
| `void emit(...)`, `void rankAndEmit()` of the search streamer [ts:src/grab/search-stream.ts:95,108,111] | spawned on the SDK executor inside the `http` call and joined before the response returns (a trailing `search.partial` is never cut off by the instance going idle) |

## 4. Database changes and migrations

Existing user data is kept as follows: the 8 shipped migrations are carried unchanged as
`migrations/0001_initial_schema.sql` ... `0008_download_history_coverage.sql`, each file the exact
bytes of its `up` string (leading and trailing newlines and indentation included; a golden vector
dumped at `v0.12.1` pins it, section 7), names identical to the ledger entries Node wrote. `db.migrate` skips every recorded name
(`plugins.md` rule 35), so an adopted schema only runs the new ones. Three are added:

| Migration | Content |
|---|---|
| `0009_indexer_throttle` | table of 3.2, backfill `INSERT INTO "indexer_throttle" ("indexerId") SELECT "id" FROM "indexers" ON CONFLICT DO NOTHING` |
| `0010_poller_state` | `CREATE TABLE IF NOT EXISTS "poller_state" ("key" text PRIMARY KEY, "value" jsonb NOT NULL, "updatedAt" timestamptz NOT NULL DEFAULT now())` for `reportedMediaIds`, `progressResync`, `searchMissingResume` |
| `0011_download_history_import_lease` | `ALTER TABLE "download_history" ADD COLUMN IF NOT EXISTS "importLeaseUntil" timestamptz` |

All additive and written to be replay-safe (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`); no existing
row is rewritten.
`down` scripts are dropped (`db.migrate` takes `{name, up}` only) and with them `npm run migrate down`;
rollback is a database restore (DL11).

Requirements on the host `migrate`: it runs each `up` as a multi-statement script (`0001` has 9
statements, `0006` has comments and an `UPDATE`) inside the per-migration transaction (decided, D6;
the host docs are corrected elsewhere to say 8 migrations, then 11).

The `public` references (`media`, `episodes`, `seasons`, `users`) and the `REFERENCES`-only grant are
provisioned by the host from `coreRefs`; `db-cross-schema-fk` and `0001`'s `ON DELETE` actions stay as
they are. Export/import (C103): `fliks.download` is the real FK-order case (`indexers` before
`indexer_stats`, `download_clients` and `indexers` before `download_history`); the new tables add
`indexer_throttle` (child of `indexers`) and two parentless ones.

Plugin removal drops the schema with the role, throttle and state included (`plugins.md` rule 20).

## 5. Crate layout and dependencies

```
fk-plugin-download/
  Cargo.toml              workspace: plugin crate + xtask
  rust-toolchain.toml     stable, target wasm32-wasip2 (pin recorded by the spike)
  plugin.template.json    manifest without version/files
  logo.svg
  migrations/             0001..0011 *.sql, embedded with include_str!
  src/lib.rs              export! and the Guest impl (section 2)
  src/config.rs           keys and parsing of 1.5
  src/db/                 one module per table: rows, indexers, indexer_stats, indexer_sources,
                          download_clients, download_history, blocklist, stalled_checks,
                          throttle, poller_state
  src/http/               router table, handlers by area, dto.rs (camelCase serde), errors.rs
  src/indexers/           torznab.rs, torznab_parse.rs, html_entities.rs, use_for.rs, throttle.rs
  src/sources/            prowlarr.rs, jackett.rs (cookie jar by hand)
  src/clients/            qbittorrent.rs, torrent_hash.rs, stalled.rs, progress_state.rs
  src/grab/               release_search.rs, release_pipeline.rs, scoring.rs, executor.rs,
                          history.rs, scheduler.rs, auto_grab.rs, orphan.rs, matcher.rs, stream.rs
  src/poller/             import.rs, progress.rs, clean_stalled.rs, clean_seeded.rs
  tests/                  vectors/ (golden JSON from the TS code), harness tests
  xtask/                  thin wrapper over the SDK build tooling (SDK-12)
```

All logic is written against the SDK traits (`Db`, `Host`, `Http`, `Clock`), so modules compile and
unit-test natively; only `lib.rs` touches generated bindings.

Dependencies (wasip2-compatible, no threads, no native TLS, no async runtime of their own):

| Crate | Why |
|---|---|
| `fliks-plugin-sdk` (git tag) | everything in section 6 |
| `serde`, `serde_json` | JSON bodies, `settings` jsonb, host payloads |
| `regex` (default features off, `std` + `unicode-case` + `unicode-perl`, size to verify; JS `\d`/`\b` are ASCII, so those spell `(?-u:\d)`/`(?-u:\b)`, and the `torznab-items` vectors pin the result) | the Torznab and caps regexes are ported verbatim; a real XML parser would reject the feeds the regexes tolerate [ts:src/indexers/torznab-parse.ts:88-157] |
| `url` | WHATWG `new URL`, `searchParams.set`, form encoding (identical to `URLSearchParams`) |
| `percent-encoding` | `encodeURIComponent` needs a custom `AsciiSet` (keeps `!'()*`); covered by a vector |
| `sha1` | `.torrent` info-hash [ts:src/download-clients/torrent-hash.ts:66-77] |
| `time` (`parsing`, `formatting`) | RFC 2822 `pubDate`, RFC 3339 columns |
| `thiserror` | error enums mirroring `DownloadClient*Error`, `GrabError`, `SourceUnreachableError` |

Not used: `tokio`, `reqwest`, `hyper`, `tokio-postgres`, `sqlx`, `rustls`/`openssl`/`ring`, `uuid`,
anything that needs `wasi:sockets` or threads. Hand-written: bencode span walk, base32 magnet hash,
multipart body, cookie handling (about 250 lines together). Release profile: `opt-level = "z"`,
`lto = true`, `codegen-units = 1`, `strip = true`, `panic = "abort"`; `wasm-opt -Oz` if available.
Size target for `plugin.wasm`: under 8 MiB [assumed]; the host caps are 32 MiB per entry
(`plugins.md` rule 14) and CI fails the build above 12 MiB.

## 6. What the SDK must provide (shared with `fk-plugin-notify`)

Crate `fliks-plugin-sdk` (`server/crates/plugin-sdk`, git tag), WIT `fliks:plugin@2.0.0`. Column "N"
marks what the notify port also needs (its spec refers to this list).

| # | Guest helper | Detail | N |
|---|---|---|---|
| SDK-1 | `Plugin` trait and `export!` macro | one sync method per guest export with defaults (`health` ok, `start`/`job`/`scheduled`/`event`/`config_changed`/`shutdown` no-op, `job` unknown name `Err`); `hello` implemented by the SDK. The macro embeds `manifest-check` from the plugin's `plugin.template.json` (`id`, `pluginApi`) and `CARGO_PKG_VERSION` (`version`). It cannot embed the final `plugin.json`: that file holds the sha256 of the `.wasm` that would contain it, so the template excludes `files`. A panic hook logs and traps. | yes |
| SDK-2 | Typed `host` imports | all 15 methods plus `schedule-call`/`cancel-call`/`deadline-remaining-ms`; `HostError {code, message}` with an enum for `ERR_NO_METHOD, ERR_TIMEOUT, ERR_NOT_FOUND, ERR_DENIED, ERR_VALIDATION, ERR`, and `is_unknown_outcome()` (= `ERR_TIMEOUT`). WIT types re-exported with serde derives (`wit-bindgen` `additional_derives`), not re-declared; the `wit-sync` test already guards drift. Adapters for the JSON the client expects: `rejections[].params` as an object, `coverage.seasons`/`episodes` as `{from, to}` (WIT: `span {first, last}`), `sourceId`/`sourceName` rename stays plugin code. | partly (config-get) |
| SDK-3 | Scheduled calls | `schedule(key, delay, &T)`, `cancel(key)`, key rules (1-128 chars), payload size check before the call (64 KiB), typed decode tolerant of unknown fields and of an older payload, and a dispatcher keyed by prefix (`"search:" => handler`). | yes |
| SDK-4 | `db` | `Db` trait with the WIT-backed impl; `Param` conversions (`i32`, `i64`, `f64`, `bool`, `&str`, `Option<T>` as null, `Json`, `&[String]`, `&[i64]`, `Vec<u8>`); `Row` with typed getters by column name (`int4/int8` to `i64`, `bool`, `text`, `jsonb` to `serde_json::Value`, `timestamptz` to its RFC 3339 string); `execute` count; `migrate(&[Migration])` with `Migration::new(name, include_str!(...))`; errors keep the host `db-error` code. Doc comment: one statement per call, no transaction across calls. | yes |
| SDK-5 | Async runtime and budgets | single-threaded executor over `wasi:io/poll`: `block_on`, `join_all`, `timeout(dur, fut)`, `sleep(dur)`, dropping a future cancels its pollable (an in-flight request is abandoned, not left running), `spawn_local` for work joined before the export returns (search streamer). `wstd` (Bytecode Alliance) already provides the executor, timers and a `wasi:http` client; build on it before writing one. `Deadline`/`Budget` (`remaining()`, `expired()`, `child(fraction)`), with the per-export defaults of section 3.3 as constants mirrored from `plugins.md` rule 43. Needed for the search fan-out, stream coalescing, throttle waits and the 4 s settle loop. | no (one sync request) |
| SDK-6 | Clock and random | `now_utc()` (wall), `Instant` (monotonic), `today_utc()` (`YYYY-MM-DD`), RFC 3339 with milliseconds, `random_bytes(n)` (multipart boundary, jitter). | yes |
| SDK-7 | HTTP client over `wasi:http` | builder (method, URL, headers, body bytes, `form`, `json`, multipart builder), `RequestOptions` timeouts (connect, first byte, between bytes) plus an overall deadline; no redirect following (3xx returned, `Location` readable); response with status, case-insensitive multi-value headers (`get_all("set-cookie")`), body read with a size cap (default 32 MiB), `text()` (lossy UTF-8), `json()`; sends `Accept-Encoding: identity` and inflates `gzip` if a server answers it anyway (`flate2`, pure Rust backend); error taxonomy from `wasi:http` error codes: `Denied` (the host guard, `HttpRequestDenied`), `Dns`, `Refused`, `Timeout`, `Tls`, `Other(text)`, each with a Node-comparable message because they are stored in `indexer_stats."errorMessage"` and shown to admins. | yes (single POST) |
| SDK-8 | HTTP server side | `Request` (method, raw path, query pairs with first-wins `get`, body bytes, `json::<T>()`, `principal`), `Response::json/empty/with_header`, and a `Router` whose matcher is the same code the host uses for `plugin-route-match` (first match wins, `:name` and `*name`, percent-decode after splitting, optional trailing `/`, case-insensitive). One implementation, host and guests (plan §0 rule 2). | yes |
| SDK-9 | Config | `config::get(key) -> Option<String>`, `get_many`, typed parsers with the exact Node rules (`only "true"`, `only "false"`, clamped int, positive float). | yes |
| SDK-10 | Logging | `info!/warn!/error!/debug!` to the host `log` import, single line, every line scrubbed of `scheme://user:pass@` as `log.ts` does today [ts:src/log.ts:3-5], plus `redact_url(&str)` (drops userinfo and query; DL10). | yes |
| SDK-11 | Testing | native `FakeHost`, `FakeDb`, `FakeHttp`, `FakeClock`; native `PgDb` over a scratch Postgres with the same type decoding as the host driver; component harness that runs the built `.wasm` under the real host code with a controllable clock for scheduled calls, programmable core imports with call recording, outbound allow-list including `network.internal`, direct invocation of every export, and inspection of `plugin_scheduled_calls`; golden-vector loader. | yes |
| SDK-12 | Build tooling (`cargo xtask`-style library or `cargo fliks-plugin`) | release build for `wasm32-wasip2`, optional `wasm-opt`, `plugin.json` from template plus `version` and `files` (sha256 of `plugin.wasm`, logo), deterministic store-only zip honouring the archive guard (<= 4 entries, exact names, no ZIP64, no data descriptor, fixed DOS time), optional dev signature, `verify` that runs the host's own `inspect` and checks the component imports exactly the `plugin` world, size budget. Replaces three hand-copied zip writers today (`scripts/package-archive.ts` here and in notify, `scripts/package-plugin.mjs` in the catalog). | yes |
| SDK-13 | Licence, versioning | SDK crate licensed `MIT OR Apache-2.0` (D5); git tag per WIT minor; toolchain and wasi minor pinned and documented. | yes |

## 7. Test plan

Suites run on `main` CI; local runs go through `fliks-heavy` (two slots), as for every Fliks build.

1. **Golden vectors from the TypeScript code.** A one-off script at `v0.12.1` (kept under
   `tests/vectors/gen/`, run with Node, output committed as JSON) records inputs and outputs of
   the pure functions; Rust tests read them: `torznab-query` (`buildTorznabQuery`, `describeTorznabQuery`),
   `torznab-items` (`parseTorznabItems`, including real feeds with CDATA, entities, `magneturl`),
   `html-entities`, `torrent-hash` (magnet hex/base32, `.torrent` info hash),
   `torrent-name` (`normaliseTorrentName`, `findMatch`), `stall-strikes`, `qbit-base-url`,
   `retry-after`, `throttle-ladder`, `progress-state`, `pick-release`, `coverage-columns`,
   `route-match` (`matchOne` including `%2F` inside a segment), `encode-uri-component`, `manifest-diff`,
   `migrations` (the 8 `up` strings byte for byte, compared with the `.sql` files).
2. **Ported unit tests.** The 490 TS tests map to Rust modules one for one; the large files first:
   `http-routes.test.ts` (100) to `tests/http_routes.rs` with the same status and body assertions;
   `grab-completion-poller` (57), `qbittorrent-driver` (40), `torznab` (25), `download-clients-service`
   (25), `release-pipeline` (22), `torznab-parse` (21), `indexer-service`/`indexer-sources-service` (13
   each), `scheduler` (12), `db` (13) and `db-pending-coverage` (11). Dropped with the protocol:
   `dispatcher`, `protocol`, `host-client`, `harness`, `contract-drift` (replaced by `wit-sync` in the
   SDK), `jobs-table` (replaced by a test that every manifest job name has a match arm).
3. **Database tests against Postgres** (service container as today, with the `public` stub tables):
   migrations on an empty schema; **ledger adoption** (apply `0001`-`0008` and write the ledger the
   way the Node runner did, then `migrate` and assert only `0009`-`0011` ran); backfill of
   `0009`; the existing `ON DELETE` and coverage-dedup tests; the throttle statements under
   contention (two sessions racing the claim, the lease expiring, a stale holder's release
   changing nothing (token), escalation applied once per window, `clearAll` count).
4. **Component tests under the SDK harness** (real host code): `start` runs migrations once and
   re-arms `importing`; every route answers the contract through `http`; a fake qBittorrent and a
   fake Torznab server (port of `test/fake-qbittorrent-server.ts`); two `http` instances searching
   the same indexer at once (stub timestamps prove spacing >= `requestDelay` and one request in
   flight); instance dropped mid-request (lease frees the slot); `ImportCompleted` with an instance
   trap mid-import (lease sweep re-arms, idempotency key lands `alreadyPresent`); `scheduled` slice
   resume (time budget forced short); `search:<id>` key replacement; `caps:<id>` and
   `grab-started:<id>` once each.
5. **Parity names from `plugins.md` this plugin takes part in.** Vector sets: `plugin-manifest` (our
   template re-expressed as a published first-party shape), `plugin-route-match` (the 39 routes,
   `/indexers/cooldowns` before `/:id`), `cron-validate` (five and six field crons above),
   `db-driver` (the value types of 1.6, `int8` as number, `timestamptz` as `...Z` with milliseconds,
   asserted against what the golden `pg` parsers gave). Scenarios: `plugins-import-roundtrip` and
   `plugins-import-fk-order` (C103) use `fliks.download` as the fixture; `plugins-config-owner`
   (F68); `network-not-granted` and the auto-update skip (rule 4). Rust-only: scheduled calls (dedupe
   by key, lease redelivery, resume), `start` once per plugin start, per-job no-overlap, the
   component cache with a real-size component (spike criterion 3: this is the measured stand-in
   for the 20 MiB assumption), `ERR_TIMEOUT` mapping to unknown outcome.
6. **Gates**: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, native tests,
   `cargo build --release --target wasm32-wasip2`, `verify` (world, archive guard, size).

## 8. Packaging and catalog

Archive `fliks.download-<version>.fkplugin`, store method, 4 entries: `plugin.json`,
`plugin.json.sig`, `plugin.wasm`, `logo.svg` (`plugins.md` rules 13-16, caps 32 MiB per entry,
48 MiB total, 33 MiB compressed). `plugin.json` carries `pluginApi: 2`, `runtime: "wasm"`,
`fliks: ">=5.0.0 <6.0.0"`, `network: {internal: true}`, `files: {plugin.wasm, logo.svg}`. The
plugin repository's CI builds the unsigned archive (dev installs with `plugins.allow_unsigned`)
and publishes that verified archive (`cargo xtask package`) on a tag; signing stays in the catalog
workflow with the catalog key, as today [catalog `.github/workflows/package-plugin.yml`].

Catalog repository (`~/Documents/clement/code/fliks-plugin-catalog`), changes to describe, none made here:

1. `COMPATIBILITY.md`: add the row `| \`2\` | \`>=5.0.0 <6.0.0\` | current |`. The file's rule is "a
   new row is added, never an existing one edited", yet the `0` row was edited to `retired` when core
   4.0.0 dropped it; whether row `1` becomes `retired: core 5.0.0 dropped it` is the host release's
   decision. `scripts/ci/check-compatibility-table.mjs` fails any entry whose `pluginApi` has no row.
2. `scripts/package-plugin.mjs`: today a `process` plugin must ship `plugin.js` (lines 164-167, 177). Accept
   `manifest.runtime === 'wasm'` with `plugin.wasm` instead (and refuse the mixes), check the
   component magic (`\0asm`, version `0d 00`, layer `01 00`) and the size caps before signing.
3. `plugins/fliks.download/src/`: replace `plugin.js` with `plugin.wasm`, replace `plugin.json` and
   keep `logo.svg`.
4. New file `plugins/fliks.download/versions/1.0.0.json` (version decided, D7); the other fields are
   copied from `0.12.1.json` because `name`, `description`, `author`, `kind`, `logo` must be identical
   across versions:

   ```json
   {
     "id": "fliks.download", "name": "Download",
     "description": "Indexer search, download-client management and the acquisition grab pipeline for Fliks.",
     "author": "Fliks", "kind": "process", "version": "1.0.0",
     "pluginApi": 2, "fliks": ">=5.0.0 <6.0.0",
     "zipUrl": "https://github.com/fliks-app/fk-plugin-download/releases/download/v1.0.0/fliks.download-1.0.0.fkplugin",
     "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
     "logo": "https://fliks-app.github.io/fliks-plugin-catalog/plugins/fliks.download/logo.svg"
   }
   ```

   The placeholder hash holds the version back until the `Package plugin` workflow records the real
   one [catalog `scripts/build-catalog.mjs:23-27`]. Versions `0.1.4` to `0.12.1` stay untouched
   (published versions are immutable); a Fliks 4 server keeps being offered `0.12.1`, a Fliks 5 server
   only the `pluginApi 2` entries, through the `fliks` range filter.
5. Archive storage (decided, D4): the signed `.fkplugin` is a GitHub Release asset of this repository
   (`v<version>` tag) and `zipUrl` points there; the catalog no longer stores archives. The
   `Package plugin` workflow signs with the catalog key, uploads the asset and records the sha256 in the
   version entry; it stops committing under `dist/`. A GitHub Release download URL answers 302 to
   `objects.githubusercontent.com`, and `plugins.md` rule 28 fetches `zipUrl` with no redirect: the host
   must follow https redirects for this fetch (the signed sha256 stays the gate) before D4 works. `plugins/fliks.download/dist/` and the older
   archives stay as they are, only new versions use releases.
6. Not needed: `schema/plugin.schema.v0.json` and `validate-entry.mjs` accept any integer `pluginApi`.
   Cosmetic: the schema description and the README still say `pluginApi` is currently 0.

Plugin repository after the port: Rust on `main`; the Node code stays reachable at tag `v0.12.1`.
No maintenance branch (D7): Fliks 4 keeps `0.12.x` with no further work. `docs/development.md` and the README
need a rewrite of the build, test and publish sections (not part of this PR).

## 9. Behaviour changes (deviations)

| # | Today | Port | Why |
|---|---|---|---|
| DL1 | detached promises (3.5); `CleanStalled` awaits its re-search inline | inline await, a joined task for the search stream, or a scheduled call for the caps probe, `grab.started` and the `CleanStalled` re-search | a guest cannot outlive its call |
| DL2 | throttle and cooldowns in memory, reset at every restart | in `indexer_throttle`, shared by all instances, survive restarts; a restart no longer clears a 6 h cooldown | state must not live in an instance |
| DL3 | in-flight dedupe of `media.acquisition.requested` by a memory set (ignored while a search runs) | a second event for the same media replaces the pending `search:<id>` call; an event arriving during the search schedules one more pass | durable dedupe by key |
| DL4 | `importing` rows re-armed at process start only, all of them | re-armed when their 35 min lease has expired, by `start` and every `ImportCompleted` tick; after a restart a row whose lease is still running waits for it | a job instance can trap without a restart, and core may still be ingesting |
| DL5 | long jobs run to completion | `SearchMissing`, `ImportCompleted` and `search:<id>` stop at their budget and resume; `RssSync` stops at its budget | deadline is a trap |
| DL6 | an indexer past the search budget keeps running to its own fetch timeout | its request is cancelled; a request still waiting for the throttle slot never starts | futures cancel on drop |
| DL7 | plugin router case-sensitive, no trailing slash, query nested by `qs` | SDK router (case-insensitive, optional trailing `/`, a capture is never empty, as the host); query is a flat ordered list, first value wins | one matcher, host rule 37 |
| DL8 | any address reachable | outbound guard in the host; private ranges only with the granted `network.internal`; link-local, reserved, 6to4, Teredo, documentation ranges always refused (F67); the grant is carried forward on upgrade from the pluginApi 1 package (D3) | sandbox |
| DL9 | scopes: 7 | 6 (`requests:progress` dropped) | never called |
| DL10 | `grab-executor.ts:61` logs the download URL, which carries `apikey=` | URL logged through `redact_url`; the line-level userinfo scrub of `log.ts` stays | secrets out of logs (cf. F66) |
| DL11 | `down` migrations, `npm run migrate`, unreachable code of 1.10 | not shipped | no caller |
| DL12 | `hello` blocks on migrations | migrations in `start`; routes answer 503 until `ready` | host contract |
| DL13 | `.torrent`/Torznab responses decoded by `fetch` | `Accept-Encoding: identity`, gzip inflated if forced | no `fetch` |
| DL14 | `path.join(save_path, name)` with the host OS rules | textual join using the separator of `save_path` (backslash if it has a drive letter or `\`) | wasm std is POSIX [assumed] |
| DL15 | `pubDate` and `Retry-After` dates parsed by `Date.parse` (very lenient) | RFC 2822, RFC 3339 and the obsolete RFC 850 HTTP-date only; anything else is `null`, as an unparseable date is today | no JS engine |
| DL16 | an event received before the database is ready is dropped [ts:src/plugin.ts:122-126] | it waits in the host ring and is handled once the plugin is `ready` | host contract (`plugins.md` rule 46) |
| DL17 | `health` answers ok whenever the core socket is up | `health` runs `SELECT 1`; a database outage degrades the plugin (proxy 503) | health reports what the plugin needs |
| ~~DL18~~ | indexers searched concurrently, partial results streamed as each answers | closed: the same, on the SDK-5 executor | |

## 10. Decisions and remaining questions

Decided by the user after review:

- **D1** `ImportCompleted` stays a cron job with the import lease; its boot re-arm lives in `start`.
- **D2** Long work uses time budgets plus resume keys (3.3). If the spike changes the `scheduled`
  deadline, only the budget constants change.
- **D3** On upgrade from a pluginApi 1 package with the same id and the same signing key, the host
  carries the `network.internal` grant forward. A permission requested later still fails closed.
  Recorded in `plugins.md` by the host work; referenced here only.
- **D4** Signed wasm archives are GitHub Release assets; catalog `zipUrl` points there; the catalog
  repository stops storing `dist/` archives.
- **D5** The SDK crate is `MIT OR Apache-2.0`; this plugin stays AGPL-3.0-or-later.
- **D6** Migration counts in the host docs are corrected elsewhere (8, then 11); the host `migrate`
  runs multi-statement scripts.
- **D7** Both plugins ship as `1.0.0`; no maintenance branch; Fliks 4 keeps download `0.12.x`.
- **D8** (notify only) see its spec.

Still open:

1. **Memory.** `memoryMb: 128` per instance with up to 13 instances is a guess; the spike measures a
   real instance (a 5 MB Torznab response, a 10 MB `.torrent` buffered then multipart-encoded).
2. ~~**Remaining deadline.**~~ Settled by the host spec: a deadline starts at the export call
   (queue wait is bounded separately) and budgets read `deadline-remaining-ms` (`plugins.md` rules 40,
   43).

## 11. As built

What the port did differently from sections 5 and 6, against `fliks-plugin-sdk` at fliks
`0a125c88`:

- Flat modules (`src/{db,routes,grab,poller,torznab,throttle,qbit,sources,indexers,...}.rs`)
  instead of the directory tree of section 5; `xtask` is the SDK build CLI (SDK-12).
- SDK-5 (closed): each sending export sets its `rt::budgets` budget on entry, and every outbound
  request ends with `min(own timeout, export budget)` through `Request::deadline`/`budget`, body
  included. The search fans out to every ready indexer at once inside one `rt::block_on`
  (`FuturesUnordered`, a partial streamed as each answers; DL18 closed); throttle waits are
  `rt::sleep`. The client calls outside the search (qBittorrent, sources, RSS, caps) stay one
  blocking request at a time; the 4 s settle and 3 s hash-recovery loops still `thread::sleep`.
- SDK-10 (closed): logging is the SDK's `info!/warn!/error!` with its scrub, URLs through
  `log::redact_url` (an unparsable URL is logged as given minus its query, not `<unparsable url>`).
- No gzip inflate (DL13): requests send `Accept-Encoding: identity` only; a server that
  compresses anyway is not decoded.
- Tests: golden vectors and unit tests natively (`tests/vectors.rs`, `src/*`), and the component
  under the real host on a scratch database (`tests/harness.rs`): migrations and ledger
  adoption, the throttle statements under contention, the import lease sweep (job and `start`),
  event to `search:<id>` calls, the `caps:<id>` probe, two searches sharing one indexer slot,
  two indexers searched at once with their partials streamed in answer order,
  a manual grab through a fake qBittorrent and the queue controls, every one of the 39 routes
  answering its frozen status and `{error: {key, detail}}` (called through `http`, below the
  host's own `:id` guard), 502 for a refusing or host-less client, `retry-import` as one
  conditional `UPDATE`, the failure ladder against the recorded one, and a refused import
  failing the row with `acquisition.failed`. The vectors also cover `pick-release`, scoring,
  `retry-after`, `route-match` and eight Torznab feeds. Not yet covered end to end: the
  `scheduled` slice resume, an instance trapped mid-request (the lease expiry is covered at the
  statement level), an import that ends `alreadyPresent` (core's ingest probes through the
  streaming engine, which the harness does not run) and one that ends `ERR_TIMEOUT` (the host's
  1800 s ingest deadline cannot be shortened); those two branches are covered by unit tests of
  the decision. The 490 TS unit tests are not ported one for one.
