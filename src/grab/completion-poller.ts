import * as path from 'path';
import type { DownloadClientDriver, ClientTorrent } from '../download-clients/contract';
import type { DownloadClientsRepository, IndexersRepository, DownloadHistoryRepository, StalledChecksRepository, BlocklistRepository } from '../db/repositories';
import type { DownloadHistoryRow, DownloadClientRow } from '../db/rows';
import type { HostCaller } from './types';
import { TorrentHistoryMatcher, normaliseTorrentName, outranksForTorrent } from './torrent-name-matcher';
import { identifyOrphans, resolveSeasonEpisodeIds } from './orphan-matcher';
import { buildGrabHistoryRow } from './grab-history';
import { getStallConfig } from './stall-config';
import { countStalledStrikes, STALL_ELIGIBLE_STATES } from '../download-clients/stalled-progress';
import { torrentProgressState } from './progress-state';
import { log } from '../log';

/** Ported from `common/constants/video-extensions.ts` — small and stable
 *  enough to inline rather than add a file for it. */
const VIDEO_EXTS: ReadonlySet<string> = new Set(['.mkv', '.mp4', '.avi', '.mov', '.ts', '.m2ts', '.wmv', '.flv']);

/** How long a `grabbed`/`importing` row may stay without a matching torrent
 *  before it's marked `failed`. Ported verbatim from `completion.service.ts`. */
const ORPHAN_GRACE_MS = 5 * 60_000;

/** Stamp the orphan sweep writes, recognised on the way back in so a
 *  reappearing torrent clears it rather than leaving a stale message next to
 *  a torrent the client is still reporting. */
const ORPHAN_STATUS_MESSAGE = 'Torrent no longer present in download client';

type Torrent = ClientTorrent & { _clientId: number };

export interface CompletionPollerDeps {
  host: HostCaller;
  driver: DownloadClientDriver;
  clientsRepo: Pick<DownloadClientsRepository, 'listEnabled'>;
  indexersRepo: Pick<IndexersRepository, 'listAll' | 'findById'>;
  historyRepo: DownloadHistoryRepository;
  stalledChecksRepo: StalledChecksRepository;
  blocklistRepo: Pick<BlocklistRepository, 'insert'>;
  historyMatcher: TorrentHistoryMatcher;
  /**
   * Fire-and-forget re-search trigger after a stalled-cleanup removal.
   * Upstream published a `media.acquisition.requested` domain event that a
   * *different* NestJS service (`AcquisitionSchedulerService`) subscribed to;
   * here both live in the same process, so this is a direct in-process call
   * instead of a round trip through core. Supplied by whoever wires
   * `src/plugin.ts`/`src/seams/jobs.ts` (not owned by this module) — pass
   * `async () => {}` to disable.
   */
  searchMissing: (mediaIds: number[]) => Promise<void>;
}

/**
 * Ported from `backend/src/plugins/download/completion.service.ts`. Three
 * entry points, one per manifest job (`ImportCompleted`, `CleanStalled`,
 * `CleanSeeded`) — the placeholder `CompletionPoller` seam only declared
 * `poll()`; broadened here (this file is mine to shape) so each job maps to
 * exactly one method.
 */
export class DownloadCompletionPoller {
  /** Torrent hashes the auto-matcher could not identify on the previous
   *  tick — rebuilt wholesale each run. */
  private unidentifiedHashes = new Set<string>();

  constructor(private readonly deps: CompletionPollerDeps) {}

  /** Boot re-arm of every stranded `importing` row — nothing is in flight
   *  right after a fresh process start. Call once at startup. */
  async init(): Promise<void> {
    await this.deps.historyRepo.resetStatus('importing', 'grabbed');
  }

  // ---------------------------------------------------------------------------
  // ImportCompleted job
  // ---------------------------------------------------------------------------

  async poll(): Promise<void> {
    const clients = await this.deps.clientsRepo.listEnabled();
    const qbitClients = clients.filter((c) => this.deps.driver.supports(c));
    if (!qbitClients.length) {
      log.warn('Import: no enabled download client found');
      return;
    }

    const fetches = await Promise.all(
      qbitClients.map(async (c) => {
        const { ok, torrents } = await this.deps.driver.getTorrentsResult(c);
        return { ok, torrents: torrents.map((t): Torrent => ({ ...t, _clientId: c.id })) };
      }),
    );
    // A failed fetch yields an empty list indistinguishable from a client that
    // genuinely holds nothing. The orphan sweep declares a torrent gone by its
    // absence, so it runs only when every client answered.
    const allClientsResponded = fetches.every((f) => f.ok);
    const allTorrents = fetches.flatMap((f) => f.torrents);
    const torrentClient = new Map(qbitClients.map((c) => [c.id, c]));

    await this.autoMatchOrphanTorrents(allTorrents);

    const grabbed = await this.deps.historyRepo.findByStatuses(['grabbed', 'failed', 'warning']);
    const importing = await this.deps.historyRepo.findByStatuses(['importing']);

    if (allClientsResponded) {
      await this.reconcileOrphanHistory(allTorrents, grabbed, importing);
    }

    await this.emitDownloadProgress(allTorrents);

    const completedTorrents = allTorrents.filter(
      (t) => t.progress >= 1 || t.state === 'seeding' || t.state === 'stalledUP' || t.state === 'stoppedUP',
    );
    if (!completedTorrents.length) return;

    let imported = 0;
    for (const torrent of completedTorrents) {
      const history = await this.deps.historyMatcher.matchAndHeal(torrent, grabbed);
      if (!history) continue;
      if (history.status !== 'grabbed' && history.status !== 'failed' && history.status !== 'warning') continue;

      const client = torrentClient.get(torrent._clientId);
      log.info(`Import: torrent "${torrent.name}" -> history #${history.id} (mediaId=${history.mediaId}, status=${history.status})`);
      try {
        await this.deps.historyRepo.markImporting(history.id);
        if (!client) throw new Error('download client for this torrent is no longer enabled');
        await this.processOne(history, torrent, client);
        imported++;
      } catch (e) {
        const message = (e as Error).message;
        log.error(`Import: FAILED for "${history.sourceTitle}": ${message}`);
        await this.deps.historyRepo.markFailed(history.id, message);
        await this.publishFailed(history, message);
        await this.autoBlocklist(history, `Auto-blocklist: import failed — ${message}`);
      }
    }
    if (imported > 0) log.info(`Import: processed ${imported}/${completedTorrents.length} completed torrent(s)`);
  }

  /**
   * Ported from `autoMatchOrphanTorrents`. Identification is delegated to
   * `releases.match` (see `orphan-matcher.ts`) instead of the original's
   * direct-SQL `TorrentAutoMatcher` — a real behavioural swap, not a
   * like-for-like port (flagged in the port report).
   */
  private async autoMatchOrphanTorrents(allTorrents: readonly Torrent[]): Promise<void> {
    if (!allTorrents.length) return;

    const allHistory = await this.deps.historyRepo.findAll();
    const rowByHash = new Map<string, DownloadHistoryRow>();
    for (const h of allHistory) {
      if (!h.torrentHash) continue;
      const key = h.torrentHash.toLowerCase();
      const kept = rowByHash.get(key);
      if (!kept || outranksForTorrent(h, kept)) rowByHash.set(key, h);
    }
    const linkedTitles = new Set(allHistory.filter((h) => h.mediaId && h.sourceTitle).map((h) => normaliseTorrentName(h.sourceTitle)));

    const candidates = allTorrents.filter((t) => {
      if (!t.hash) return false;
      const existing = rowByHash.get(t.hash.toLowerCase());
      if (!existing) return true; // no row -> candidate (create)
      if (!existing.mediaId) return true; // row but unlinked -> candidate (rebind)
      return false; // already linked -> skip
    });
    if (!candidates.length) {
      this.unidentifiedHashes = new Set();
      return;
    }

    const toIdentify = candidates.filter((t) => !linkedTitles.has(normaliseTorrentName(t.name)));
    if (!toIdentify.length) return;

    const matches = await identifyOrphans(this.deps.host, toIdentify.map((t) => t.name));
    const stillUnidentified = new Set<string>();
    let bound = 0;
    let rebound = 0;

    for (const torrent of toIdentify) {
      const hash = torrent.hash!.toLowerCase();
      const match = matches.get(torrent.name);
      if (!match || match.mediaId == null) {
        stillUnidentified.add(hash);
        const message = `Auto-match: "${torrent.name}" — releases.match found no media for it`;
        if (this.unidentifiedHashes.has(hash)) log.info(message);
        else log.info(message);
        continue;
      }

      const { seasonId, episodeId } = await resolveSeasonEpisodeIds(this.deps.host, match.mediaId, match.seasonNumber, match.episodeNumber);
      const existingRow = rowByHash.get(hash);
      if (existingRow) {
        // No id→quality-name registry host method exists (see port report):
        // heal media/episode/season only, leave the existing quality string as-is.
        await this.deps.historyRepo.healMatch(existingRow.id, {
          mediaId: match.mediaId,
          episodeId,
          seasonId,
          quality: existingRow.quality,
        });
        rebound++;
      } else {
        await this.deps.historyRepo.insertGrab(
          buildGrabHistoryRow({
            mediaId: match.mediaId,
            downloadClientId: torrent._clientId,
            sourceTitle: torrent.name,
            torrentHash: torrent.hash,
            // Orphan binding has no release object to derive a quality from —
            // flagged gap, see the port report.
            quality: 'unknown',
            grabSource: 'manual',
            episodeId,
            seasonId,
          }),
        );
        bound++;
      }
    }
    this.unidentifiedHashes = stillUnidentified;
    if (bound || rebound) log.info(`Auto-match: done — ${bound} created, ${rebound} healed`);
  }

  /** Ported from `reconcileOrphanHistory` — verbatim rule set. */
  private async reconcileOrphanHistory(allTorrents: readonly Torrent[], grabbed: DownloadHistoryRow[], importing: DownloadHistoryRow[]): Promise<void> {
    if (!grabbed.length && !importing.length) return;
    const candidates = [...grabbed, ...importing];
    const torrentByHistoryId = new Map<number, Torrent>();
    for (const t of allTorrents) {
      const m = this.deps.historyMatcher.findMatch(t, candidates);
      if (m) torrentByHistoryId.set(m.history.id, t);
    }
    const matchedHistoryIds = new Set(torrentByHistoryId.keys());
    let changed = false;

    const restarted = importing.filter((h) => {
      const t = torrentByHistoryId.get(h.id);
      return t != null && t.progress < 1;
    });
    if (restarted.length) {
      await this.deps.historyRepo.updateStatusByIds(restarted.map((h) => h.id), 'grabbed', null);
      changed = true;
      log.warn(`Import: ${restarted.length} importing entries whose torrent is no longer complete — re-armed as grabbed`);
    }

    const revived = grabbed.filter((h) => h.status === 'failed' && h.statusMessage === ORPHAN_STATUS_MESSAGE && matchedHistoryIds.has(h.id));
    if (revived.length) {
      await this.deps.historyRepo.updateStatusByIds(revived.map((h) => h.id), 'grabbed', null);
      changed = true;
      log.info(`Import: ${revived.length} entries reappeared in the download client — cleared the orphan stamp`);
    }

    const cutoff = Date.now() - ORPHAN_GRACE_MS;
    const expired = candidates.filter(
      (h) => (h.status === 'grabbed' || h.status === 'importing') && !matchedHistoryIds.has(h.id) && new Date(h.updatedAt).getTime() < cutoff,
    );
    if (expired.length) {
      await this.deps.historyRepo.updateStatusByIds(expired.map((h) => h.id), 'failed', ORPHAN_STATUS_MESSAGE);
      changed = true;
      log.warn(`Import: ${expired.length} grabbed/importing entries lost their torrent for > ${ORPHAN_GRACE_MS / 60_000}min — marked failed`);
    }

    if (changed) await this.deps.host.call('events.publish', [{ type: 'acquisition.queue.changed' }]);
  }

  /**
   * Ported from `emitDownloadProgress`. Season/episode number is omitted from
   * the `progress.set` call: the row only carries season/episode **ids**, and
   * resolving numbers would need `media.resolve`, whose response-key format
   * for a mixed media/season/episode-id batch is unspecified in
   * `src/host-methods.ts`. Taking the smaller option per the brief: whole-media
   * progress still works, series just lose per-episode progress-clearing
   * granularity — flagged in the port report, not guessed at.
   */
  private async emitDownloadProgress(allTorrents: readonly Torrent[]): Promise<void> {
    const downloading = allTorrents.filter((t) => t.progress < 1);
    if (!downloading.length) return;
    const rows = await this.deps.historyRepo.findByStatuses(['grabbed', 'importing']);
    if (!rows.length) return;

    for (const t of downloading) {
      const history = await this.deps.historyMatcher.matchAndHeal(t, rows);
      if (!history?.mediaId) continue;
      await this.deps.host.call('progress.set', {
        mediaId: history.mediaId,
        ref: t.hash,
        progress: t.progress,
        bytesPerSecond: t.dlspeed,
        etaSeconds: t.eta > 0 && t.eta < 8_640_000 ? t.eta : undefined,
        state: torrentProgressState(t),
      });
    }
  }

  /**
   * Ported from `processOne`. Everything past "which files are video" —
   * destination resolution, the ingest-root allowlist, folder naming,
   * post-import markers/thumbnails/scripts — is core's job now via
   * `library.ingest`; this plugin only decides which files are candidates and
   * records the outcome. Marker detection / thumbnail generation / the
   * post-import shell script are assumed to be core's responsibility inside
   * `library.ingest` now (side effects of "a file landed in the library",
   * which core alone performs) — not re-invoked here, and not verified
   * against core source (out of scope, read-only).
   */
  private async processOne(history: DownloadHistoryRow, torrent: Torrent, client: DownloadClientRow): Promise<void> {
    const files = await this.deps.driver.getTorrentFiles(client, torrent.hash);
    const videoFiles = files
      .filter((f) => f.progress >= 1 && VIDEO_EXTS.has(path.extname(f.name).toLowerCase()))
      .map((f) => path.join(torrent.save_path ?? '', f.name));

    if (!videoFiles.length) {
      const statusMessage = `Import failed: no valid video file in the download "${torrent.name}"`;
      log.warn(`Import[${history.sourceTitle}]: ${statusMessage}`);
      await this.deps.historyRepo.markFailed(history.id, statusMessage);
      await this.autoBlocklist(history, 'Auto-blocklist: no valid video file in the download');
      try {
        await this.deps.driver.deleteTorrent(client, torrent.hash, true);
      } catch (e) {
        log.warn(`Import[${history.sourceTitle}]: failed to remove dud torrent: ${(e as Error).message}`);
      }
      await this.publishFailed(history, statusMessage);
      return;
    }

    if (history.mediaId == null) {
      await this.deps.historyRepo.markFailed(history.id, 'Import failed: no media linked to this download');
      return;
    }

    const result = await this.deps.host.call('library.ingest', {
      idempotencyKey: `download-history:${history.id}`,
      mediaId: history.mediaId,
      paths: videoFiles,
      transfer: 'copy',
      sourceLabel: history.sourceTitle,
    });

    if (!result.imported.length) {
      const statusMessage = `Import failed: no file could be placed under the library root for "${torrent.name}"`;
      log.error(`Import[${history.sourceTitle}]: ${statusMessage}`);
      await this.deps.historyRepo.markFailed(history.id, statusMessage);
      await this.publishFailed(history, statusMessage);
      return;
    }

    // Episode/season reconciliation against the imported files (upstream
    // re-pointed the row from what actually landed) is not re-derived here:
    // `library.ingest`'s response carries season/episode NUMBERS, not the ids
    // this row's columns store, and no host method resolves number -> id.
    // Whatever seasonId/episodeId the row already carries from grab time (or
    // the orphan-match best-effort lookup) is left as-is — flagged gap.
    await this.deps.historyRepo.completeImport(history.id);
    log.info(`Import[${history.sourceTitle}]: completed successfully (${result.imported.length} file(s))`);

    await this.deps.host.call('events.publish', [
      {
        type: 'acquisition.imported',
        mediaId: history.mediaId,
        seasonNumber: result.seasonNumber,
        episodeNumber: result.episodeNumber,
        quality: history.quality,
        sourceTitle: history.sourceTitle,
      },
    ]);
  }

  // ---------------------------------------------------------------------------
  // CleanStalled job
  // ---------------------------------------------------------------------------

  /**
   * Ported from `cleanStalledTorrents`. Gated by {@link getStallConfig} —
   * `samples` unset (every fresh install, and every install today: no
   * manifest config field exists for it yet) returns before touching any
   * client. Every `getTorrentsResult` call below is gated on `ok`: an
   * unreachable client must never be treated as "holds nothing", which is
   * exactly the destructive-path risk this job carries (it deletes torrents
   * and their files).
   */
  async cleanStalled(): Promise<void> {
    await this.pruneOldStalledChecks();

    const stallConfig = await getStallConfig(this.deps.host);
    if (!stallConfig) return;

    const clients = await this.deps.clientsRepo.listEnabled();
    const qbitClients = clients.filter((c) => this.deps.driver.supports(c));
    if (!qbitClients.length) return;

    const histories = await this.deps.historyRepo.findByStatuses(['grabbed', 'failed', 'warning', 'importing']);
    const mediaToResearch = new Set<number>();
    const now = Date.now();

    for (const client of qbitClients) {
      const { ok, torrents } = await this.deps.driver.getTorrentsResult(client);
      if (!ok) continue; // unreachable this tick — never treat as "holds nothing"

      const downloading = torrents.filter((t) => t.progress < 1 && t.hash && t.hash.length > 0 && STALL_ELIGIBLE_STATES.has(t.state));
      if (!downloading.length) continue;

      for (const t of downloading) {
        const history = await this.deps.historyMatcher.matchAndHeal(t, histories);
        if (!history) continue; // untracked torrent — not our business

        const stalled = await this.evaluateStalled(t, stallConfig, now);
        if (!stalled) continue;

        log.warn(`StalledCleanup: "${t.name}" stalled (samples=${stallConfig.samples}, interval=${stallConfig.intervalMinutes}m)`);
        try {
          await this.deps.driver.deleteTorrent(client, t.hash, true);
        } catch (e) {
          log.error(`StalledCleanup: failed to delete "${t.name}": ${(e as Error).message}`);
          continue;
        }

        await this.deps.stalledChecksRepo.deleteByHash(t.hash);
        await this.deps.host.call('events.publish', [{ type: 'acquisition.queue.changed' }]);
        await this.autoBlocklist(history, 'Auto-blocklist: stalled torrent');
        await this.deps.historyRepo.markFailed(history.id, 'Stalled — removed by stalled-download cleanup');

        const shouldRestart = stallConfig.autoRestart && (history.grabSource === 'auto' || stallConfig.includeManualGrabs);
        if (shouldRestart && history.mediaId != null) mediaToResearch.add(history.mediaId);
      }
    }

    if (mediaToResearch.size > 0) {
      log.info(`StalledCleanup: searching for a replacement for ${mediaToResearch.size} media(s)`);
      await this.deps.searchMissing(Array.from(mediaToResearch));
    }
  }

  private async evaluateStalled(torrent: ClientTorrent, config: { samples: number; intervalMinutes: number }, now: number): Promise<boolean> {
    const hash = torrent.hash;
    const currentBytes = torrent.downloaded ?? 0;

    const latest = await this.deps.stalledChecksRepo.findLatest(hash);
    const intervalMs = config.intervalMinutes * 60_000;
    const shouldSnapshot = !latest || now - new Date(latest.checkedAt).getTime() >= intervalMs;
    if (shouldSnapshot) await this.deps.stalledChecksRepo.insert(hash, currentBytes);

    const recent = await this.deps.stalledChecksRepo.findRecent(hash, config.samples);
    if (recent.length < config.samples) return false;
    return countStalledStrikes(recent) >= config.samples;
  }

  /** Deletes stalled-check rows older than 24h. Assumes every profile's
   *  detection window (`(samples - 1) x interval`) stays under 24h. */
  private async pruneOldStalledChecks(): Promise<void> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    await this.deps.stalledChecksRepo.pruneOlderThan(cutoff);
  }

  // ---------------------------------------------------------------------------
  // CleanSeeded job
  // ---------------------------------------------------------------------------

  /**
   * Removes a finished torrent once its indexer's seed target is met: either
   * `maxRetentionDays` since the download completed, or `seedRatio` reached. Retention is
   * checked first so a long-seeding torrent leaves on time rather than waiting for a ratio
   * it may never reach.
   */
  async cleanSeeded(): Promise<void> {
    const clients = await this.deps.clientsRepo.listEnabled();
    const qbitClients = clients.filter((c) => this.deps.driver.supports(c));
    if (!qbitClients.length) return;

    const allTorrents: { client: (typeof clients)[number]; torrent: ClientTorrent }[] = [];
    for (const client of qbitClients) {
      const { ok, torrents } = await this.deps.driver.getTorrentsResult(client);
      if (!ok) continue; // unreachable this tick — never treat as "holds nothing"
      for (const torrent of torrents) allTorrents.push({ client, torrent });
    }
    if (!allTorrents.length) return;

    const torrentMap = new Map(allTorrents.map((e) => [e.torrent.hash.toLowerCase(), e]));
    const completed = await this.deps.historyRepo.findCompletedByHashes([...torrentMap.keys()]);
    if (!completed.length) return;

    const indexers = await this.deps.indexersRepo.listAll();
    const indexerMap = new Map(indexers.map((ix) => [ix.id, ix]));
    let deleted = false;

    for (const history of completed) {
      const entry = torrentMap.get(history.torrentHash!.toLowerCase());
      if (!entry) continue; // torrent already removed

      const { client, torrent } = entry;
      const indexer = history.indexerId ? indexerMap.get(history.indexerId) : undefined;
      const settings = indexer?.settings ?? {};
      const reason = this.seedCleanupReason(torrent, settings);
      if (!reason) continue;

      log.info(`SeedCleanup: removing "${torrent.name}" (${reason})`);
      try {
        await this.deps.driver.deleteTorrent(client, torrent.hash, true);
        deleted = true;
      } catch (e) {
        log.error(`SeedCleanup: failed to delete "${torrent.name}": ${(e as Error).message}`);
      }
    }

    if (deleted) await this.deps.host.call('events.publish', [{ type: 'acquisition.queue.changed' }]);
  }

  /** Empty means keep seeding. A torrent whose client reports no completion time is judged on
   *  ratio alone: the age of an unknown finish is unknowable, not zero. */
  private seedCleanupReason(torrent: ClientTorrent, settings: Record<string, unknown>): string {
    const maxRetentionDays = settings['maxRetentionDays'] != null ? Number(settings['maxRetentionDays']) : null;
    const completedAt = Number(torrent.completion_on ?? 0);
    if (maxRetentionDays != null && maxRetentionDays > 0 && completedAt > 0) {
      const ageDays = (Date.now() / 1000 - completedAt) / 86_400;
      if (ageDays >= maxRetentionDays) return `retention ${Math.round(ageDays)}d >= ${maxRetentionDays}d`;
    }
    const targetRatio = Number(settings['seedRatio'] ?? 1);
    if (torrent.ratio >= targetRatio) return `ratio ${torrent.ratio.toFixed(2)} >= ${targetRatio}`;
    return '';
  }

  // ---------------------------------------------------------------------------

  private async publishFailed(history: DownloadHistoryRow, reason: string): Promise<void> {
    if (history.mediaId == null) return; // AcquisitionEvent.acquisition.failed requires a mediaId
    await this.deps.host.call('events.publish', [
      { type: 'acquisition.failed', mediaId: history.mediaId, title: history.sourceTitle, reason },
    ]);
  }

  /**
   * The plugin owns the `blocklist` table outright (`src/host-methods.ts` has
   * no blocklist host method — core deleted `blocklist.add`/`blocklist.check`
   * when the table moved here), so this is a single local write, simpler than
   * the host round trip it replaces: no RPC, no idempotency key, no scope.
   * `BlocklistRepository.insert`'s own doc-comment names this exact call
   * site. Swallows a failure exactly like upstream's own
   * `try { createFromHistory(...) } catch { /* already blocklisted *\/ }`.
   */
  private async autoBlocklist(history: DownloadHistoryRow, note: string): Promise<void> {
    const indexer = history.indexerId != null ? await this.deps.indexersRepo.findById(history.indexerId).catch(() => null) : null;
    try {
      await this.deps.blocklistRepo.insert({
        sourceTitle: history.sourceTitle,
        quality: history.quality ?? null,
        mediaId: history.mediaId ?? null,
        indexerId: history.indexerId ?? null,
        indexerName: indexer?.name ?? null,
        note,
      });
    } catch {
      // Already blocklisted locally — ignore, matches upstream's swallow.
    }
  }
}
