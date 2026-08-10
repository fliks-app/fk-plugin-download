/**
 * Restated from `backend/src/common/plugin-contract/principal.ts` (types
 * only — a `process` plugin has no access to that source at runtime, and
 * this island imports nothing from `backend/src`). `scripts/check-contract-drift.ts`
 * diffs the method/name lists against a sibling Fliks checkout when one is present.
 */

/** Who the plugin is acting as for one `http` callback. `delegated` is a proxied
 *  authenticated request, re-checked by core against that exact user on every
 *  callback the plugin makes while handling it; `system` is a background job,
 *  limited to the scopes consented at install. Core never passes this on a
 *  `PluginHostApi` call — it is only ever the `principal` field of an inbound `http` request. */
export type Principal = { kind: 'delegated'; userId: number } | { kind: 'system' };

/** The eight scopes a `process` manifest can request, one per host-method group, consented once at install. */
export type PluginScope =
  | 'media:read'
  | 'acquisition:candidates'
  | 'releases:score'
  | 'blocklist:write'
  | 'requests:progress'
  | 'ingest:write'
  | 'events:emit'
  | 'config:rw';
