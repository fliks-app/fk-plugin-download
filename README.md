# fliks.download

A `process`-tier Fliks plugin, in scaffold form. This is the artifact Phase 10 of
`plans/plugin-system.plan.md` (Fliks repo) moves indexer search, download-client
management and the acquisition grab pipeline into, once Phase 4 has extracted that
~4,600 LOC in-repo first. **It contains no acquisition business logic yet** — writing
it now would mean writing it twice and throwing one copy away. What is here is
everything that is already knowable and needed regardless: the repo skeleton, build
and packaging, the manifest, a typed RPC client for core's 17 host methods, and a
protocol harness.

## What's real here vs. what's a seam

Real and working:

- The wire protocol, dispatcher, esbuild build, deterministic archive packaging
  (optional Ed25519 signing) and CI — copied verbatim from `fliks-app/fk-plugin-notify`
  (Phase 9's proven `process`-tier plugin).
- `src/host-client.ts` — a typed client over `FLIKS_CORE_SOCK`: framing, per-call
  timeouts, request correlation, a bounded outstanding-call map. It connects on boot
  and `health` reports whether it's connected. Nothing calls it yet.
- `src/plugin.ts` answers all 7 core→plugin methods honestly: `hello`/`health`/`shutdown`
  for real; `job`/`http` look up their (currently empty) handler tables and fail the
  call — never claim success — when nothing is registered; `event`/`config` notes are
  logged and dropped.

Filled seams:

- `src/seams/indexers.ts` — the Torznab client, its capability handling and the
  per-indexer throttle, over `src/indexers/**`.
- `src/db/**` and `migrations/**` — this plugin's own Postgres schema, its migration
  runner and repositories over the six tables it owns. **Inert until `src/plugin.ts`
  creates a pool and runs the migrations at boot.**

Empty seams — an interface, no logic, one line naming what lands there:

- `src/seams/download-clients.ts` — the download-client driver registry.
- `src/seams/grab-pipeline.ts`, `src/seams/completion.ts` — the search/grab flow and the
  completion poller.
- `src/seams/jobs.ts`, `src/seams/http-routes.ts` — the dispatch tables `src/plugin.ts`'s
  `job`/`http` handlers already look up, currently empty.

## The manifest

Emitted by the build (`scripts/build.ts` + `scripts/manifest-template.ts`), never
hand-edited. Every permission and policy string lives behind the `PERMISSIONS`/`POLICY`
constants in `scripts/manifest-template.ts` — reconciling a namespacing change with core
is a one-line edit there.

- **`fliks`**: `>=2.0.0 <3.0.0`, derived by reading the Fliks repo's `backend/package.json`
  version (`2.0.1`) at authoring time and picking the loosest range with a mandatory
  upper bound that still covers it. `test/manifest.test.ts` re-checks this against a
  sibling checkout's real version when one is present.
- **`database.coreRefs`**: `["episodes", "media", "seasons", "users"]`. Derived from the
  seven traveling entities themselves, not guessed: `indexers`, `download_clients` and
  `delay_profiles` carry no relation at all; `indexer_stats` only FKs its own `indexers`,
  which travels with it. `download_history` FKs `Media`/`Episode`/`Season`
  (`download-history.entity.ts:24,39,52`) — tables `media`/`episodes`/`seasons` by their
  own `@Entity(...)` names. `blocklist` — moving here too, per the plan, since every
  column is acquisition-domain and its only other core reader is itself leaving — FKs
  `Media`/`User` (`blocklist-entry.entity.ts:33,43`), i.e. `media`/`users`.
- **`permissions`**: bare names — `releases`, `indexers`, `download-clients`,
  `delay-profiles`, `queue` — matching core's `PLUGIN_PERMISSION_NAME_PATTERN`
  (`^[a-z][a-z0-9_-]{0,63}$`, no colon, no dot). Core alone prepends `plugin:fliks.download:`
  to build the CASL subject.
- **`routes`**: the 8 `Action.Grab`-era routes `media.controller.ts:198-302` owns today,
  mirrored with the same `:id`/`:seasonId`/`:episodeId` param names, each policy
  `<action>:plugin:fliks.download:releases` and `objectGuard: mediaAccessible:id`; plus
  one `GET` per admin resource this plugin owns (`indexers`, `download-clients`,
  `delay-profiles`, `queue`). **Mutation routes for those four are deliberately left
  out** — see "What needs a renderer that doesn't exist yet" below.
- **`legacyPaths`**: the 8 old `/api/media/:id/...` URLs, each mapped to the matching
  route above, for the one major version core keeps them aliased.
- **`jobs`**: `SearchMissing`, `RssSync`, `ImportCompleted`, `CleanStalled`, `CleanSeeded`
  — the five acquisition-side entries of `SchedulerService.SCHEDULERS`
  (`scheduler.service.ts`/`completion.service.ts`), cron literals copied from the live
  `CronExpression` enum values those `@Cron` decorators use today. Core's
  `CORE_JOB_NAME_SET` still refuses these exact names as of this writing — they stop
  colliding only once core's own Phase 10.3 removes them from `SCHEDULERS`. That is
  expected sequencing, not a defect in this manifest.
- **`scopes`**: all eight — `media:read`, `acquisition:candidates`, `releases:score`,
  `blocklist:write`, `requests:progress`, `ingest:write`, `events:emit`, `config:rw`.
  This plugin is the only consumer of every `PluginHostApi` method group.
- **`ingestRoots`**: `["/downloads"]`, matching `docker-compose.example.yml`'s documented
  convention ("Same path here and in your download client."). Admin-editable after install.
- **`ui.contributions`**: one `nav.acquisition` entry linking to `/plugins/fliks.download/queue`.
- **`ui.configPages`**: one `general` page with a single real, plugin-owned setting —
  `requestsAutoGrabOnApproval` (`requests_auto_grab_on_approval`, per the plan's "Gets
  split" table: admin approvals will honour it once this plugin exists).
- **`i18n.en`**: covers exactly the labelKeys the manifest itself declares — the nav item,
  the config page and its one field, the five job labels.

### What needs a renderer that doesn't exist yet

`client/src/app/features/plugin-view/plugin-view.ts` resolves every contribution's
destination to an "unavailable" state today — the `form`, `providers` and `table` view
kinds it names are not implemented (Phase 5.6 in the plan). Concretely:

- The one `ui.configPages` entry (`form` view kind) has no renderer.
- The `indexers`/`download-clients`/`delay-profiles` admin surfaces (`providers` view
  kind) and the `queue` surface (`table` view kind) have no renderer either.
- Of the six `SlotId`s, only `nav.main`, `nav.acquisition` (via
  `nav-contributions.service.ts` + `layout.ts`) and `card.actions` (via
  `card-actions.service.ts`) currently have a live consumer in the client at all;
  `settings.page`, `media.actions` and `media.season.actions` have none. This manifest
  only uses `nav.acquisition`, for exactly that reason.
- `{ kind: 'action' }` contributions dispatch through a closed, core-owned `actionId`
  switch (`nav-contributions.service.ts:95-96`) with exactly one entry today
  (`nav.my-profile`) — a plugin cannot register its own. Every contribution here uses
  `{ kind: 'route' }` instead.

None of this blocks anything in this repo — it explains why the one nav item this
manifest declares renders as a link to a page that currently says "unavailable".

### Routes deliberately left out

`delay-profiles` stays core's table, so no route serves it here.

Everything the three admin pages need is declared: full CRUD for `indexers` and
`download-clients`, their connection tests, indexer stats and cooldowns, the blocklist,
and a paged queue. The queue reports each row's client reachability rather than folding
an unreachable client into an empty page.

## The RPC client (`src/host-client.ts`)

Typed against `PluginHostApi` in `src/host-methods.ts` (see below). `HostClient.call(method,
payload, timeoutMs?)`:

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
  only ever arrives on an inbound `http` request (`src/principal.ts`). `HostClient`
  doesn't invent a parameter the real contract doesn't carry; a caller that needs to
  reason about which principal is in play threads the `Principal` it already has from
  that `http` request through its own call sites. `src/seams/http-routes.ts`'s
  `PluginHttpRequest.principal` is where that value lives today.

## Keeping the contract from drifting

`src/host-methods.ts` and `src/principal.ts` restate (never import — a `process` plugin
ships with no access to `backend/src` at runtime) the types in
`backend/src/common/plugin-contract/{host-methods,principal}.ts`. Two independent guards:

1. `scripts/check-contract-drift.ts` (manual, like `verify-with-core.ts` — needs a
   sibling Fliks checkout) diffs the `PluginHostApi` method-*name* set between the two
   files.
2. Every call this plugin ever makes is typed against `PluginHostApi` here, so a
   signature change that isn't mirrored fails `npm run typecheck` at the call site the
   moment domain logic lands — not silently at runtime.

Field-level shape drift between now and whenever this file is next hand-checked against
core is the residual risk name-diffing can't catch; accepted because there is no code
calling any of these methods yet for a subtle shape mismatch to break.

## Build

```sh
npm install
npm run typecheck
npm test
npm run build        # -> dist/plugin.js, dist/plugin.json, dist/logo.svg
node --check dist/plugin.js
```

## Package

```sh
npm run package      # -> dist/fliks-download.fkplugin (unsigned)
```

Deterministic: rebuilding from the same source produces byte-identical output. To sign,
set `FK_DOWNLOAD_SIGNING_KEY` to a PEM-encoded Ed25519 private key
(`openssl genpkey -algorithm ed25519`) before packaging — the script works unsigned too,
which is what a local install needs (see below).

## Install locally

A `process`-tier plugin must be signed unless its id is on core's `FLIKS_UNSIGNED_PLUGINS`
allowlist:

```sh
FLIKS_UNSIGNED_PLUGINS=fliks.download   # set in the Fliks server's environment
```

Then install `dist/fliks-download.fkplugin` through the admin plugin-sources UI (or the
equivalent API). There is nothing to configure yet beyond the one `requestsAutoGrabOnApproval`
toggle, and no working route or job — see "What's real here vs. what's a seam" above.

## Publish (maintainer-only, not done here)

1. Sign with the production key: `FK_DOWNLOAD_SIGNING_KEY=<prod key> npm run package`.
2. Publish the archive and its entry to `fliks-app/fliks-plugin-catalog`, per that repo's
   process. This repository does not push anywhere and has no remote configured beyond
   `origin` — publishing to the catalog is an explicit, separate, outward-facing step
   this scaffold does not take.

## Verification performed

- `node --check dist/plugin.js` passes.
- `test/harness.test.ts` spawns `dist/plugin.js` under the exact env allowlist and
  `node --permission`/`--allow-fs-*` flags `spawn-plan.ts` uses, then drives the full
  protocol (`hello` → `health` → `event`/`config` notes → `http` (404, honest) → `job`
  (rejects, honest) → `shutdown`) with no core process involved, and asserts it dials
  out to `FLIKS_CORE_SOCK` too.
- `test/host-client.test.ts` drives `HostClient` against a real unix-socket stub: reply
  correlation under out-of-order replies, per-call timeout without affecting other
  outstanding calls, a core-side error reply, a protocol violation failing every
  outstanding call, a lost connection doing the same, the outstanding-call bound, and
  the immediate rejection when never connected.
- `dist/fliks-download.fkplugin` was checked against the real core validator
  (`inspect()` from the Fliks repo's `backend/src/modules/plugins/archive`) — see
  `scripts/verify-with-core.ts` for which source it used and the result.
