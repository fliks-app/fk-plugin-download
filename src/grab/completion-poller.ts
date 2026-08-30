import * as path from 'path';
import type { DownloadClientDriver, ClientTorrent } from '../download-clients/contract';
import type { DownloadClientsRepository, IndexersRepository, DownloadHistoryRepository, StalledChecksRepository, BlocklistRepository } from '../db/repositories';
import type { DownloadHistoryRow, DownloadClientRow } from '../db/rows';
import type { HostCaller } from './types';
import { HostCallError, type HostParams } from '../host-client';
import { TorrentHistoryMatcher, normaliseTorrentName, outranksForTorrent } from './torrent-name-matcher';
import { identifyOrphans, resolveSeasonEpisodeIds } from './orphan-matcher';
import { buildGrabHistoryRow } from './grab-history';

type ProgressDownload = HostParams<'progress.set'>['downloads'][number];

/** What a queue control asks the download client to become, so the wait knows when it is over. */
export type ControlOutcome = 'paused' | 'running' | 'absent';

/** qBittorrent answers a stop/start/delete before libtorrent has caught up: measured at up to
 *  ~2s against a real client. Publishing on the acknowledgement stated the state that was just
 *  changed, and nothing corrected it until the next poll. */
const CONTROL_SETTLE_TIMEOUT_MS = 4_000;
const CONTROL_SETTLE_INTERVAL_MS = 300;
import { getStallConfig, type StallConfig } from './stall-config';
import { countStalledStrikes, STALL_ELIGIBLE_STATES } from '../download-clients/stalled-progress';
import { torrentProgressState } from './progress-state';
import { log } from '../log';

/** Ported from `common/constants/video-extensions.ts` — small and stable
 *  enough to inline rather than add a file for it. */
/** Core allows 30 minutes for an ingest; wait past that so its error frame is what we see. */
const INGEST_CALL_TIMEOUT_MS = 31 * 60_000;

const VIDEO_EXTS: ReadonlySet<string> = new Set(['.mkv', '.mp4', '.avi', '.mov', '.ts', '.m2ts', '.wmv', '.flv']);

/** How long a `grabbed`/`importing` row may stay without a matching torrent
 *  before it's marked `failed`. Ported verbatim from `completion.service.ts`. */
const ORPHAN_GRACE_MS = 5 * 60_000;

/** Stamp the orphan sweep writes, recognised on the way back in so a
 *  reappearing torrent clears it rather than leaving a stale message next to
 *  a torrent the client is still reporting. */
const ORPHAN_STATUS_MESSAGE = 'Torrent no longer present in download client';

/** `media.resolve` caps a call at 100 ids (core's `QUEUE_PAGE_SIZE_MAX`). */
const RESOLVE_BATCH = 50;

/** Season/episode numbers behind a history row's core ids. */
interface ScopeNumbers {
  seasonNumber?: number;
  episodeNumber?: number;
}

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
  /** History-row id → season/episode numbers. Ids never change number, and
   *  this is read on every poll. */
  private readonly scopeCache = new Map<number, ScopeNumbers>();
  /** Media whose set was published on the previous tick. A media missing from the next one
   *  needs an empty snapshot so its viewers stop holding the last set they saw. */
  private reportedMediaIds = new Set<number>();

  /** Nothing was published yet this process, but a viewer may still hold a snapshot from
   *  before a restart. The first tick therefore states every in-flight media's set, empty
   *  included, which is what keeps the model from depending on a field that a restart clears. */
  private firstProgressTick = true;

  constructor(private readonly deps: CompletionPollerDeps) {}

  /** Every enabled client's torrents in one read, with whether all of them answered. A failed
   *  fetch yields an empty list indistinguishable from a client that genuinely holds nothing,
   *  and several callers turn on telling those apart. */
  private async fetchAllTorrents(): Promise<{ torrents: Torrent[]; allOk: boolean }> {
    const clients = (await this.deps.clientsRepo.listEnabled()).filter((c) => this.deps.driver.supports(c));
    const fetches = await Promise.all(
      clients.map(async (c) => {
        const { ok, torrents } = await this.deps.driver.getTorrentsResult(c);
        return { ok, torrents: torrents.map((t): Torrent => ({ ...t, _clientId: c.id })) };
      }),
    );
    return { torrents: fetches.flatMap((f) => f.torrents), allOk: fetches.every((f) => f.ok) };
  }

  /** Whether the client now reflects the control that was issued. A torrent that is gone is
   *  nothing to keep waiting on, whatever was expected of it. */
  private reached(torrents: readonly Torrent[], hash: string, expect: ControlOutcome): boolean {
    const torrent = torrents.find((t) => t.hash.toLowerCase() === hash.toLowerCase());
    if (!torrent) return true;
    if (expect === 'absent') return false;
    const state = torrentProgressState(torrent);
    return expect === 'paused' ? state === 'paused' : state !== 'paused';
  }

  /**
   * Wait for the client to reflect a control the operator just issued, then state that media's
   * set from the same read. One loop, not a settle loop followed by a second fetch: the read
   * that decides the wait is over is the read the snapshot is built from.
   *
   * The budget running out still publishes. The control itself succeeded, so a slow client
   * delays the confirmation rather than turning it into an error.
   */
  async settleAndPublish(row: DownloadHistoryRow, expect: ControlOutcome): Promise<void> {
    if (row.mediaId == null || !row.torrentHash) return;
    const deadline = Date.now() + CONTROL_SETTLE_TIMEOUT_MS;
    for (;;) {
      const { torrents, allOk } = await this.fetchAllTorrents();
      if (this.reached(torrents, row.torrentHash, expect) || Date.now() >= deadline) {
        await this.publishOne(row.mediaId, torrents, allOk);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, CONTROL_SETTLE_INTERVAL_MS));
    }
  }

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

    // The orphan sweep declares a torrent gone by its absence, so it runs only when every
    // client answered — see `fetchAllTorrents`.
    const { torrents: allTorrents, allOk: allClientsResponded } = await this.fetchAllTorrents();
    const torrentClient = new Map(qbitClients.map((c) => [c.id, c]));

    await this.autoMatchOrphanTorrents(allTorrents);

    const grabbed = await this.deps.historyRepo.findByStatuses(['grabbed', 'failed', 'warning']);
    const importing = await this.deps.historyRepo.findByStatuses(['importing']);

    if (allClientsResponded) {
      await this.reconcileOrphanHistory(allTorrents, grabbed, importing);
    }

    await this.emitDownloadProgress(allTorrents, allClientsResponded);

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
      if (!client) {
        // A disabled client is a reversible config state, not a bad release — never blocklist for it.
        const message = 'download client for this torrent is no longer enabled';
        log.warn(`Import: "${history.sourceTitle}" — ${message}; will retry`);
        await this.deps.historyRepo.updateStatusByIds([history.id], 'grabbed', message);
        continue;
      }
      try {
        await this.deps.historyRepo.markImporting(history.id);
        await this.processOne(history, torrent, client);
        imported++;
      } catch (e) {
        const message = (e as Error).message;
        if (e instanceof HostCallError && e.outcome === 'unknown') {
          // Core may have already done the work (e.g. a `library.ingest` timeout) — the next
          // pass retries via the same idempotency key rather than blocklisting a good release.
          log.warn(`Import: "${history.sourceTitle}" — core did not confirm (${message}); will retry`);
          await this.deps.historyRepo.updateStatusByIds([history.id], 'grabbed', message);
          continue;
        }
        // An error from core reports core's own state (a full disk, a missing root), never a
        // verdict on the release — the blocklist is left to the branches that inspect the files.
        log.error(`Import: FAILED for "${history.sourceTitle}": ${message}`);
        await this.deps.historyRepo.markFailed(history.id, message);
        await this.publishFailed(history, message);
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

    // Bounded to the hashes in front of us: `download_history` is append-only and this runs
    // every minute, so reading it whole was the cost of the job on a mature install.
    const rowsForHashes = await this.deps.historyRepo.findByTorrentHashes(
      allTorrents.map((t) => t.hash).filter((h): h is string => !!h),
    );
    const rowByHash = new Map<string, DownloadHistoryRow>();
    for (const h of rowsForHashes) {
      if (!h.torrentHash) continue;
      const key = h.torrentHash.toLowerCase();
      const kept = rowByHash.get(key);
      if (!kept || outranksForTorrent(h, kept)) rowByHash.set(key, h);
    }

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

    // Only reached with something new in the client — the steady state never pays for it.
    const linkedTitles = new Set((await this.deps.historyRepo.listLinkedSourceTitles()).map(normaliseTorrentName));
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
        // Reported on a previous tick already — saying it again every minute buries the rest of the log.
        if (!this.unidentifiedHashes.has(hash)) {
          log.info(`Auto-match: "${torrent.name}" — releases.match found no media for it`);
        }
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
            size: torrent.size,
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

    if (changed) {
      await this.deps.host
        .call('events.publish', [{ type: 'acquisition.queue.changed' }])
        .catch((e: Error) => log.warn(`Import: queue-changed publish failed: ${e.message}`));
    }
  }

  /**
   * Season/episode numbers for a batch of history rows, which carry core **ids**
   * only. Cached for the process: an id's number never changes, and this runs
   * on every poll.
   */
  private async scopeNumbers(
    rows: readonly DownloadHistoryRow[],
  ): Promise<Map<number, ScopeNumbers>> {
    const wanted = rows.filter((r) => !this.scopeCache.has(r.id) && (r.episodeId != null || r.seasonId != null));
    if (wanted.length) {
      const seasonIds = [...new Set(wanted.filter((r) => r.episodeId == null).map((r) => r.seasonId!))];
      const episodeIds = [...new Set(wanted.filter((r) => r.episodeId != null).map((r) => r.episodeId!))];
      for (let i = 0; i < Math.max(seasonIds.length, episodeIds.length); i += RESOLVE_BATCH) {
        const batch = { seasonIds: seasonIds.slice(i, i + RESOLVE_BATCH), episodeIds: episodeIds.slice(i, i + RESOLVE_BATCH) };
        if (!batch.seasonIds.length && !batch.episodeIds.length) break;
        const resolved = await this.deps.host.call('media.resolve', batch).catch((e: Error) => {
          log.warn(`Import: scope resolve failed: ${e.message}`);
          return {} as Record<string, { seasonNumber?: number; episodeNumber?: number }>;
        });
        for (const r of wanted) {
          // Keys are `season:<id>` / `episode:<id>` — see core's `mediaResolve`.
          const hit = r.episodeId != null ? resolved[`episode:${r.episodeId}`] : resolved[`season:${r.seasonId}`];
          if (hit) this.scopeCache.set(r.id, { seasonNumber: hit.seasonNumber, episodeNumber: hit.episodeNumber });
        }
      }
    }
    const out = new Map<number, ScopeNumbers>();
    for (const r of rows) out.set(r.id, this.scopeCache.get(r.id) ?? {});
    return out;
  }

  /**
   * Publish each media's complete set of in-flight downloads. A replacement, not a delta:
   * whatever a media no longer has is retired by its absence, which is why no compensating
   * "this one vanished" push is needed any more.
   *
   * Skipped outright when a client did not answer. Its empty list is indistinguishable from a
   * client that genuinely holds nothing, and a snapshot built from it would assert that every
   * torrent it holds is gone. A missed tick shows a stale percentage; a wrong snapshot erases
   * live downloads from every viewer's screen.
   *
   * Season/episode numbers are resolved from the row's ids so a series download is attributed to
   * the episode it belongs to: without them every download reads as whole-media progress, which
   * shows the badge on every episode page of the show.
   */
  /** What every media currently has in flight, from one read of the clients. The one place that
   *  answers "what is this media downloading": two builders drifting apart is the whole class of
   *  bug the snapshot shape exists to close. */
  private async buildSets(
    allTorrents: readonly Torrent[],
  ): Promise<{ byMedia: Map<number, ProgressDownload[]>; rows: DownloadHistoryRow[] }> {
    const rows = await this.deps.historyRepo.findByStatuses(['grabbed', 'importing']);

    // A torrent at 100% is filtered out, except while its row says importing: the flip to
    // `importing` is the last thing a viewer sees before the import badge takes over.
    const importingHashes = new Set(
      rows.filter((r) => r.status === 'importing' && r.torrentHash).map((r) => r.torrentHash!.toLowerCase()),
    );
    const reportable = allTorrents.filter((t) => t.progress < 1 || importingHashes.has(t.hash.toLowerCase()));

    const matched: { torrent: Torrent; history: DownloadHistoryRow }[] = [];
    for (const t of reportable) {
      const history = await this.deps.historyMatcher.matchAndHeal(t, rows);
      if (history?.mediaId) matched.push({ torrent: t, history });
    }
    const scopes = await this.scopeNumbers(matched.map((m) => m.history));

    const byMedia = new Map<number, ProgressDownload[]>();
    for (const { torrent: t, history } of matched) {
      const scope = scopes.get(history.id) ?? {};
      const list = byMedia.get(history.mediaId!) ?? [];
      list.push({
        ref: t.hash,
        seasonNumber: scope.seasonNumber,
        episodeNumber: scope.episodeNumber,
        progress: t.progress,
        bytesPerSecond: t.dlspeed,
        etaSeconds: t.eta > 0 && t.eta < 8_640_000 ? t.eta : undefined,
        // The row is authoritative once it says importing: the client reports a finished
        // torrent as seeding, which this mapping reads as `active`.
        state: history.status === 'importing' ? 'importing' : torrentProgressState(t),
      });
      byMedia.set(history.mediaId!, list);
    }
    return { byMedia, rows };
  }

  /**
   * State one media's set. Not a tick: it says nothing about any other media, and touches none
   * of the tick's bookkeeping. At worst the next tick re-states an empty set it already sent.
   */
  private async publishOne(mediaId: number, allTorrents: readonly Torrent[], allClientsResponded: boolean): Promise<void> {
    if (!allClientsResponded) return;
    const { byMedia } = await this.buildSets(allTorrents);
    await this.publishSet(mediaId, byMedia.get(mediaId) ?? []);
  }

  /**
   * State every media's complete set. A replacement, not a delta: whatever a media no longer has
   * is retired by its absence, which is why no compensating "this one vanished" push exists.
   *
   * Skipped outright when a client did not answer. A snapshot built from a partial read would
   * assert that every torrent that client holds is gone. A missed tick shows a stale percentage;
   * a wrong snapshot erases live downloads from every viewer's screen.
   *
   * Season/episode numbers come from the row's ids so a series download is attributed to the
   * episode it belongs to: without them every download reads as whole-media progress, which
   * shows the badge on every episode page of the show.
   */
  private async emitDownloadProgress(allTorrents: readonly Torrent[], allClientsResponded: boolean): Promise<void> {
    if (!allClientsResponded) return;
    const { byMedia, rows } = await this.buildSets(allTorrents);

    // A media that had downloads last tick and has none now must be told so, or its viewers keep
    // the last set they saw. On the first tick of the process that memory is gone, so the rows
    // stand in for it: every media with an in-flight row is stated once, empty included.
    const owed = this.firstProgressTick
      ? rows.flatMap((r) => (r.mediaId != null ? [r.mediaId] : []))
      : [...this.reportedMediaIds];
    for (const mediaId of owed) {
      if (!byMedia.has(mediaId)) byMedia.set(mediaId, []);
    }
    this.firstProgressTick = false;
    this.reportedMediaIds = new Set([...byMedia].filter(([, list]) => list.length).map(([id]) => id));

    for (const [mediaId, downloads] of byMedia) await this.publishSet(mediaId, downloads);
  }

  /** A progress push is cosmetic; the import hand-off runs after it and must not be lost with it. */
  private async publishSet(mediaId: number, downloads: ProgressDownload[]): Promise<void> {
    await this.deps.host
      .call('progress.set', { mediaId, downloads })
      .catch((e: Error) => log.warn(`Import: progress publish failed: ${e.message}`));
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
    const { ok, files } = await this.deps.driver.getTorrentFilesResult(client, torrent.hash);
    if (!ok) {
      // Could not ask the client, not "no files" — never blocklist/delete on this, only retry.
      const message = `could not list files for "${torrent.name}"`;
      log.warn(`Import[${history.sourceTitle}]: ${message}; will retry`);
      await this.deps.historyRepo.updateStatusByIds([history.id], 'grabbed', message);
      return;
    }
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

    const result = await this.deps.host.call(
      'library.ingest',
      {
        idempotencyKey: `download-history:${history.id}`,
        mediaId: history.mediaId,
        paths: videoFiles,
        transfer: 'copy',
        sourceLabel: history.sourceTitle,
      },
      // Longer than core's own deadline for this method: copying a release is not a lookup, and
      // giving up first would record a failure while core is still writing.
      INGEST_CALL_TIMEOUT_MS,
    );

    // A retried ingest writes nothing because the file is already in place. Core says which paths
    // those were; without that this reads exactly like "nothing could be placed".
    if (!result.imported.length && result.alreadyPresent.length) {
      log.info(`Import[${history.sourceTitle}]: already in the library — completing the row`);
      await this.deps.historyRepo.completeImport(history.id);
      await this.publishImported(history, result);
      return;
    }

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
    await this.publishImported(history, result);
  }

  /** Notify-only, same swallow as {@link publishFailed} — the row is already `completed`. */
  private async publishImported(history: DownloadHistoryRow, result: { seasonNumber?: number; episodeNumber?: number }): Promise<void> {
    if (history.mediaId == null) return; // AcquisitionEvent.acquisition.imported requires a mediaId
    try {
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
    } catch (e) {
      log.warn(`Import[${history.sourceTitle}]: failed to publish acquisition.imported: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // CleanStalled job
  // ---------------------------------------------------------------------------

  /**
   * Ported from `cleanStalledTorrents`. Gated by {@link getStallConfig} —
   * `samples` unset (every fresh install) returns before touching any
   * client. Every `getTorrentsResult` call below is gated on `ok`: an
   * unreachable client must never be treated as "holds nothing", which is
   * exactly the destructive-path risk this job carries (it deletes torrents
   * and their files).
   */
  async cleanStalled(): Promise<void> {
    const stallConfig = await getStallConfig(this.deps.host);
    if (!stallConfig) return;

    // After the config, not before: the horizon has to cover the window the config asks for.
    await this.pruneOldStalledChecks(stallConfig);

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
        // Blocklist + markFailed before the notify: a failed publish must not skip recording that.
        await this.autoBlocklist(history, 'Auto-blocklist: stalled torrent');
        await this.deps.historyRepo.markFailed(history.id, 'Stalled — removed by stalled-download cleanup');
        await this.deps.host.call('events.publish', [{ type: 'acquisition.queue.changed' }]).catch((e: Error) =>
          log.warn(`StalledCleanup: failed to publish acquisition.queue.changed: ${e.message}`),
        );

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

  /**
   * Drops stalled-check rows the configured window can no longer reach. A fixed 24h horizon
   * assumed a detection window under a day and enforced nothing: at one snapshot per interval,
   * only `1440 / interval` rows survived, so `evaluateStalled`'s `recent.length >= samples` could
   * never be met for a longer profile — 3 samples every 12h, or anything hourly past 24 samples,
   * left cleanup permanently inert with no log, reading as "not stalled long enough yet".
   */
  private async pruneOldStalledChecks(config: StallConfig): Promise<void> {
    const windowMs = (config.samples + 1) * config.intervalMinutes * 60_000;
    const cutoff = new Date(Date.now() - Math.max(24 * 60 * 60_000, windowMs)).toISOString();
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

  /** Notify-only: the failure was already recorded locally, so a failed publish must
   *  never abort the caller's remaining cleanup or read as a fresh, unresolved failure. */
  private async publishFailed(history: DownloadHistoryRow, reason: string): Promise<void> {
    if (history.mediaId == null) return; // AcquisitionEvent.acquisition.failed requires a mediaId
    try {
      await this.deps.host.call('events.publish', [
        { type: 'acquisition.failed', mediaId: history.mediaId, title: history.sourceTitle, reason },
      ]);
    } catch (e) {
      log.warn(`Import[${history.sourceTitle}]: failed to publish acquisition.failed: ${(e as Error).message}`);
    }
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
