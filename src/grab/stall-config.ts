import type { HostCaller } from './types';

/**
 * Ported from `backend/src/plugins/download/stall-config.util.ts`. The original
 * read `SettingsService` directly with an already-namespaced key
 * (`plugin.download.stall_samples`); `config.get`/`config.set` in
 * `src/host-methods.ts` namespace `plugin.<id>.*` server-side (see `config.set`'s
 * "Prefix applied server-side" note), so this port passes the bare names and
 * lets core apply the `plugin.fliks.download.` prefix — symmetric with `config.set`.
 *
 * No manifest config field exists yet for any of these four keys (only
 * `requestsAutoGrabOnApproval` is wired in `scripts/manifest-template.ts`, which
 * this module may not edit), so `stall_samples` reads back empty on every
 * install today — the early return below is therefore permanently taken until
 * that manifest gap is closed. See the port report for the flag.
 */
export const STALL_SAMPLES_KEY = 'stall_samples';
export const STALL_INTERVAL_MINUTES_KEY = 'stall_interval_minutes';
export const STALL_AUTO_RESTART_KEY = 'stall_auto_restart';
export const STALL_INCLUDE_MANUAL_GRABS_KEY = 'stall_include_manual_grabs';

export interface StallConfig {
  samples: number;
  intervalMinutes: number;
  autoRestart: boolean;
  includeManualGrabs: boolean;
}

/** `null` means cleanup stays off. Samples unset (every fresh install) must
 *  never fall back to a default that starts deleting torrents. */
export async function getStallConfig(host: HostCaller): Promise<StallConfig | null> {
  const values = await host.call('config.get', {
    keys: [STALL_SAMPLES_KEY, STALL_INTERVAL_MINUTES_KEY, STALL_AUTO_RESTART_KEY, STALL_INCLUDE_MANUAL_GRABS_KEY],
  });

  const samples = parseInt(values[STALL_SAMPLES_KEY] ?? '', 10);
  if (!Number.isFinite(samples) || samples < 2) return null;

  const intervalMinutes = parseInt(values[STALL_INTERVAL_MINUTES_KEY] ?? '', 10);
  return {
    samples,
    intervalMinutes: Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 60,
    autoRestart: values[STALL_AUTO_RESTART_KEY] === 'true',
    includeManualGrabs: values[STALL_INCLUDE_MANUAL_GRABS_KEY] === 'true',
  };
}
