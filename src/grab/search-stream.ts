import type { IndexerRow } from '../db/rows';
import type { HostCaller } from './types';
import type { IndexerOutcome } from './release-search';
import { log } from '../log';

/** Who a streamed search reports to. `searchId` is minted by the client and echoed back,
 *  so a modal ignores events belonging to a search other than its own. */
export interface StreamTarget {
  userId: number;
  searchId: string;
}

export type IndexerState = 'pending' | 'done' | 'skipped' | 'failed';

export interface RosterEntry {
  id: number;
  name: string;
  state: IndexerState;
}

export interface SearchStreamer {
  roster(ready: IndexerRow[], skipped: IndexerRow[]): void;
  settled(indexer: IndexerRow, outcome: IndexerOutcome): void;
}

interface StreamerDeps {
  host: HostCaller;
  target: StreamTarget;
  /** Scores and sorts everything received so far — one `releases.score` round trip. */
  rank(): Promise<unknown[]>;
}

/**
 * Pushes a search's progress to the account that asked for it. Two event types: `search.state`
 * carries the roster alone (tabs change, the list does not), `search.partial` carries the
 * roster plus the complete re-ranked list.
 *
 * Each indexer that lands re-ranks the whole accumulated set rather than emitting its own
 * batch: core's relevance sort compares three of its eleven tiebreaks against an epsilon,
 * which makes it non-transitive, so merging independently sorted batches cannot reproduce the
 * order the final response carries. Ranking the union every time is what makes the list a
 * viewer reads while it fills the same one they end up with.
 *
 * Re-ranking is coalesced on the trailing edge: indexers landing while a rank is in flight
 * share the single pass that follows, so a fan-out where all of them answer at once costs two
 * `releases.score` calls rather than one per indexer.
 */
export function createSearchStreamer(deps: StreamerDeps): SearchStreamer {
  const entries = new Map<number, RosterEntry>();
  let ranking = false;
  let again = false;

  const snapshot = (): RosterEntry[] => [...entries.values()];

  async function emit(type: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await deps.host.call('events.emitOwn', {
        type,
        payload: { searchId: deps.target.searchId, ...payload },
        audience: { userId: deps.target.userId },
      });
    } catch (e) {
      // A viewer losing the live view must never cost them the search itself.
      log.warn(`search stream ${type} dropped: ${(e as Error).message}`);
    }
  }

  async function rankAndEmit(): Promise<void> {
    if (ranking) {
      again = true;
      return;
    }
    ranking = true;
    try {
      do {
        again = false;
        let releases: unknown[];
        try {
          releases = await deps.rank();
        } catch (e) {
          log.warn(`search stream re-rank failed: ${(e as Error).message}`);
          return;
        }
        await emit('search.partial', { indexers: snapshot(), releases });
      } while (again);
    } finally {
      ranking = false;
    }
  }

  return {
    roster(ready, skipped) {
      for (const ix of ready) entries.set(ix.id, { id: ix.id, name: ix.name, state: 'pending' });
      for (const ix of skipped) entries.set(ix.id, { id: ix.id, name: ix.name, state: 'skipped' });
      void emit('search.state', { indexers: snapshot() });
    },

    settled(indexer, outcome) {
      const added = 'releases' in outcome ? outcome.releases.length : 0;
      entries.set(indexer.id, {
        id: indexer.id,
        name: indexer.name,
        state: 'releases' in outcome ? 'done' : 'failed',
      });
      // Nothing new to rank: re-scoring an unchanged set would spend a `releases.score`
      // round trip to emit the list the viewer already has.
      if (added === 0) {
        void emit('search.state', { indexers: snapshot() });
        return;
      }
      void rankAndEmit();
    },
  };
}
