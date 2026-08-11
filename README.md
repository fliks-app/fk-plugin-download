# fliks.download

A `process`-tier Fliks plugin: Torznab indexer search, qBittorrent download-client
management, the acquisition grab pipeline (auto-grab, manual grab, upgrades), the
completion poller (import hand-off, stalled-download cleanup, seeded-torrent cleanup)
and the five cron jobs that drive them — plus the six-table Postgres schema all of that
runs on. This is the real logic, not a scaffold: every seam under `src/seams/**` is
wired to a working implementation, exercised end to end by `test/harness.test.ts` over
the actual wire protocol and a real database.

## Layout

- **Wire protocol / dispatcher / host client** — unchanged from Phase 9's proven
  `fliks-app/fk-plugin-notify`: `src/protocol.ts` (newline-delimited JSON frames, a
  4 MiB per-frame ceiling), `src/dispatcher.ts` (binds request/note handler tables to
  the core-facing socket), `src/host-client.ts` (a typed client over `FLIKS_CORE_SOCK`
  — per-call timeouts, reply correlation by request id, a 256-call outstanding bound,
  one `onFatal` path that fails every outstanding call on a protocol violation or lost
  connection).
- **`src/plugin.ts`** — the entry point. Reads its env, dials `FLIKS_CORE_SOCK`, runs
  migrations and builds the object graph (`src/composition-root.ts`) before `hello`
  ever replies, then answers `hello`/`health`/`job`/`http`/`shutdown` and logs the
  `event`/`config` notes.
- **The domain logic**, ported from the in-repo acquisition stack and wired end to end:
  - `src/indexers/**` — the Torznab client, capability parsing, per-indexer throttle
    and cooldown; wired by `src/seams/indexers.ts`.
  - `src/download-clients/**` — the qBittorrent driver, stalled-progress detection,
    torrent-hash resolution; wired by `src/seams/download-clients.ts`.
  - `src/grab/**` — release search/scoring, the interactive and scheduled grab paths,
    the completion poller; wired by `src/seams/grab-pipeline.ts` and
    `src/seams/completion.ts`.
  - `src/seams/jobs.ts` — one handler per manifest job, dispatched by name.
  - `src/seams/http-routes.ts` — the full route table, matched first-match-wins,
    canonical paths and `legacyPaths` aliases alike.
  - `src/db/**` + `migrations/**` — this plugin's own schema, migration runner and six
    repositories (below).
- **`src/host-methods.ts`** / **`src/principal.ts`** — hand-kept, types-only mirrors of
  core's `backend/src/common/plugin-contract/{host-methods,principal}.ts`. A `process`
  plugin has no access to `backend/src` at runtime, so this is a restatement, not an
  import — see "Keeping the contract from drifting" below for how that's guarded.

## The manifest

Emitted by the build (`scripts/build.ts` + `scripts/manifest-template.ts`), never
hand-edited. Every permission and policy string lives behind the `PERMISSIONS`/`POLICY`
constants in `scripts/manifest-template.ts` — reconciling a namespacing change with core
is a one-line edit there.

- **`fliks`**: `>=2.0.0 <3.0.0` — the whole 2.x line, cut off before an unknown-shape
  3.0. `test/manifest.test.ts` re-checks this against a sibling checkout's real version
  (`backend/package.json`) when one is present, and asserts the upper bound stays
  mandatory.
- **`permissions`**: 6 bare names — `releases`, `indexers`, `download-clients`,
  `delay-profiles`, `queue`, `blocklist` — matching core's `PLUGIN_PERMISSION_NAME_PATTERN`
  (`^[a-z][a-z0-9_-]{0,63}$`, no colon, no dot). Core alone prepends `plugin:fliks.download:`
  to build the CASL subject; `POLICY` in `scripts/manifest-template.ts` builds the exact
  same string so every route's `policy` field is correct by construction.
  `delay-profiles` is declared but nothing currently gates a route with it — the table
  stays core's, and no route here needs it yet.
- **`routes`**: 27 entries — the 8 grab/release routes (`GET`/`POST` on `releases`,
  `upgrade-releases`, `upgrade`, and their season/episode siblings, each with
  `objectGuard: mediaAccessible:id`), full CRUD + connection-test + implementations for
  `indexers` (9 routes: list, create, test-connection, clear-all-cooldowns,
  implementations, update, delete, clear-one-cooldown, stats) and `download-clients` (6
  routes), a paged `queue`, and `blocklist` list/clear-all/delete-one (3 routes). Core no
  longer implements any of this itself: `media.controller.ts` has none of these paths
  today (the acquisition stack that used to own them is gone), so this plugin is the
  sole implementation, not a deprecated alias sitting next to a live core route.
  `/indexers/cooldowns`, `/indexers/implementations`, `/download-clients/implementations`
  and `/blocklist/all` are declared ahead of their same-length `:id` siblings — both the
  manifest's route table and this plugin's own matcher (`src/seams/http-routes.ts`)
  resolve first-match-wins, so the literal segment has to come first or it reads as an
  id. `GET /delay-profiles` is not declared at all (no page needs it yet).
- **`legacyPaths`**: 8 entries, each an old `/api/media/:id/...` URL mapped to its
  modern equivalent above — a compatibility shim for clients written against the
  pre-plugin API, not a core-side deprecation window.
- **`jobs`**: `SearchMissing`, `RssSync`, `ImportCompleted`, `CleanStalled`,
  `CleanSeeded`, cron literals copied from the `CronExpression` values the equivalent
  `@Cron` decorators used before the acquisition stack was removed from core. Core's own
  scheduler no longer reserves any of these names — `CORE_SCHEDULER_JOB_NAMES` today is
  `RefreshMetadata`/`SubtitleSearch`/`SubtitleUpgrade` — so there is no naming collision
  to wait out.
- **`database.coreRefs`**: `["episodes", "media", "seasons", "users"]`, derived from the
  six owned tables themselves, not guessed: `indexers`, `download_clients` and
  `stalled_checks` carry no relation to core at all; `indexer_stats` only FKs its own
  `indexers`, which travels with it. `download_history` FKs `Media`/`Episode`/`Season`
  — tables `media`/`episodes`/`seasons` by their own `@Entity(...)` names, not their
  class names. `blocklist` — moved here outright, core deleted `blocklist.add` and
  `blocklist.check` when it did — FKs `Media`/`User`, i.e. `media`/`users`.
- **`scopes`**: 7 — `media:read`, `acquisition:candidates`, `releases:score`,
  `requests:progress`, `ingest:write`, `events:emit`, `config:rw` — exactly core's
  current scope vocabulary (`PLUGIN_SCOPES` in
  `backend/src/modules/plugins/archive/manifest-parser.ts`). `blocklist:write` is gone:
  it existed only while core owned the blocklist table, and core's archive validator
  now refuses a manifest that still declares it (`PLUGIN_BAD_MANIFEST`). This plugin is
  the sole consumer of every remaining host-method group, so it requests all seven.
- **`ingestRoots`**: `["/downloads"]`, matching the convention documented in the Fliks
  repo's own `docker-compose.example.yml` ("Same path here and in your download
  client."). Admin-editable after install.
- **`ui.contributions`**: one `nav.acquisition` entry (the queue link) and three
  `settings.page` entries (general, indexers, download-clients). Both slots have a live
  renderer in the client today (`nav-contributions.service.ts` + the layout sidebar, and
  `settings-sections.service.ts`, respectively). Every contribution here uses
  `{ kind: 'route' }`: the `{ kind: 'action' }` path resolves against a closed,
  core-owned `actionId` list per slot (nav's is one entry, `nav.my-profile`; this plugin
  has no reason to register a page under it, and couldn't add its own id if it did).
- **`ui.configPages`**: four pages, all backed by a live renderer (`form`/`providers`/
  `table` are all implemented client-side, not "unavailable" placeholders): `general`
  (the one real setting, `requestsAutoGrabOnApproval`, plus the stall-cleanup fields
  below), `indexers` and `download-clients` (`providers` pages over this plugin's own
  CRUD + `implementations` routes), and `queue` (a read-only `table` page over
  `GET /queue`).
- **`i18n.en`**: 78 keys, covering exactly what the manifest itself references
  (`test/manifest.test.ts` walks `ui.contributions`/`ui.configPages` for every
  `labelKey`/`hint`/`*Key` and asserts each has an entry here) plus the job labels and
  the route-level error/test-result keys `src/seams/http-routes.ts` returns.

## The RPC client (`src/host-client.ts`)

`HostClient.call(method, payload, timeoutMs?)`:

- Writes one `Req { i, m, p }` frame and tracks it in a `Map<number, Pending>` keyed by
  `i` — replies correlate back to their caller regardless of arrival order.
- Every call carries a deadline (`DEFAULT_CALL_TIMEOUT_MS = 10_000` unless overridden)
  and **rejects** on expiry rather than hanging; the timer is independent per call, so
  one slow call never blocks another.
- Caps outstanding calls at `MAX_OUTSTANDING_CALLS = 256` — the 257th rejects immediately
  instead of growing the map without bound while core is stalled.
- A protocol violation (oversize/malformed frame) or a lost connection fails **every**
  outstanding call via one `onFatal` path — the client never wedges silently.
- Core never attaches a `Principal` to a `PluginHostApi` reply — `system` vs `delegated`
  only ever arrives on an inbound `http` request (`src/principal.ts`). A caller that
  needs to reason about which principal is in play threads the `Principal` it already
  has from that `http` request through its own call sites; `src/seams/http-routes.ts`'s
  `PluginHttpRequest.principal` is where that value lives today, and every route handler
  gets it.

## Keeping the contract from drifting

`src/host-methods.ts` restates (never imports — a `process` plugin ships with no access
to `backend/src` at runtime) the 15 methods of core's `PluginHostApi`, grouped A–E as
the plan groups them. Two independent guards:

1. `scripts/check-contract-drift.ts` (also runnable directly; needs a sibling Fliks
   checkout) diffs the `PluginHostApi` method-*name* set between the two files, plus the
   field sets of `ScoredRelease` and `AcquisitionTarget` — method-name parity alone once
   let a drifted `ScoredRelease` through silently, since a missing field doesn't fail to
   compile.
2. `test/contract-drift.test.ts` runs the same check as part of the normal test loop
   (not just a manual/release step), and skips loudly — not silently — when no sibling
   checkout is present, which is the case in CI (Fliks is a separate repo).

Every call this plugin makes is also typed against `PluginHostApi` here, so a signature
change that isn't mirrored fails `npm run typecheck` at the call site the moment it
would matter, not silently at runtime. Field-level shape drift in interfaces the drift
checker doesn't specifically compare (`AcquisitionEvent`, most `PluginHostApi` parameter
shapes) is the residual risk name-diffing can't catch.

## Database

Six tables (`migrations/0001_initial_schema.ts`): `indexers`, `download_clients`,
`indexer_stats`, `download_history`, `blocklist`, `stalled_checks` — one repository each
(`src/db/repositories/`). `download_history` and `blocklist` are the only two with a
foreign key out of this schema, into core's `media`/`episodes`/`seasons`/`users` tables
(see `database.coreRefs` above); every other table is self-contained.

- `src/db/pool.ts` pins the connection's `search_path` to `plugin_fliks_download` at the
  Postgres connection-startup-parameter level — every query here targets that schema, and
  the role backing it holds `REFERENCES`-only on the four `coreRefs` tables, never
  `SELECT`. `test/db-cross-schema-fk.test.ts` proves both halves against a real role: a
  table here can FK into `public.media` and have that FK enforced, while a plain
  `SELECT` against `public.media` by that same role is denied (Postgres error `42501`).
- `src/db/migrate.ts` applies whatever in `migrations/index.ts`'s `MIGRATIONS` array
  isn't yet recorded in this schema's own `_migrations` table, each migration in its own
  transaction. Run automatically by `src/plugin.ts` at boot, before `hello` replies —
  `test/harness.test.ts` asserts the six tables exist by the time it does.
- `npm run migrate` drives the same runner from the CLI (`src/db/migrate-cli.ts`).

## Build

```sh
npm install
npm run typecheck
npm test
npm run build        # -> dist/plugin.js, dist/plugin.json, dist/logo.svg
node --check dist/plugin.js
```

## Test

```sh
npm test              # tsx --test --test-concurrency=1 test/*.test.ts
```

Most of the suite needs no database. A handful of tests (`test/db.test.ts`,
`test/db-cross-schema-fk.test.ts`, `test/harness.test.ts`) need a real Postgres reachable
at `postgresql://fliks:fliks@127.0.0.1:55432/fliks` (override with `FK_TEST_PG_DSN`) and
skip themselves — loudly, with a named reason, never silently — when it isn't there.
CI (`.github/workflows/ci.yml`) always has one: it starts a `postgres:17` service on
that port and creates bare stand-in tables for `media`/`episodes`/`seasons`/`users` (just
enough shape for the FK/grant tests — not core's real schema) before running `npm test`,
`npm run build` and `node --check dist/plugin.js`. Never point either DSN at the Fliks
dev database on port 5434.

## Package

```sh
npm run package      # -> dist/fliks-download.fkplugin (unsigned)
```

Deterministic: rebuilding from the same source produces byte-identical archive bytes
(fixed DOS timestamp, store-only compression, sorted-by-construction entry order). To
sign, set `FK_DOWNLOAD_SIGNING_KEY` to a PEM-encoded Ed25519 private key
(`openssl genpkey -algorithm ed25519`) before packaging — the script works unsigned too,
which is what a local install needs.

## Install locally

A `process`-tier plugin must be signed unless its id is on core's `FLIKS_UNSIGNED_PLUGINS`
allowlist:

```sh
FLIKS_UNSIGNED_PLUGINS=fliks.download   # set in the Fliks server's environment
```

Then install `dist/fliks-download.fkplugin` through the admin plugin-sources UI (or the
equivalent API).

## Publish (maintainer-only, not done here)

1. Sign with the production key: `FK_DOWNLOAD_SIGNING_KEY=<prod key> npm run package`.
2. Publish the archive and its entry to `fliks-app/fliks-plugin-catalog`, per that repo's
   process. This repository does not push anywhere and has no remote configured beyond
   `origin` — publishing to the catalog is an explicit, separate, outward-facing step
   this repo does not take.

## What's deliberately not done yet

- **No manual-grab or replacement-picker UI.** The backend supports both: `POST /:id/grab`
  accepts an optional manual `downloadUrl` (`src/seams/http-routes.ts`'s
  `readManualGrabInput`), and `GET /:id/releases` returns every scored candidate. No
  `ui.contributions`/`ui.configPages` entry points at either — there is no page today
  where an admin can paste a magnet/torrent link or pick a specific release to grab
  instead of the auto-picked one.
- **Free-text unknown-language code.** The indexer form's `unknownLanguageIsoCode` field
  (`src/seams/http-routes.ts`'s `INDEXER_IMPLEMENTATIONS`) is a plain text input, not a
  validated select over known ISO 639-1 codes — a typo is stored and used as-is, with
  nothing to catch it.
- **No retention-day cleanup for seeded torrents.** `CleanSeeded` only ports the
  ratio-target half of the original job (`src/grab/completion-poller.ts`'s
  `cleanSeeded`). The `maxRetentionDays` half needs each torrent's completion timestamp,
  and `ClientTorrent` (`src/download-clients/contract.ts`) carries no
  `completion_on`/finish-time field — dropped rather than approximated with a
  materially different clock (`added_on`).
- **One indexer protocol, one download client.** `IndexerService` only ever accepts
  `"torznab"` (`src/indexers/service.ts`), and `DOWNLOAD_CLIENT_DRIVERS`
  (`src/seams/download-clients.ts`) has exactly one entry, `qbittorrent`. Both are
  structured to take more (a driver map, an implementations list in the manifest), but
  nothing else is implemented.
- **Per-episode progress granularity is lost for series.** `emitDownloadProgress`
  (`src/grab/completion-poller.ts`) omits `seasonNumber`/`episodeNumber` on
  `progress.set`: the row only stores season/episode **ids**, and resolving them to
  numbers would need a `media.resolve` call this plugin doesn't have a specified
  response shape for in a mixed batch. Whole-media progress still works.
- **Orphan-bound torrents get no real quality.** When the completion poller identifies
  a torrent that was never grabbed through this plugin (`autoMatchOrphanTorrents`), it
  has no release object to derive a quality from and records `'unknown'` rather than
  guessing.
- **Season/episode reconciliation after import doesn't re-derive from what actually
  landed.** `library.ingest`'s response reports season/episode by *number*; the
  `download_history` row's own columns store season/episode by *id*, and no host method
  resolves one to the other, so `processOne` leaves whatever id the row already had from
  grab time as-is.

## Verification performed

- `npm run typecheck`, `npm test` and `npm run build` all pass (see the PR/commit this
  file travels with for the actual command output).
- `node --check dist/plugin.js` passes.
- `test/harness.test.ts` spawns `dist/plugin.js` under the exact env allowlist and
  `node --permission`/`--allow-fs-*` flags `spawn-plan.ts` uses, then drives the full
  protocol (`hello` → `health` → `event`/`config` notes → `http` CRUD + queue + legacy
  alias + path-traversal rejection → `job` × 5 → `shutdown`) against a real, freshly
  migrated schema, with no core process involved beyond a canned-reply stand-in.
- `test/host-client.test.ts` drives `HostClient` against a real unix-socket stub: reply
  correlation under out-of-order replies, per-call timeout without affecting other
  outstanding calls, a core-side error reply, a protocol violation failing every
  outstanding call, a lost connection doing the same, the outstanding-call bound, and
  the immediate rejection when never connected.
- `dist/fliks-download.fkplugin` was checked against the real core validator
  (`inspect()` from the Fliks repo's `backend/src/modules/plugins/archive/zip-inspector.ts`,
  imported live via `tsx` since this checkout carries no compiled `dist/`) via
  `scripts/verify-with-core.ts` — accepted as a valid `process`-tier manifest.
