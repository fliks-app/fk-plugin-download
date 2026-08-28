/** Shared in-memory fakes for the `grab-*.test.ts` files — not itself a test
 *  (no `.test.ts` suffix, so `npm test`'s `test/*.test.ts` glob skips it). */
import type { DownloadHistoryRow, DownloadClientRow, IndexerRow, StalledCheckRow, BlocklistRow } from '../src/db/rows';
import type { DownloadHistoryRepository, NewDownloadHistoryGrab, HealMatchPatch } from '../src/db/repositories/download-history.repository';
import type { StalledChecksRepository } from '../src/db/repositories/stalled-checks.repository';
import type { BlocklistRepository, NewBlocklistEntry } from '../src/db/repositories/blocklist.repository';
import type { IndexersRepository } from '../src/db/repositories/indexers.repository';
import type { DownloadClientsRepository } from '../src/db/repositories/download-clients.repository';
import type { HostCaller } from '../src/grab/types';
import type { HostMethodName, HostParams, HostResult } from '../src/host-client';
import type { DownloadClientDriver, ClientTorrent, ClientTorrentsResult, ClientTorrentFile, ClientTorrentFilesResult } from '../src/download-clients/contract';

let nextHistoryId = 1;

export function makeHistoryRow(over: Partial<DownloadHistoryRow>): DownloadHistoryRow {
  return {
    id: nextHistoryId++,
    sourceTitle: 'h',
    quality: 'WEBDL-1080p',
    language: null,
    torrentHash: 'h1',
    size: null,
    status: 'grabbed',
    statusMessage: null,
    grabSource: 'auto',
    mediaId: 1,
    episodeId: null,
    seasonId: null,
    indexerId: null,
    downloadClientId: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

export function makeTorrent(over: Partial<ClientTorrent>): ClientTorrent {
  return {
    hash: 'h1',
    name: 'h1',
    size: 1000,
    downloaded: 0,
    progress: 0,
    dlspeed: 0,
    upspeed: 0,
    ratio: 0,
    eta: 8_640_000,
    state: 'downloading',
    category: '',
    num_seeds: 1,
    num_leechs: 0,
    added_on: Math.floor(Date.now() / 1000),
    save_path: '/downloads',
    ...over,
  };
}

export function makeClient(over: Partial<DownloadClientRow> = {}): DownloadClientRow {
  return {
    id: 1,
    name: 'qbit',
    implementation: 'qbittorrent',
    settings: {},
    enabled: true,
    priority: 25,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

/** Fake `DownloadHistoryRepository` backed by an array — enough surface for
 *  the completion-poller / auto-grab tests, not a full repository re-impl. */
export class FakeHistoryRepo {
  rows: DownloadHistoryRow[] = [];
  updateCalls: { id: number; status: string; statusMessage: string | null }[] = [];
  healCalls: { id: number; patch: HealMatchPatch }[] = [];
  insertCalls: NewDownloadHistoryGrab[] = [];

  async countActive(): Promise<number> {
    return this.rows.filter((r) => r.status === 'grabbed' || r.status === 'importing').length;
  }
  async findPendingGrabForMedia(mediaId: number): Promise<DownloadHistoryRow | null> {
    return this.rows.find((r) => r.mediaId === mediaId && r.status === 'grabbed') ?? null;
  }
  async findPendingEpisodeGrab(mediaId: number, pattern: string): Promise<DownloadHistoryRow | null> {
    const needle = pattern.replace(/%/g, '').toLowerCase();
    return this.rows.find((r) => r.mediaId === mediaId && r.status === 'grabbed' && r.sourceTitle.toLowerCase().includes(needle)) ?? null;
  }
  async findPendingSeasonPackGrab(mediaId: number, seasonId: number): Promise<DownloadHistoryRow | null> {
    return this.rows.find((r) => r.mediaId === mediaId && r.status === 'grabbed' && r.seasonId === seasonId && r.episodeId == null) ?? null;
  }
  async findBySourceTitleForMedia(mediaId: number, sourceTitle: string): Promise<DownloadHistoryRow | null> {
    return this.rows.find((r) => r.mediaId === mediaId && r.sourceTitle === sourceTitle) ?? null;
  }
  async findRecentGrabbedForMedia(mediaId: number): Promise<DownloadHistoryRow[]> {
    return this.rows.filter((r) => r.mediaId === mediaId && r.status === 'grabbed');
  }
  async findAll(): Promise<DownloadHistoryRow[]> {
    return [...this.rows];
  }
  async findByTorrentHashes(hashes: string[]): Promise<DownloadHistoryRow[]> {
    const set = new Set(hashes.map((h) => h.toLowerCase()));
    return this.rows.filter((r) => r.torrentHash && set.has(r.torrentHash.toLowerCase()));
  }
  async listLinkedSourceTitles(): Promise<string[]> {
    return this.rows.filter((r) => r.mediaId != null && r.sourceTitle).map((r) => r.sourceTitle);
  }
  async findByStatuses(statuses: string[]): Promise<DownloadHistoryRow[]> {
    return this.rows.filter((r) => statuses.includes(r.status));
  }
  async findCompletedByHashes(hashes: string[]): Promise<DownloadHistoryRow[]> {
    const set = new Set(hashes.map((h) => h.toLowerCase()));
    return this.rows.filter((r) => r.status === 'completed' && r.torrentHash && set.has(r.torrentHash.toLowerCase()));
  }
  async findLatestByTorrentHash(hash: string): Promise<DownloadHistoryRow | null> {
    return this.rows.find((r) => r.torrentHash === hash) ?? null;
  }
  async findLatestBySourceTitle(title: string): Promise<DownloadHistoryRow | null> {
    return this.rows.find((r) => r.sourceTitle === title) ?? null;
  }
  async insertGrab(input: NewDownloadHistoryGrab): Promise<DownloadHistoryRow> {
    this.insertCalls.push(input);
    const row = makeHistoryRow({
      sourceTitle: input.sourceTitle,
      quality: input.quality,
      torrentHash: input.torrentHash ?? null,
      grabSource: input.grabSource,
      mediaId: input.mediaId,
      episodeId: input.episodeId ?? null,
      seasonId: input.seasonId ?? null,
      indexerId: input.indexerId ?? null,
      downloadClientId: input.downloadClientId ?? null,
      status: 'grabbed',
    });
    this.rows.push(row);
    return row;
  }
  async markImporting(id: number): Promise<void> {
    this.setStatus(id, 'importing', undefined);
  }
  async markFailed(id: number, statusMessage: string): Promise<void> {
    this.setStatus(id, 'failed', statusMessage);
  }
  async updateStatusByIds(ids: number[], status: string, statusMessage: string | null): Promise<void> {
    for (const id of ids) this.setStatus(id, status, statusMessage);
  }
  async resetStatus(from: string, to: string): Promise<void> {
    for (const r of this.rows) if (r.status === from) r.status = to as DownloadHistoryRow['status'];
  }
  async completeImport(id: number, patch?: { episodeId: number | null; seasonId: number | null }): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    row.status = 'completed';
    if (patch) {
      row.episodeId = patch.episodeId;
      row.seasonId = patch.seasonId;
    }
  }
  async reimport(id: number, torrentHash: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    row.torrentHash = torrentHash;
    row.status = 'grabbed';
    row.statusMessage = null;
  }
  async updateTorrentHash(id: number, torrentHash: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.torrentHash = torrentHash;
  }
  async healMatch(id: number, patch: HealMatchPatch): Promise<void> {
    this.healCalls.push({ id, patch });
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    row.mediaId = patch.mediaId;
    row.episodeId = patch.episodeId;
    row.seasonId = patch.seasonId;
    row.quality = patch.quality;
  }

  private setStatus(id: number, status: string, statusMessage: string | null | undefined): void {
    this.updateCalls.push({ id, status, statusMessage: statusMessage ?? null });
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    row.status = status as DownloadHistoryRow['status'];
    if (statusMessage !== undefined) row.statusMessage = statusMessage;
  }
}

export function asHistoryRepo(fake: FakeHistoryRepo): DownloadHistoryRepository {
  return fake as unknown as DownloadHistoryRepository;
}

export class FakeStalledChecksRepo {
  rows: StalledCheckRow[] = [];
  private nextId = 1;
  deletedHashes: string[] = [];

  async insert(torrentHash: string, downloadedBytes: number): Promise<StalledCheckRow> {
    const row: StalledCheckRow = { id: this.nextId++, torrentHash, downloadedBytes, checkedAt: new Date().toISOString() };
    this.rows.push(row);
    return row;
  }
  async findLatest(torrentHash: string): Promise<StalledCheckRow | null> {
    const rows = this.rows.filter((r) => r.torrentHash === torrentHash).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
    return rows[0] ?? null;
  }
  async findRecent(torrentHash: string, limit: number): Promise<StalledCheckRow[]> {
    return this.rows
      .filter((r) => r.torrentHash === torrentHash)
      .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))
      .slice(0, limit);
  }
  async findRecentForHashes(hashes: string[]): Promise<StalledCheckRow[]> {
    return this.rows.filter((r) => hashes.includes(r.torrentHash));
  }
  async deleteByHash(torrentHash: string): Promise<void> {
    this.deletedHashes.push(torrentHash);
    this.rows = this.rows.filter((r) => r.torrentHash !== torrentHash);
  }
  async pruneOlderThan(cutoff: string): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.checkedAt >= cutoff);
    return before - this.rows.length;
  }
}

export function asStalledChecksRepo(fake: FakeStalledChecksRepo): StalledChecksRepository {
  return fake as unknown as StalledChecksRepository;
}

export class FakeBlocklistRepo {
  inserted: NewBlocklistEntry[] = [];
  blockedTitles = new Set<string>();

  async isBlocked(sourceTitle: string): Promise<boolean> {
    return this.blockedTitles.has(sourceTitle.toLowerCase());
  }

  async insert(input: NewBlocklistEntry): Promise<BlocklistRow> {
    this.inserted.push(input);
    return {
      id: this.inserted.length,
      sourceTitle: input.sourceTitle,
      indexerName: input.indexerName ?? null,
      downloadUrl: input.downloadUrl ?? null,
      quality: input.quality ?? null,
      note: input.note ?? null,
      indexerId: input.indexerId ?? null,
      mediaId: input.mediaId ?? null,
      userId: input.userId ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}

export function asBlocklistRepo(fake: FakeBlocklistRepo): BlocklistRepository {
  return fake as unknown as BlocklistRepository;
}

export class FakeIndexersRepo {
  rows: IndexerRow[] = [];
  async listAll(): Promise<IndexerRow[]> {
    return [...this.rows];
  }
  async listEnabled(): Promise<IndexerRow[]> {
    return this.rows.filter((r) => r.enabled);
  }
  async listEnabledForRss(): Promise<IndexerRow[]> {
    return this.rows.filter((r) => r.enabled && r.enableRss);
  }
  async findById(id: number): Promise<IndexerRow | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async countEnabled(): Promise<number> {
    return this.rows.filter((r) => r.enabled).length;
  }
}

export function asIndexersRepo(fake: FakeIndexersRepo): IndexersRepository {
  return fake as unknown as IndexersRepository;
}

export class FakeClientsRepo {
  rows: DownloadClientRow[] = [];
  async listEnabled(): Promise<DownloadClientRow[]> {
    return this.rows.filter((r) => r.enabled);
  }
  async listAll(): Promise<DownloadClientRow[]> {
    return [...this.rows];
  }
  async countEnabled(): Promise<number> {
    return this.rows.filter((r) => r.enabled).length;
  }
  async findById(id: number): Promise<DownloadClientRow | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }
}

export function asClientsRepo(fake: FakeClientsRepo): DownloadClientsRepository {
  return fake as unknown as DownloadClientsRepository;
}

/** Fake driver — `ok`/`torrents`/`files` are set per-test; `deleteTorrent`
 *  records every call so tests can assert nothing was deleted. */
export class FakeDriver implements DownloadClientDriver {
  torrentsByClient = new Map<number, ClientTorrentsResult>();
  filesByHash = new Map<string, ClientTorrentFile[]>();
  /** Set false to simulate a client that could not be asked for its files. */
  filesOk = true;
  deleted: { clientId: number; hash: string; deleteFiles?: boolean }[] = [];
  added: { downloadUrl: string; rejectIfAlreadyPresent?: boolean }[] = [];
  nextHash = 'added-hash';
  addShouldReject = false;

  supports(client: DownloadClientRow): boolean {
    return client.enabled;
  }
  async testConnection() {
    return { ok: true, messageKey: 'ok' };
  }
  async getTorrents(client: DownloadClientRow): Promise<ClientTorrent[]> {
    return (await this.getTorrentsResult(client)).torrents;
  }
  async getTorrentsResult(client: DownloadClientRow): Promise<ClientTorrentsResult> {
    return this.torrentsByClient.get(client.id) ?? { ok: true, torrents: [] };
  }
  async getTorrentFilesResult(_client: DownloadClientRow, hash: string): Promise<ClientTorrentFilesResult> {
    return { ok: this.filesOk, files: this.filesByHash.get(hash) ?? [] };
  }
  async addTorrentUrl(_client: DownloadClientRow, downloadUrl: string, _mediaType?: 'movie' | 'series', rejectIfAlreadyPresent?: boolean): Promise<string> {
    this.added.push({ downloadUrl, rejectIfAlreadyPresent });
    if (this.addShouldReject) throw new Error('add rejected');
    return this.nextHash;
  }
  async deleteTorrent(client: DownloadClientRow, hash: string, deleteFiles?: boolean): Promise<void> {
    this.deleted.push({ clientId: client.id, hash, deleteFiles });
  }
}

/** Fake `HostCaller` — one handler per method name, defaulting to "not
 *  configured for this test" so an unexpected call fails loudly. */
export class FakeHost implements HostCaller {
  handlers = new Map<string, (payload: unknown) => unknown>();
  calls: { method: string; payload: unknown; timeoutMs?: number }[] = [];

  on<M extends string>(method: M, handler: (payload: unknown) => unknown): this {
    this.handlers.set(method, handler);
    return this;
  }

  async call<M extends HostMethodName>(method: M, payload: HostParams<M>, timeoutMs?: number): Promise<HostResult<M>> {
    this.calls.push({ method, payload, timeoutMs });
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`FakeHost: no handler registered for "${method}"`);
    return handler(payload) as HostResult<M>;
  }
}
