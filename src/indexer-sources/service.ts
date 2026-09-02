import type { IndexerRow, IndexerSourceRow } from '../db/rows';
import { log } from '../log';
import { mergeSecretSettings, redactSecretSettings } from '../secret-settings';
import type { CreateIndexerInput } from '../indexers/types';
import {
  IndexerSourceNotFoundError,
  SourceUnreachableError,
  UnknownIndexerSourceImplementationError,
  type CreateIndexerSourceInput,
  type ImportSummary,
  type IndexerSourceDriver,
  type SourceSettings,
  type SourceTestResult,
  type TestIndexerSourceInput,
  type UpdateIndexerSourceInput,
} from './types';

/** The one credential a source's `settings` carries. */
const SECRET_SETTING_KEYS = ['apiKey'] as const;

/** Every imported indexer is a torznab row, the only implementation this plugin runs. */
const IMPORTED_IMPLEMENTATION = 'torznab';

const DISABLED_KEY = 'download.indexer_sources.errors.disabled';

/** Raised when the source row itself forbids the import, as opposed to the source answering badly. */
export class IndexerSourceDisabledError extends Error {
  readonly messageKey = DISABLED_KEY;
  constructor(message: string) {
    super(message);
    this.name = 'IndexerSourceDisabledError';
  }
}

export interface IndexerSourceRepositoryLike {
  listAll(): Promise<IndexerSourceRow[]>;
  findById(id: number): Promise<IndexerSourceRow | null>;
  insert(input: {
    name: string;
    implementation: string;
    settings: Record<string, unknown>;
    priority: number;
    enabled: boolean;
  }): Promise<IndexerSourceRow>;
  update(
    id: number,
    input: { name: string; implementation: string; settings: Record<string, unknown>; priority: number; enabled: boolean },
  ): Promise<IndexerSourceRow>;
  remove(id: number): Promise<void>;
}

/** What the import needs from the indexer side: find by endpoint, add, refresh a key. */
export interface ImportTargetIndexers {
  findByBaseUrl(baseUrl: string): Promise<IndexerRow | null>;
  create(input: CreateIndexerInput): Promise<IndexerRow>;
  updateSettings(id: number, settings: Record<string, unknown>): Promise<void>;
}

export interface IndexerSourceServiceDeps {
  repo: IndexerSourceRepositoryLike;
  drivers: Readonly<Record<string, IndexerSourceDriver>>;
  indexers: ImportTargetIndexers;
}

export class IndexerSourceService {
  constructor(private readonly deps: IndexerSourceServiceDeps) {}

  private driverFor(implementation: string): IndexerSourceDriver {
    const driver = this.deps.drivers[implementation];
    if (!driver) {
      throw new UnknownIndexerSourceImplementationError(`Unknown indexer source "${implementation}"`);
    }
    return driver;
  }

  /** Strips the stored API key so it never reaches an HTTP response, and reports that it is set. */
  redact(source: IndexerSourceRow): IndexerSourceRow {
    return { ...source, settings: redactSecretSettings(source.settings, SECRET_SETTING_KEYS) };
  }

  async findAll(): Promise<IndexerSourceRow[]> {
    const rows = await this.deps.repo.listAll();
    return rows.map((row) => this.redact(row));
  }

  async findOne(id: number): Promise<IndexerSourceRow> {
    const row = await this.deps.repo.findById(id);
    if (!row) throw new IndexerSourceNotFoundError(`Indexer source #${id} not found`);
    return row;
  }

  async create(input: CreateIndexerSourceInput): Promise<IndexerSourceRow> {
    this.driverFor(input.implementation);
    const saved = await this.deps.repo.insert({
      name: input.name,
      implementation: input.implementation,
      settings: mergeSecretSettings(undefined, input.settings ?? {}, SECRET_SETTING_KEYS),
      priority: input.priority ?? 1,
      enabled: input.enabled ?? true,
    });
    log.info(`indexer source "${saved.name}" (${saved.implementation}) saved`);
    return this.redact(saved);
  }

  async update(id: number, input: UpdateIndexerSourceInput): Promise<IndexerSourceRow> {
    const existing = await this.findOne(id);
    if (input.implementation !== undefined) this.driverFor(input.implementation);
    const saved = await this.deps.repo.update(id, {
      name: input.name ?? existing.name,
      implementation: input.implementation ?? existing.implementation,
      settings:
        input.settings === undefined
          ? existing.settings
          : mergeSecretSettings(existing.settings, input.settings, SECRET_SETTING_KEYS),
      priority: input.priority ?? existing.priority,
      enabled: input.enabled ?? existing.enabled,
    });
    return this.redact(saved);
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.deps.repo.remove(id);
    // The indexers it imported are ordinary rows and stay: they work without the source, and
    // deleting a connection is not a request to stop searching every tracker it named.
    log.info(`indexer source #${id} removed; the indexers it imported were kept`);
  }

  /**
   * A blank key on a saved row means "use the stored one". The client never receives the real
   * value on read, so demanding it here would make testing a saved source impossible without
   * retyping it. A `null` is a pending erase: it tests without a key.
   */
  private async settingsForTest(input: TestIndexerSourceInput): Promise<SourceSettings> {
    const submitted = input.settings ?? {};
    const baseUrl = String(submitted['baseUrl'] ?? '').trim();
    if (submitted['apiKey'] === null) return { baseUrl, apiKey: '' };
    const key = String(submitted['apiKey'] ?? '').trim();
    if (key || input.id === undefined) return { baseUrl, apiKey: key };
    try {
      const existing = await this.findOne(input.id);
      return { baseUrl, apiKey: String(existing.settings['apiKey'] ?? '').trim() };
    } catch {
      return { baseUrl, apiKey: key };
    }
  }

  async testConnection(input: TestIndexerSourceInput): Promise<SourceTestResult> {
    const driver = this.deps.drivers[input.implementation];
    if (!driver) {
      return {
        ok: false,
        messageKey: 'download.indexer_sources.test.unknown_implementation',
        detail: input.implementation,
      };
    }
    const result = await driver.testConnection(await this.settingsForTest(input));
    if (!result.ok) {
      log.warn(`indexer source test failed (${input.implementation}): ${result.messageKey} ${result.detail ?? ''}`.trim());
    }
    return result;
  }

  /**
   * Imports (or re-imports) everything the source has configured. Deduped on the torznab
   * endpoint, which is derived from the source's base URL and the remote indexer's own id, so a
   * second run updates what it created rather than adding a second copy of every tracker.
   *
   * A row that already exists keeps the admin's own name, priority and tuning; only a rotated
   * API key is written back, because that is the one field the source still owns.
   */
  async importFrom(id: number): Promise<ImportSummary> {
    const source = await this.findOne(id);
    if (!source.enabled) {
      throw new IndexerSourceDisabledError(`Indexer source #${id} is disabled`);
    }
    const driver = this.driverFor(source.implementation);
    const apiKey = String(source.settings['apiKey'] ?? '');
    const settings: SourceSettings = { baseUrl: String(source.settings['baseUrl'] ?? ''), apiKey };

    let list;
    try {
      list = await driver.fetchIndexers(settings);
    } catch (e) {
      const err = e as SourceUnreachableError;
      log.error(`import from "${source.name}" (${source.implementation}) failed: ${err.message}${err.detail ? `: ${err.detail}` : ''}`);
      throw err;
    }

    const summary: ImportSummary = { created: 0, updated: 0, unchanged: 0, unsupported: list.unsupported };
    for (const remote of list.indexers) {
      const existing = await this.deps.indexers.findByBaseUrl(remote.baseUrl);
      if (!existing) {
        await this.deps.indexers.create({
          name: remote.name,
          implementation: IMPORTED_IMPLEMENTATION,
          settings: { baseUrl: remote.baseUrl, apiKey },
          enabled: remote.enabled,
        });
        summary.created++;
        continue;
      }
      if (String(existing.settings['apiKey'] ?? '') !== apiKey) {
        await this.deps.indexers.updateSettings(existing.id, { ...existing.settings, apiKey });
        summary.updated++;
        continue;
      }
      summary.unchanged++;
    }

    log.info(
      `import from "${source.name}" (${source.implementation}): ${summary.created} added, ` +
        `${summary.updated} key-refreshed, ${summary.unchanged} unchanged, ${summary.unsupported} unsupported`,
    );
    return summary;
  }
}
