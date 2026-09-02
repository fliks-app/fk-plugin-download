import type { IndexerSourceRow } from '../db/rows';

/** One indexer as the source reports it, already reduced to what an `indexers` row needs. */
export interface RemoteIndexer {
  /** The source's own id for it: the torznab endpoint is built from this. */
  externalId: string;
  name: string;
  /** Torznab endpoint this plugin will query, credentials excluded. */
  baseUrl: string;
  /** Enabled at the source. Only ever applied to a row this import creates. */
  enabled: boolean;
}

/** Reported per source rather than thrown, so the reason reaches the admin as a message. */
export interface SourceTestResult {
  ok: boolean;
  messageKey: string;
  detail?: string;
}

export interface SourceSettings {
  baseUrl: string;
  apiKey: string;
}

/** `unsupported` counts what the source has configured over a protocol this plugin cannot
 *  query. Reported rather than dropped silently, since the admin sees fewer rows than the
 *  source shows. */
export interface RemoteIndexerList {
  indexers: RemoteIndexer[];
  unsupported: number;
}

export interface IndexerSourceDriver {
  /** Lists what the source has configured. Throws {@link SourceUnreachableError}: a source
   *  that cannot be read must not be mistaken for one with no indexers, which would import
   *  nothing and look like a success. */
  fetchIndexers(settings: SourceSettings): Promise<RemoteIndexerList>;
  testConnection(settings: SourceSettings): Promise<SourceTestResult>;
}

/** The source answered nothing usable: unreachable, refused the key, or replied with a body
 *  that is not its indexer list. */
export class SourceUnreachableError extends Error {
  constructor(
    message: string,
    readonly messageKey: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'SourceUnreachableError';
  }
}

export class IndexerSourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexerSourceNotFoundError';
  }
}

export class UnknownIndexerSourceImplementationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownIndexerSourceImplementationError';
  }
}

export interface CreateIndexerSourceInput {
  name: string;
  implementation: string;
  settings?: Record<string, unknown>;
  priority?: number;
  enabled?: boolean;
}

export interface UpdateIndexerSourceInput {
  name?: string;
  implementation?: string;
  settings?: Record<string, unknown>;
  priority?: number;
  enabled?: boolean;
}

export interface TestIndexerSourceInput {
  implementation: string;
  settings: Record<string, unknown>;
  /** The row being edited: lets a blank key resolve against what was stored. */
  id?: number;
}

/** What one import did, counted per remote indexer. */
export interface ImportSummary {
  /** Indexers this run added. */
  created: number;
  /** Already imported, and the source's API key had rotated since. */
  updated: number;
  /** Already imported, nothing to change: what a second click on an unchanged source reports. */
  unchanged: number;
  /** Configured at the source over a protocol this plugin cannot query. */
  unsupported: number;
}

export type IndexerSource = IndexerSourceRow;
