import type { IndexerRow, IndexerStatRow } from '../db/rows';

/** Torznab search hit as parsed off the wire — mirrors Fliks core's `ReleaseCandidate`,
 *  restated here since this plugin imports nothing from that repo. */
export interface IndexerRelease {
  title: string;
  downloadUrl: string;
  indexerId: number;
  indexerName: string;
  size: number;
  seeders: number;
  leechers: number;
  publishDate: string | null;
  freeleech: boolean;
  downloadVolumeFactor: number;
}

/** Why an indexer is being skipped, and until when — mirrors the throttle's own record. */
export interface IndexerCooldown {
  until: number;
  reason: 'rate-limit' | 'failures';
  failureCount?: number;
  detail?: string;
}

export type IndexerWithCooldown = IndexerRow & {
  cooldown: {
    reason: 'rate-limit' | 'failures';
    remainingMs: number;
    until: string;
    failureCount?: number;
    detail?: string;
  } | null;
};

/** Narrowest persistence shape this module needs. Expected to be backed by a
 *  Postgres repository over the `indexers` table (`src/db/**`, not owned here);
 *  `findAll` must return rows ordered by `priority ASC, id ASC` — callers rely on it. */
export interface IndexerRepository {
  findAll(): Promise<IndexerRow[]>;
  findOne(id: number): Promise<IndexerRow | null>;
  insert(row: Omit<IndexerRow, 'id' | 'createdAt' | 'updatedAt'>): Promise<IndexerRow>;
  update(id: number, patch: Partial<IndexerRow>): Promise<IndexerRow>;
  remove(id: number): Promise<void>;
}

/** Narrowest persistence shape for `indexer_stats` writes — expected to be
 *  backed by the same Postgres schema (`src/db/**`). */
export interface IndexerStatsRecorder {
  record(stat: Omit<IndexerStatRow, 'id' | 'queryDate'>): Promise<void>;
}

/** Every message `IndexerService.testConnection`/`TorznabClient.testConnection` can report,
 *  translated by the manifest's `i18n` dictionary — never a literal in any language. Detail
 *  carries the dynamic part (an HTTP status, an indexer's own error text, an implementation
 *  name), same split as `ScoredRelease.rejections[].{code,params}` in `src/host-methods.ts`. */
export type IndexerConnectionMessageKey =
  | 'download.indexers.test.unknown_implementation'
  | 'download.indexers.test.base_url_missing'
  | 'download.indexers.test.http_error'
  | 'download.indexers.test.torznab_error'
  | 'download.indexers.test.unexpected_response'
  | 'download.indexers.test.network_error'
  | 'download.indexers.test.ok';

export interface IndexerConnectionTestResult {
  ok: boolean;
  messageKey: IndexerConnectionMessageKey;
  detail?: string;
}

export interface CreateIndexerInput {
  name: string;
  /** Checked against the known implementations in `IndexerService`, not here. */
  implementation: string;
  settings?: Record<string, unknown>;
  enableRss?: boolean;
  enableSearch?: boolean;
  priority?: number;
  requestDelay?: number;
  enabled?: boolean;
}

export interface UpdateIndexerInput {
  name?: string;
  implementation?: string;
  settings?: Record<string, unknown>;
  enableRss?: boolean;
  enableSearch?: boolean;
  priority?: number;
  requestDelay?: number;
  enabled?: boolean;
}

export interface TestIndexerConnectionInput {
  /** `"torznab"` is the only value resolved — settings.baseUrl/apiKey are used. */
  implementation: string;
  settings: Record<string, unknown>;
}

export class IndexerNotFoundError extends Error {}
export class UnknownIndexerImplementationError extends Error {}
