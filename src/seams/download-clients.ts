/**
 * Lands the download-client drivers extracted from
 * `backend/src/plugins/download/download-clients/**` — one entry keyed by
 * `DownloadClient.implementation`. Real logic lives in `src/download-clients/**`;
 * this file is the wiring point for whoever constructs a `DownloadClientsService`
 * at boot with the Postgres-backed repositories (`src/db/**`, a separate module)
 * and the host-side pieces (`onMediaBlocklisted`, the stall config) it takes as
 * plain constructor deps rather than reaching for on its own.
 */
import { QbittorrentDriver } from '../download-clients/qbittorrent-driver';
import type { DownloadClientDriver } from '../download-clients/contract';

export { QbittorrentDriver, buildBaseUrl } from '../download-clients/qbittorrent-driver';
export { DownloadClientsService } from '../download-clients/service';
export { extractMagnetInfoHash, computeInfoHash } from '../download-clients/torrent-hash';
export {
  STALL_ELIGIBLE_STATES,
  STALL_PROGRESS_TOLERANCE_BYTES,
  countStalledStrikes,
  isNoProgress,
} from '../download-clients/stalled-progress';
export type { ProgressSample } from '../download-clients/stalled-progress';
export {
  BLOCK_REASON_KEY,
  DownloadClientAuthError,
  DownloadClientHttpError,
  DownloadClientNotFoundError,
  DownloadClientUnreachableError,
  TorrentAlreadyPresentError,
  TorrentHashUnresolvedError,
  UnsupportedDownloadClientError,
} from '../download-clients/types';
export type {
  CreateDownloadClientInput,
  DownloadClientsServiceDeps,
  DownloadClientTestMessageKey,
  QbittorrentSettings,
  StalledAnnotatable,
  StallConfigLike,
  TestDownloadClientInput,
  UpdateDownloadClientInput,
} from '../download-clients/types';
export type {
  ClientTestResult,
  ClientTorrent,
  ClientTorrentFile,
  ClientTorrentsResult,
  DownloadClientDriver,
} from '../download-clients/contract';

export const DOWNLOAD_CLIENT_DRIVERS: Readonly<Record<string, DownloadClientDriver>> = {
  qbittorrent: new QbittorrentDriver(),
};
