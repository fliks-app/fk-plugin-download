/**
 * Restated from `backend/src/common/plugin-contract/plugin-methods.ts` (types only, no
 * runtime code) — the 7 methods core calls on this plugin. A `process` plugin ships with no
 * access to `backend/src` at runtime, so this is a hand-kept mirror, not an import.
 *
 * `PluginManifest` itself lives in core's `manifest.ts`, not yet mirrored in this repo; aliased
 * to `unknown` below, exactly as `plugin.ts`'s own `loadManifest()` already returns it.
 */
import type { Note } from './protocol';
import type { Principal } from './principal';

type PluginManifest = unknown;

/**
 * Closed vocabulary of core SSE event names a plugin can subscribe to via
 * `event`. Restated as `string`: the actual closed set lives in core's
 * EventsService, outside this directory's import boundary.
 */
export type CoreEventName = string;

/** The 7 methods core calls on a running `process` plugin. */
export interface PluginApi {
  hello: (p: {
    pluginApi: number;
    coreVersion: string;
    config: Record<string, string>;
  }) => Promise<{
    manifest: PluginManifest;
    /** `FLIKS_PLUGIN_TOKEN` echoed back — proof the responder is the process core spawned. */
    token: string;
  }>;

  health: () => Promise<{ ok: boolean; detail?: string }>;

  job: (p: { name: string; jobId: string; args?: unknown }) => Promise<{ ok: true }>;

  http: (p: {
    method: string;
    path: string;
    query: Record<string, string>;
    body: unknown;
    principal: Principal;
  }) => Promise<{ status: number; headers: Record<string, string>; body: unknown }>;

  /** Fire-and-forget: no reply. */
  event: (p: Note<{ name: CoreEventName; payload: unknown }>) => void;

  /** Fire-and-forget: no reply. */
  config: (p: Note<{ changed: string[] }>) => void;

  shutdown: () => Promise<{ ok: true }>;
}
