import type { DownloadClientRow } from '../db/rows';
import type { DownloadClientDriver } from './contract';
import { countStalledStrikes, STALL_ELIGIBLE_STATES } from './stalled-progress';
import {
  BLOCK_REASON_KEY,
  DownloadClientNotFoundError,
  UnsupportedDownloadClientError,
  type CreateDownloadClientInput,
  type DownloadClientsServiceDeps,
  type DownloadClientTestMessageKey,
  type StalledAnnotatable,
  type StallConfigLike,
  type TestDownloadClientInput,
  type UpdateDownloadClientInput,
} from './types';
import type { ClientTestResult } from './contract';

/** The one credential every implementation's `settings` carries today. Not a
 *  generic per-field schema (there is exactly one implementation) — mirrors
 *  `IndexerService`'s own one-line `redactApiKey`. */
const SECRET_SETTING_KEY = 'password';

export class DownloadClientsService {
  constructor(private readonly deps: DownloadClientsServiceDeps) {}

  private assertKnownImplementation(implementation: string): void {
    if (!this.deps.drivers[implementation]) {
      throw new UnsupportedDownloadClientError(`Unknown download client implementation "${implementation}"`);
    }
  }

  private resolveDriver(client: DownloadClientRow): DownloadClientDriver {
    const driver = this.deps.drivers[client.implementation];
    if (!driver || !driver.supports(client)) {
      throw new UnsupportedDownloadClientError(`Download client #${client.id} does not support this operation`);
    }
    return driver;
  }

  /** Strips the stored credential so it never reaches an HTTP response. */
  redact(client: DownloadClientRow): DownloadClientRow {
    const settings = { ...(client.settings ?? {}) };
    delete settings[SECRET_SETTING_KEY];
    return { ...client, settings };
  }

  async testConnection(input: TestDownloadClientInput): Promise<ClientTestResult> {
    const driver = this.deps.drivers[input.implementation];
    if (!driver) {
      const messageKey: DownloadClientTestMessageKey = 'download.download_clients.test.unsupported_implementation';
      return { ok: false, messageKey, detail: input.implementation };
    }
    return driver.testConnection(input.settings);
  }

  async create(input: CreateDownloadClientInput): Promise<DownloadClientRow> {
    this.assertKnownImplementation(input.implementation);
    const saved = await this.deps.repo.insert({
      name: input.name,
      implementation: input.implementation,
      settings: input.settings ?? {},
      enabled: input.enabled ?? true,
      priority: input.priority ?? 1,
    });
    return this.redact(saved);
  }

  async findAll(): Promise<DownloadClientRow[]> {
    const rows = await this.deps.repo.listAll();
    return rows.map((r) => this.redact(r));
  }

  /** Unredacted, same asymmetry as `IndexerService.findOne` — the HTTP boundary
   *  (not wired yet, see `src/seams/http-routes.ts`) redacts a single-row read,
   *  not the service. */
  async findOne(id: number): Promise<DownloadClientRow> {
    const row = await this.deps.repo.findById(id);
    if (!row) throw new DownloadClientNotFoundError(`Download client #${id} not found`);
    return row;
  }

  async update(id: number, input: UpdateDownloadClientInput): Promise<DownloadClientRow> {
    const existing = await this.findOne(id);
    if (input.implementation !== undefined) this.assertKnownImplementation(input.implementation);

    let settings = existing.settings;
    if (input.settings !== undefined) {
      // Blank/absent password keeps the stored one — the client never sends the real value back on read.
      const incoming = { ...input.settings };
      const existingSecret = (existing.settings as Record<string, unknown>)?.[SECRET_SETTING_KEY];
      settings = { ...incoming, [SECRET_SETTING_KEY]: incoming[SECRET_SETTING_KEY] || existingSecret };
    }

    const saved = await this.deps.repo.update(id, {
      name: input.name ?? existing.name,
      implementation: input.implementation ?? existing.implementation,
      settings,
      enabled: input.enabled ?? existing.enabled,
      priority: input.priority ?? existing.priority,
    });
    return this.redact(saved);
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.deps.repo.remove(id);
  }

  async removeTorrent(clientId: number, hash: string, deleteFiles: boolean): Promise<void> {
    const client = await this.findOne(clientId);
    const driver = this.resolveDriver(client);
    await driver.deleteTorrent(client, hash, deleteFiles);
  }

  /**
   * Blocklist the release behind this torrent so it can't be grabbed again,
   * remove it (with its files) from the client, and mark the history row
   * failed. Ported from `download-clients.service.ts`'s `blockTorrent`; the
   * re-search trigger it fired (`EventsService.emitDomain`) has no host-method
   * equivalent yet (see the port report) — `onMediaBlocklisted` is the seam
   * for whoever wires that later.
   */
  async blockTorrent(clientId: number, hash: string): Promise<void> {
    const client = await this.findOne(clientId);
    const driver = this.resolveDriver(client);

    const entry = await this.findHistoryForHash(hash);
    if (entry) {
      try {
        await this.deps.blocklist.insert({
          sourceTitle: entry.sourceTitle,
          quality: entry.quality,
          mediaId: entry.mediaId,
          indexerId: entry.indexerId,
          note: BLOCK_REASON_KEY,
        });
      } catch {
        // Unique index on lower(sourceTitle) — already blocklisted, fine, continue with removal.
      }
    }

    await driver.deleteTorrent(client, hash, true);

    if (entry) {
      await this.deps.history.markFailed(entry.id, BLOCK_REASON_KEY);
    }

    if (entry?.mediaId != null) {
      this.deps.onMediaBlocklisted?.(entry.mediaId);
    }
  }

  /** Resolve a `download_history` row from a torrent hash, falling back to a
   *  name match across enabled clients when the hash isn't stored yet. */
  private async findHistoryForHash(hash: string) {
    const byHash = await this.deps.history.findLatestByTorrentHash(hash);
    if (byHash) return byHash;

    const clients = await this.deps.repo.listEnabled();
    for (const client of clients) {
      const driver = this.deps.drivers[client.implementation];
      if (!driver || !driver.supports(client)) continue;
      try {
        const torrents = await driver.getTorrents(client);
        const t = torrents.find((t) => t.hash.toLowerCase() === hash.toLowerCase());
        if (t) return this.deps.history.findLatestBySourceTitle(t.name);
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Fills `stalledStrikes` / `stalledStrikesRequired` on eligible queue items, using
   * the same no-progress tolerance and run-length logic as the stalled cleanup. The
   * count is clamped to the configured sample target so the display stays "x/N" even
   * when a torrent outlives the firing threshold. `stallConfig` is the caller's own —
   * this method has no settings access of its own, unlike the Fliks original which
   * read `SettingsService` directly (see the port report).
   */
  async annotateStalledStrikes(items: StalledAnnotatable[], stallConfig: StallConfigLike | null): Promise<void> {
    const eligible = items.filter((it) => it.hash && it.progress < 1 && STALL_ELIGIBLE_STATES.has(it.state));
    if (!eligible.length || !stallConfig) return;

    const hashes = eligible.map((it) => it.hash);
    const rows = await this.deps.stalledSnapshots.findRecentForHashes(hashes);
    // Global DESC order (by checkedAt) preserves each hash's own DESC order on grouping.
    const snapsByHash = new Map<string, { downloadedBytes: number }[]>();
    for (const row of rows) {
      const key = row.torrentHash.toLowerCase();
      const list = snapsByHash.get(key);
      if (list) list.push(row);
      else snapsByHash.set(key, [row]);
    }

    for (const it of eligible) {
      const snaps = snapsByHash.get(it.hash.toLowerCase()) ?? [];
      it.stalledStrikes = Math.min(countStalledStrikes(snaps), stallConfig.samples);
      it.stalledStrikesRequired = stallConfig.samples;
    }
  }
}
