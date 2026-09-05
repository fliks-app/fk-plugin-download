import type { IndexerRow } from '../db/rows';
import { log } from '../log';
import {
  IndexerNotFoundError,
  UnknownIndexerImplementationError,
  type CreateIndexerInput,
  type IndexerConnectionTestResult,
  type IndexerRepository,
  type IndexerWithCooldown,
  type TestIndexerConnectionInput,
  type UpdateIndexerInput,
} from './types';
import { mergeSecretSettings, redactSecretSettings } from '../secret-settings';
import { useForOf } from './use-for';
import type { IndexerThrottle } from './throttle';
import type { TorznabClient } from './torznab';

/** The one credential an indexer's `settings` carries. */
const SECRET_SETTING_KEYS = ['apiKey'] as const;

/** Strips the stored API key so it never reaches an HTTP response, and reports that it is set. */
export function redactApiKey(ix: IndexerRow): IndexerRow {
  return { ...ix, settings: redactSecretSettings(ix.settings, SECRET_SETTING_KEYS) };
}

export interface IndexerServiceDeps {
  repo: IndexerRepository;
  torznab: Pick<TorznabClient, 'refreshCaps' | 'testConnection'>;
  throttle: Pick<IndexerThrottle, 'getCooldown' | 'clearCooldown' | 'clearAllCooldowns'>;
}

export class IndexerService {
  constructor(private readonly deps: IndexerServiceDeps) {}

  /** `"torznab"` is the only implementation this plugin runs. Throws, naming the
   *  value, otherwise — reused by both create() and update(). */
  private assertKnownImplementation(implementation: string): void {
    if (implementation !== 'torznab') {
      throw new UnknownIndexerImplementationError(`Unknown indexer implementation "${implementation}"`);
    }
  }

  async testConnection(input: TestIndexerConnectionInput): Promise<IndexerConnectionTestResult> {
    if (input.implementation !== 'torznab') {
      return {
        ok: false,
        messageKey: 'download.indexers.test.unknown_implementation',
        detail: input.implementation,
      };
    }
    const baseUrl = String(input.settings?.baseUrl ?? '').trim();
    const apiKey = await this.apiKeyForTest(input);
    return this.deps.torznab.testConnection(baseUrl, apiKey);
  }

  /** A blank key on a saved row means "use the stored one". The client never receives the real
   *  value on read, so demanding it here would make testing a saved indexer impossible without
   *  retyping it. An unknown id tests what was submitted rather than failing. A `null` is a
   *  pending erase: it tests without a key, which is the row being saved. */
  private async apiKeyForTest(input: TestIndexerConnectionInput): Promise<string> {
    if (input.settings?.apiKey === null) return '';
    const submitted = String(input.settings?.apiKey ?? '').trim();
    if (submitted || input.id === undefined) return submitted;
    try {
      const existing = await this.findOne(input.id);
      return String((existing.settings as Record<string, unknown>)?.apiKey ?? '').trim();
    } catch {
      return submitted;
    }
  }

  private sanitizeSettings(settings: Record<string, unknown> | undefined): Record<string, unknown> {
    const out = { ...(settings ?? {}) };
    if ('minSeeders' in out) {
      out['minSeeders'] = Math.max(0, Math.floor(Number(out['minSeeders']) || 0));
    }
    return out;
  }

  async create(input: CreateIndexerInput): Promise<IndexerRow> {
    this.assertKnownImplementation(input.implementation);
    const saved = await this.deps.repo.insert({
      name: input.name,
      implementation: input.implementation,
      settings: mergeSecretSettings(undefined, this.sanitizeSettings(input.settings), SECRET_SETTING_KEYS),
      enableRss: input.enableRss ?? true,
      enableSearch: input.enableSearch ?? true,
      enableInteractiveSearch: input.enableInteractiveSearch ?? true,
      priority: input.priority ?? 25,
      requestDelay: input.requestDelay ?? 2,
      enabled: input.enabled ?? true,
      capsMovieSearch: false,
      capsTvSearch: false,
      capsSearchFallback: false,
      capsProbedAt: null,
      capsMovieSearchParams: null,
      capsTvSearchParams: null,
    });

    // Fire-and-forget: a failed probe — or a row deleted while it was in flight — must never
    // reject into an unhandled rejection, which takes the whole plugin process down.
    void this.deps.torznab.refreshCaps(saved).catch((e: unknown) => log.warn(`caps refresh failed: ${String(e)}`));
    return this.redact(saved);
  }

  redact(ix: IndexerRow): IndexerRow {
    return redactApiKey(ix);
  }

  /** Relies on the repository returning rows ordered by `priority ASC, id ASC`. */
  async findAll(): Promise<IndexerWithCooldown[]> {
    const rows = await this.deps.repo.findAll();
    return rows.map((ix) => {
      const cd = this.deps.throttle.getCooldown(ix.id);
      return {
        ...this.redact(ix),
        useFor: useForOf(ix),
        cooldown: cd
          ? {
              reason: cd.reason,
              remainingMs: Math.max(0, cd.until - Date.now()),
              until: new Date(cd.until).toISOString(),
              failureCount: cd.failureCount,
              detail: cd.detail,
            }
          : null,
      };
    });
  }

  /** Lifts the throttle window on one indexer. */
  async clearCooldown(id: number): Promise<{ cleared: boolean }> {
    await this.findOne(id);
    return { cleared: this.deps.throttle.clearCooldown(id) };
  }

  /** Lifts every throttle window. */
  clearAllCooldowns(): { cleared: number } {
    return { cleared: this.deps.throttle.clearAllCooldowns() };
  }

  async findOne(id: number): Promise<IndexerRow> {
    const ix = await this.deps.repo.findOne(id);
    if (!ix) throw new IndexerNotFoundError(`Indexer #${id} not found`);
    return ix;
  }

  async update(id: number, input: UpdateIndexerInput): Promise<IndexerRow> {
    const existing = await this.findOne(id);
    const patch: Partial<IndexerRow> = {};

    if (input.name !== undefined) patch.name = input.name;
    if (input.implementation !== undefined) {
      this.assertKnownImplementation(input.implementation);
      patch.implementation = input.implementation;
    }
    if (input.enableRss !== undefined) patch.enableRss = input.enableRss;
    if (input.enableSearch !== undefined) patch.enableSearch = input.enableSearch;
    if (input.enableInteractiveSearch !== undefined) patch.enableInteractiveSearch = input.enableInteractiveSearch;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.requestDelay !== undefined) patch.requestDelay = input.requestDelay;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.settings !== undefined) {
      patch.settings = mergeSecretSettings(existing.settings, this.sanitizeSettings(input.settings), SECRET_SETTING_KEYS);
    }

    const saved = await this.deps.repo.update(id, patch);
    // Fire-and-forget: a failed probe — or a row deleted while it was in flight — must never
    // reject into an unhandled rejection, which takes the whole plugin process down.
    void this.deps.torznab.refreshCaps(saved).catch((e: unknown) => log.warn(`caps refresh failed: ${String(e)}`));
    return this.redact(saved);
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.deps.repo.remove(id);
  }
}
