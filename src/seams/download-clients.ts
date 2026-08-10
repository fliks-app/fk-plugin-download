/** Lands the download-client drivers extracted from `backend/src/modules/download-clients/**`
 *  (~1,500 LOC, phase 10.1) — one entry keyed by `DownloadClient.implementation`. Empty on purpose. */
export interface DownloadClientDriver {
  add(downloadUrl: string): Promise<{ hash: string }>;
  status(hash: string): Promise<{ progress: number; downloadedBytes: number; done: boolean }>;
  remove(hash: string, deleteFiles: boolean): Promise<void>;
}

export const DOWNLOAD_CLIENT_DRIVERS: Readonly<Record<string, DownloadClientDriver>> = {};
