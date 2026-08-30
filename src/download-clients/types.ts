import type { DownloadClientRow } from '../db/rows';
import type { BlocklistRepository, DownloadClientsRepository, DownloadHistoryRepository, StalledChecksRepository } from '../db/repositories';
import type { ClientTorrent, DownloadClientDriver } from './contract';

/** `settings` shape for the `"qbittorrent"` implementation — the only one
 *  this plugin drives today. `password` is the one secret field. */
export interface QbittorrentSettings {
  host?: string;
  port?: number;
  useSsl?: boolean;
  username?: string;
  password?: string;
  category?: string;
  movieCategory?: string;
  seriesCategory?: string;
}

export class DownloadClientNotFoundError extends Error {}
/** Thrown when a client row's `implementation` has no registered driver, or the
 *  matching driver reports it does not support the row (see `supports()` — disabled
 *  clients report unsupported too, same as the Fliks original's `NotFoundException`). */
export class UnsupportedDownloadClientError extends Error {}
export class DownloadClientUnreachableError extends Error {}
export class DownloadClientAuthError extends Error {}
export class DownloadClientHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
/**
 * This particular release cannot be had: the indexer would not hand over the .torrent (a dead
 * link, a tracker 500, a redirect loop), or the download client already holds it outside the
 * category Fliks manages.
 *
 * Distinct from the download-client errors because the remedy differs. Another candidate is a
 * different file, often from a different tracker, so it is worth trying; a client that refuses
 * would refuse every one of them for the same reason.
 */
export class ReleaseUnobtainableError extends Error {}

export class TorrentAlreadyPresentError extends Error {}
/** The contract requires `addTorrentUrl` to reject rather than resolve with an
 *  empty hash — thrown when neither the upfront extractors nor the list-diff
 *  recovery could identify what was just added. */
export class TorrentHashUnresolvedError extends Error {}

export type DownloadClientTestMessageKey =
  | 'download.download_clients.test.host_missing'
  | 'download.download_clients.test.auth_failed'
  | 'download.download_clients.test.network_error'
  | 'download.download_clients.test.unsupported_implementation'
  | 'download.download_clients.test.ok';

/** Stored in `blocklist.note` / `download_history.statusMessage` — a key, not
 *  rendered prose, so a future UI translates it like any other user-facing text. */
export const BLOCK_REASON_KEY = 'download.download_clients.block.reason';

export interface CreateDownloadClientInput {
  name: string;
  implementation: string;
  settings?: Record<string, unknown>;
  enabled?: boolean;
  priority?: number;
}

export interface UpdateDownloadClientInput {
  name?: string;
  implementation?: string;
  settings?: Record<string, unknown>;
  enabled?: boolean;
  priority?: number;
}

export interface TestDownloadClientInput {
  implementation: string;
  settings: Record<string, unknown>;
  /** The row being edited, absent on a new draft. A blank password resolves against it. */
  id?: number;
}

/** A queue torrent slim enough for stall annotation — hash/progress/state
 *  plus the two fields this fills in. Mutated in place, mirroring the Fliks
 *  original's `annotateStalledStrikes`. */
export type StalledAnnotatable = Pick<ClientTorrent, 'hash' | 'progress' | 'state'> & {
  stalledStrikes?: number;
  stalledStrikesRequired?: number;
};

/** Only the field `annotateStalledStrikes` reads — the caller resolves the rest
 *  of the real stall-cleanup config (interval, auto-restart, …) on its own. */
export interface StallConfigLike {
  samples: number;
}

export interface DownloadClientsServiceDeps {
  repo: Pick<DownloadClientsRepository, 'listAll' | 'listEnabled' | 'findById' | 'insert' | 'update' | 'remove'>;
  /** Keyed by `DownloadClientRow.implementation`. */
  drivers: Readonly<Record<string, DownloadClientDriver>>;
  history: Pick<DownloadHistoryRepository, 'findLatestByTorrentHash' | 'findLatestBySourceTitle' | 'markFailed'>;
  blocklist: Pick<BlocklistRepository, 'insert'>;
  stalledSnapshots: Pick<StalledChecksRepository, 'findRecentForHashes'>;
  /** Fire-and-forget: lets a future auto-grab consumer re-search immediately once a
   *  release is blocklisted, instead of waiting for the next scheduled search. Unwired
   *  today — no host method exists yet for "search this media now" (see the port report). */
  onMediaBlocklisted?: (mediaId: number) => void;
}

export type { DownloadClientRow };
