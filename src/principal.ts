import type { PluginHostApi } from './host-methods';

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

/** The seven scopes a `process` manifest can request, one per method group. */
export type PluginScope =
  | 'media:read'
  | 'acquisition:candidates'
  | 'releases:score'
  | 'requests:progress'
  | 'ingest:write'
  | 'events:emit'
  | 'config:rw';

/** The scope each `PluginHostApi` method requires; core enforces this at `bind()`. */
export const HOST_METHOD_SCOPES: Record<keyof PluginHostApi, PluginScope> = {
  'media.acquisitionContext': 'media:read',
  'acquisition.candidates': 'acquisition:candidates',
  'releases.match': 'acquisition:candidates',
  'releases.score': 'releases:score',
  'media.resolve': 'media:read',
  'media.exists': 'media:read',
  'requests.markInProgress': 'requests:progress',
  'library.ingest': 'ingest:write',
  'events.publish': 'events:emit',
  'notifications.dispatch': 'events:emit',
  'counts.set': 'events:emit',
  'events.emitOwn': 'events:emit',
  'progress.set': 'events:emit',
  'config.get': 'config:rw',
  'config.set': 'config:rw',
};
