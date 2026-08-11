/**
 * Row shapes for the six tables this plugin owns, transcribed from the live
 * schema they are migrated out of. The only vocabulary shared between the data
 * layer and the ported acquisition logic — repositories and query helpers are
 * each module's own business.
 *
 * `settings` is `jsonb` in both provider tables: a bag whose keys belong to the
 * implementation, never to this contract.
 */

export type IsoTimestamp = string;

export interface IndexerRow {
  id: number;
  name: string;
  implementation: string;
  settings: Record<string, unknown>;
  enableRss: boolean;
  enableSearch: boolean;
  priority: number;
  enabled: boolean;
  capsSearchFallback: boolean;
  capsMovieSearch: boolean;
  capsTvSearch: boolean;
  requestDelay: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface IndexerStatRow {
  id: number;
  indexerId: number | null;
  queryDate: IsoTimestamp;
  queryType: string;
  responseTimeMs: number;
  resultCount: number;
  errorMessage: string | null;
}

export interface DownloadClientRow {
  id: number;
  name: string;
  implementation: string;
  settings: Record<string, unknown>;
  enabled: boolean;
  priority: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** `status` and `grabSource` are this plugin's own vocabulary, not core's.
 *  Transcribed from `DOWNLOAD_HISTORY_STATUSES`, not from the column type —
 *  the column is a bare `varchar`, so the DB does not carry the set. */
export type DownloadHistoryStatus =
  | 'grabbed'
  | 'importing'
  | 'completed'
  | 'failed'
  | 'warning';
export type GrabSource = 'auto' | 'manual';

export interface DownloadHistoryRow {
  id: number;
  sourceTitle: string;
  quality: string;
  language: string | null;
  torrentHash: string | null;
  status: DownloadHistoryStatus;
  statusMessage: string | null;
  grabSource: GrabSource;
  /** Core ids, reachable only through the `coreRefs` grant — never joined
   *  locally, always resolved through a host method. */
  mediaId: number | null;
  episodeId: number | null;
  seasonId: number | null;
  indexerId: number | null;
  downloadClientId: number | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface BlocklistRow {
  id: number;
  sourceTitle: string;
  indexerName: string | null;
  downloadUrl: string | null;
  quality: string | null;
  note: string | null;
  indexerId: number | null;
  mediaId: number | null;
  userId: number | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface StalledCheckRow {
  id: number;
  torrentHash: string;
  /** `bigint`: a torrent outgrows 2^31 bytes, so this crosses the wire as a
   *  string from node-postgres unless the driver is told otherwise. */
  downloadedBytes: number;
  checkedAt: IsoTimestamp;
}
