import { decodeHtmlEntities } from '../indexers/decode-html-entities';
import type { DownloadHistoryRow } from '../db/rows';
import type { DownloadHistoryRepository } from '../db/repositories';
import { log } from '../log';

/** A subset of `ClientTorrent` — all the matcher actually needs. */
export interface MatchableTorrent {
  hash?: string | null;
  name: string;
}

export type MatchedBy = 'hash' | 'exact-name' | 'unique-prefix';

export interface HistoryMatch {
  history: DownloadHistoryRow;
  matchedBy: MatchedBy;
}

const LIVE_STATUSES = new Set(['grabbed', 'importing']);

/**
 * Ported from `backend/src/plugins/download/torrent-history-matcher.service.ts`.
 * Single source of truth for "which `download_history` row does this torrent
 * belong to" — the completion poller's orphan sweep, stalled-cleanup and
 * seeded-cleanup all key off it rather than each inlining their own
 * hash/name comparison.
 *
 * Several rows can legitimately describe one torrent (re-grabbing a release
 * already in the client adds a row but no new torrent — the client
 * deduplicates by hash), so ranking them is mandatory: a media-linked row
 * outranks a media-less one, a live status outranks a terminal one, and the
 * most recent row breaks a tie.
 */
function authorityRank(h: DownloadHistoryRow): number {
  return (h.mediaId ? 2 : 0) + (LIVE_STATUSES.has(h.status) ? 1 : 0);
}

/** Whether `candidate` speaks for the torrent over `current`. */
export function outranksForTorrent(candidate: DownloadHistoryRow, current: DownloadHistoryRow): boolean {
  const delta = authorityRank(candidate) - authorityRank(current);
  return delta > 0 || (delta === 0 && candidate.id > current.id);
}

function pickAuthoritative(rows: DownloadHistoryRow[]): DownloadHistoryRow | null {
  let best: DownloadHistoryRow | null = null;
  for (const h of rows) {
    if (!best || outranksForTorrent(h, best)) best = h;
  }
  return best;
}

/**
 * Tolerant normalisation for the "is this the same release?" comparison:
 *  - HTML entities decoded (qBittorrent decodes entities on display while the
 *    indexer's raw title, stored as `sourceTitle`, keeps them).
 *  - Trailing `.torrent` stripped.
 *  - `.`, `_`, multi-space all collapsed to single spaces.
 *  - Lowercased.
 */
export function normaliseTorrentName(raw: string): string {
  if (!raw) return '';
  let s = decodeHtmlEntities(raw);
  s = s.replace(/\.torrent$/i, '');
  s = s.replace(/[._\s]+/g, ' ').trim();
  return s.toLowerCase();
}

/**
 * Rules, in order:
 *  1. `history.torrentHash === torrent.hash` — definitive.
 *  2. Histories whose normalised `sourceTitle` equals the normalised
 *     `torrent.name` — the same release.
 *  3. Exactly one history whose normalised `sourceTitle` is a prefix of the
 *     normalised `torrent.name` (or vice-versa). Multiple candidates abort —
 *     distinct releases can overlap by prefix, so picking one would
 *     cross-match them.
 */
export class TorrentHistoryMatcher {
  /** Normalising candidate titles is this matcher's whole cost, and every
   *  caller walks the same row array once per torrent. Keyed by row, so a
   *  fresh query's rows drop out on their own. */
  private readonly normalisedTitles = new WeakMap<DownloadHistoryRow, string>();

  constructor(private readonly repo: Pick<DownloadHistoryRepository, 'updateTorrentHash'>) {}

  private titleOf(h: DownloadHistoryRow): string {
    let title = this.normalisedTitles.get(h);
    if (title === undefined) {
      title = normaliseTorrentName(h.sourceTitle ?? '');
      this.normalisedTitles.set(h, title);
    }
    return title;
  }

  findMatch(torrent: MatchableTorrent, histories: DownloadHistoryRow[]): HistoryMatch | null {
    const hash = torrent.hash?.toLowerCase() ?? null;
    const name = normaliseTorrentName(torrent.name);

    if (hash) {
      const byHash = pickAuthoritative(histories.filter((h) => h.torrentHash && h.torrentHash.toLowerCase() === hash));
      if (byHash) return { history: byHash, matchedBy: 'hash' };
    }

    const byName = pickAuthoritative(histories.filter((h) => this.titleOf(h) === name));
    if (byName) return { history: byName, matchedBy: 'exact-name' };

    const prefix = histories.filter((h) => {
      const s = this.titleOf(h);
      if (!s) return false;
      return name.startsWith(s) || s.startsWith(name);
    });
    if (prefix.length === 1) return { history: prefix[0]!, matchedBy: 'unique-prefix' };
    if (prefix.length > 1) {
      log.warn(`TorrentHistoryMatcher: ${prefix.length} histories with prefix overlap on "${torrent.name}" — skipped`);
    }
    return null;
  }

  /** Persist the torrent hash on a history row when the matcher resolved it by
   *  name. Cheap idempotent UPDATE — safe to call on every match. */
  async healHash(history: DownloadHistoryRow, hash: string): Promise<void> {
    if (!hash || history.torrentHash) return;
    await this.repo.updateTorrentHash(history.id, hash);
    history.torrentHash = hash;
  }

  /** Convenience: match + self-heal in one call. */
  async matchAndHeal(torrent: MatchableTorrent, histories: DownloadHistoryRow[]): Promise<DownloadHistoryRow | null> {
    const match = this.findMatch(torrent, histories);
    if (!match) return null;
    if (match.matchedBy !== 'hash' && torrent.hash) {
      await this.healHash(match.history, torrent.hash.toLowerCase());
    }
    return match.history;
  }
}
