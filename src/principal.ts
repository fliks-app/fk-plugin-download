/**
 * Restated from `backend/src/common/plugin-contract/principal.ts` (types
 * only — a `process` plugin has no access to that source at runtime, and
 * this island imports nothing from `backend/src`). Kept in sync by hand —
 * `scripts/check-contract-drift.ts` only diffs `host-methods.ts`.
 */

/** Who the plugin is acting as for one `http` callback. `delegated` is a proxied
 *  authenticated request, re-checked by core against that exact user on every
 *  callback the plugin makes while handling it; `system` is a background job,
 *  limited to the scopes consented at install. Core never passes this on a
 *  `PluginHostApi` call — it is only ever the `principal` field of an inbound `http` request. */
export type Principal = { kind: 'delegated'; userId: number } | { kind: 'system' };
