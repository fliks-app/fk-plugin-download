import type { HostCaller } from './types';
import { log } from '../log';

/** Plugin-owned, `plugin.<id>.`-prefixed server-side by `config.get`. Unset reads as enabled,
 *  matching the manifest field's declared default. */
export const AUTO_GRAB_ON_APPROVAL_KEY = 'requestsAutoGrabOnApproval';

/** The one core event this plugin acts on. Core states the fact for every approval, import
 *  that satisfied a request, and season drop; acting on it is this plugin's decision. */
export const ACQUISITION_REQUESTED = 'media.acquisition.requested';

export async function autoGrabOnApprovalEnabled(host: HostCaller): Promise<boolean> {
  const values = await host.call('config.get', { keys: [AUTO_GRAB_ON_APPROVAL_KEY] });
  return values[AUTO_GRAB_ON_APPROVAL_KEY] !== 'false';
}

export interface AcquisitionRequestedDeps {
  host: HostCaller;
  searchMissing: (mediaIds: number[]) => Promise<void>;
}

/**
 * Runs a search for exactly the media core named, instead of leaving it to the next
 * six-hourly tick. Media already being searched from an earlier event are dropped from the
 * batch: several approvals in a row would otherwise queue duplicate passes over the same
 * indexers, which the per-indexer throttle would then serialise into a long stall.
 */
export function createAcquisitionRequestedHandler(deps: AcquisitionRequestedDeps) {
  const inFlight = new Set<number>();

  return function onEvent(name: string, payload: unknown): void {
    if (name !== ACQUISITION_REQUESTED) return;

    const ids = (payload as { mediaIds?: unknown })?.mediaIds;
    const mediaIds = Array.isArray(ids)
      ? [...new Set(ids.filter((id): id is number => Number.isInteger(id)))]
      : [];
    if (!mediaIds.length) return;

    const fresh = mediaIds.filter((id) => !inFlight.has(id));
    if (!fresh.length) {
      log.info(`${name}: already searching ${mediaIds.join(', ')} — skipping`);
      return;
    }

    void (async () => {
      try {
        if (!(await autoGrabOnApprovalEnabled(deps.host))) {
          log.info(`${name}: auto-grab on approval is off — not searching`);
          return;
        }
        fresh.forEach((id) => inFlight.add(id));
        log.info(`${name}: searching for media ${fresh.join(', ')}`);
        await deps.searchMissing(fresh);
      } catch (e) {
        // A note carries no reply: a failure here can only be reported, never returned.
        log.error(`${name}: search failed: ${(e as Error).message}`);
      } finally {
        fresh.forEach((id) => inFlight.delete(id));
      }
    })();
  };
}
