import type { DownloadClientRow } from '../db/rows';

/**
 * The download-client driver surface, transcribed from what the acquisition code
 * actually calls on it rather than from any one implementation's public methods.
 * Shared between the driver that implements it and the grab/completion flow that
 * consumes it — neither side redefines it.
 */

export interface ClientTorrent {
  hash: string;
  name: string;
  size: number;
  /** Bytes so far — the stall detector snapshots this. */
  downloaded: number;
  /** 0–1. */
  progress: number;
  dlspeed: number;
  upspeed: number;
  ratio: number;
  /** Epoch seconds when the download finished. Absent or <= 0 when the client reports none,
   *  which is not the same as "just finished" — a retention rule must skip it, not assume now. */
  completion_on?: number;
  /** Seconds. Some clients report a sentinel for "unknown" rather than null. */
  eta: number;
  /** The client's own vocabulary. Mapped to core's closed progress state at the
   *  boundary that parses it, never passed outwards raw. */
  state: string;
  category: string;
  num_seeds: number;
  num_leechs: number;
  /** Unix seconds. */
  added_on: number;
  save_path?: string;
  content_path?: string;
}

export interface ClientTorrentFile {
  /** Relative path within the torrent. */
  name: string;
  size: number;
  progress: number;
  priority: number;
}

/**
 * Separates "holds no torrents" from "could not be reached": an unreachable or
 * unauthenticated client yields the same empty list as an idle one, and a caller
 * that deletes on a torrent's absence — the orphan sweep, stalled removal — must
 * skip a tick built on a fetch that never succeeded.
 */
export interface ClientTorrentsResult {
  ok: boolean;
  torrents: ClientTorrent[];
}

/** Same ok/data split as {@link ClientTorrentsResult} — a client that could not be
 *  asked must never read as "this torrent has no files". */
export interface ClientTorrentFilesResult {
  ok: boolean;
  files: ClientTorrentFile[];
}

export interface ClientTestResult {
  ok: boolean;
  /** An i18n key, never prose: user-facing text lives in the manifest. */
  messageKey: string;
  /** The dynamic half — an HTTP status, the client's own error text. */
  detail?: string;
}

export interface DownloadClientDriver {
  /** Whether this driver handles the row's `implementation`, and it is enabled. */
  supports(client: DownloadClientRow): boolean;
  testConnection(settings: Record<string, unknown>): Promise<ClientTestResult>;
  getTorrents(client: DownloadClientRow): Promise<ClientTorrent[]>;
  getTorrentsResult(client: DownloadClientRow): Promise<ClientTorrentsResult>;
  getTorrentFilesResult(
    client: DownloadClientRow,
    hash: string,
  ): Promise<ClientTorrentFilesResult>;
  /** Resolves to the torrent hash. Rejects rather than returning null — a grab
   *  that could not be added must not be recorded as one. */
  addTorrentUrl(
    client: DownloadClientRow,
    torrentUrl: string,
    mediaType?: 'movie' | 'series',
    /** Reject a hash the client already holds, so a grab is never recorded
     *  against a torrent this plugin did not add. Off for user-driven grabs,
     *  where re-adding a release on purpose is legitimate. */
    rejectIfAlreadyPresent?: boolean,
  ): Promise<string>;
  deleteTorrent(
    client: DownloadClientRow,
    hash: string,
    deleteFiles?: boolean,
  ): Promise<void>;
}
