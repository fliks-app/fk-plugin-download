import type { ClientTorrent } from '../download-clients/contract';

/** Core's closed progress vocabulary — mirrors `progress.set`'s `state` union
 *  in `src/host-methods.ts` (restated from core's `DownloadProgressState`, no
 *  import access to `backend/src` at runtime). */
export type ProgressState = 'queued' | 'active' | 'stalled' | 'paused' | 'importing';

/**
 * Ported from `qbittorrentStateToProgress` in
 * `backend/src/plugins/download/download-clients/qbittorrent.service.ts` — the
 * only place a driver's raw vendor state string may be interpreted. `state` on
 * `ClientTorrent` is documented as "the client's own vocabulary" precisely so
 * this mapping happens here, at the one boundary that calls `progress.set`,
 * never inside the driver and never passed to core raw.
 *
 * qBittorrent-specific: the only driver this plugin ships today. Seeding /
 * upload-side states never reach here in practice — callers only map torrents
 * still below 100% progress — so they fall through to the `active` default.
 */
export function mapClientStateToProgress(state: string): ProgressState {
  switch (state) {
    case 'queuedDL':
      return 'queued';
    case 'stalledDL':
    case 'error':
    case 'missingFiles':
      return 'stalled';
    case 'pausedDL':
    case 'pausedUP':
    case 'stoppedDL':
    case 'stoppedUP':
      return 'paused';
    case 'moving':
      return 'importing';
    case 'downloading':
    case 'forcedDL':
    case 'metaDL':
    case 'forcedMetaDL':
    case 'allocating':
    case 'checkingDL':
    case 'checkingResumeData':
    default:
      return 'active';
  }
}

export function torrentProgressState(t: Pick<ClientTorrent, 'state'>): ProgressState {
  return mapClientStateToProgress(t.state);
}
