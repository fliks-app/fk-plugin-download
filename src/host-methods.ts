/**
 * Restated from `backend/src/common/plugin-contract/host-methods.ts` (types
 * only, no runtime code) — the 17 methods this plugin calls on core, grouped
 * A-E as the plan groups them. A `process` plugin ships with no access to
 * `backend/src` at runtime, so this is a hand-kept mirror, not an import.
 *
 * Drift is caught two ways: `scripts/check-contract-drift.ts` (manual, needs
 * a sibling Fliks checkout — see its header) diffs this file's method-name
 * set against the real one; and every call this plugin ever makes is typed
 * against {@link PluginHostApi} here, so a signature change that isn't
 * mirrored fails `npm run typecheck` at the call site the moment the domain
 * logic lands, not silently at runtime.
 */

export type MediaKind = 'movie' | 'series';

/** Closed vocabulary of core SSE event names a plugin can subscribe to via the `event` note.
 *  Restated as `string`: the actual closed set lives in core's EventsService. */
export type CoreEventName = string;

/** Everything needed to decide whether, and how, to acquire one piece of media.
 *  `want: null` means unprofiled — the plugin must not act. */
export interface AcquisitionTarget {
  mediaId: number;
  kind: MediaKind;
  title: string;
  originalTitle: string | null;
  alternativeTitles: string[];
  year: number | null;
  runtimeMinutes: number | null;
  imdbId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  libraryId: number;
  want: {
    decision: 'missing' | 'upgrade';
    allowedQualityIds: number[];
    allowedLanguageIds: number[];
    minRankExclusive: number;
    maxRankInclusive: number;
    minResolution: number;
    resolutionUpgradeOnly: boolean;
  } | null;
  expectedTitles: string[];
  searchTitle: string;
  season?: { id: number; number: number; episodeCount: number };
  episode?: { id: number; number: number; endNumber: number | null; airDate: string | null };
}

/** The verdict on one candidate release, already sorted by relevance. */
export interface ScoredRelease {
  id: string;
  qualityId: number;
  qualityName: string;
  rank: number;
  allowed: boolean;
  customFormatScore: number;
  blocklisted: boolean;
  languageId: number | null;
  languageName: string | null;
  languageAllowed: boolean;
  isFullSeason: boolean;
  sizeDeviation: number;
  videoCodec: string | null;
  rejections: { code: string; detail?: string }[];
}

/** Domain facts this plugin publishes; core decides the SSE audience for each. */
export type AcquisitionEvent =
  | {
      type: 'acquisition.grabbed';
      mediaId: number;
      seasonNumber?: number;
      episodeNumber?: number;
      sourceTitle: string;
      quality: string;
    }
  | {
      type: 'acquisition.progress';
      mediaId: number;
      ref: string;
      progress: number;
      etaSeconds: number | null;
      state: string;
    }
  | { type: 'acquisition.imported'; mediaId: number; seasonNumber?: number; episodeNumber?: number }
  | { type: 'acquisition.failed'; mediaId: number; reason: string }
  | { type: 'acquisition.queue.changed' };

/**
 * The full core-side surface, keyed by dotted method name. `HostClient.call`
 * is typed against this; core's `FliksHostImpl` is declared to satisfy the
 * same shape on the other end.
 */
export interface PluginHostApi {
  // Group A — read (6)

  'media.acquisitionContext': (p: {
    mediaId: number;
    seasonId?: number;
    episodeId?: number;
  }) => Promise<AcquisitionTarget | null>;

  /** Cursor-paged, limit <= 500. */
  'acquisition.candidates': (p: {
    kind?: MediaKind;
    mediaIds?: number[];
    availableOn: string;
    limit: number;
    cursor?: string;
  }) => Promise<{ items: AcquisitionTarget[]; cursor: string | null }>;

  'releases.match': (p: {
    titles: { id: string; title: string; publishDate: string }[];
    minAgeMinutes?: number;
  }) => Promise<
    {
      id: string;
      mediaId: number | null;
      seasonNumber?: number;
      episodeNumber?: number;
      isFullSeason: boolean;
      decision: 'grab' | 'skip';
      skipReason?: 'on-disk' | 'not-monitored' | 'unmatched' | 'too-fresh' | 'not-available' | 'unprofiled';
    }[]
  >;

  /** The hot path: rejection rules, custom formats, blocklist and quality/profile scoring, all in one call. */
  'releases.score': (p: {
    mediaId: number;
    seasonNumber?: number;
    episodeNumber?: number;
    releases: {
      id: string;
      title: string;
      size: number;
      seeders: number;
      leechers: number;
      publishDate: string;
      freeleech?: boolean;
      downloadVolumeFactor?: number;
      sourceRef: string;
      minSeeders?: number;
      unknownLanguageIsoCode?: string;
      /** This plugin owns the blocklist table, so core cannot know — it asks. */
      blocked: boolean;
    }[];
  }) => Promise<ScoredRelease[]>;

  /** Bounded: <= 100 ids (QUEUE_PAGE_SIZE_MAX). */
  'media.resolve': (p: {
    mediaIds?: number[];
    seasonIds?: number[];
    episodeIds?: number[];
  }) => Promise<
    Record<
      string,
      {
        title: string;
        kind: MediaKind;
        libraryId: number;
        seasonNumber?: number;
        episodeNumber?: number;
        episodeTitle?: string;
      }
    >
  >;

  'media.exists': (p: { mediaIds: number[] }) => Promise<number[]>;

  // Group B — write acquisition state (1)

  'requests.markInProgress': (p: {
    idempotencyKey: string;
    mediaId: number;
    seasonNumber?: number;
  }) => Promise<void>;

  // Group C — ingest (1)

  /** The one method that writes to disk. Core resolves the destination and
   *  enforces the ingest-root allowlist and idempotency — never the plugin. */
  'library.ingest': (p: {
    idempotencyKey: string;
    mediaId: number;
    paths: string[];
    transfer: 'copy' | 'move';
    fallbackQuality?: string;
    sourceLabel: string;
  }) => Promise<{
    imported: { mediaFileId: number; relativePath: string; quality: string }[];
    seasonNumber?: number;
    episodeNumber?: number;
  }>;

  // Group D — events and outbound (5)

  /** Batched. Core resolves the SSE audience via SseAudienceService.recipientsForMedia. */
  'events.publish': (p: AcquisitionEvent[]) => Promise<void>;

  /** Closed vocabulary, not a free string. Today: 'grab.started'. */
  'notifications.dispatch': (p: {
    event: 'grab.started';
    payload: Record<string, unknown>;
  }) => Promise<void>;

  /** The sidebar badge, pushed not polled. */
  'counts.set': (p: { key: string; value: number }) => Promise<void>;

  /** Plugin-namespaced SSE. Core force-prefixes the type to `plugin.<id>.<type>`. */
  'events.emitOwn': (p: {
    type: string;
    payload: unknown;
    audience: 'all' | { mediaId: number };
  }) => Promise<void>;

  /** Live acquisition progress. This plugin pushes; core emits the reserved
   *  `download.progress` SSE type. Coalesced server-side to <= 1/media/second. */
  'progress.set': (p: {
    mediaId: number;
    seasonNumber?: number;
    episodeNumber?: number;
    ref: string;
    progress: number;
    bytesPerSecond?: number;
    etaSeconds?: number;
    state: 'queued' | 'active' | 'stalled' | 'paused' | 'importing';
  }) => Promise<void>;

  // Group E — config (2)

  /** `plugin.<id>.*` keys only. */
  'config.get': (p: { keys?: string[] }) => Promise<Record<string, string>>;

  /** Prefix applied server-side. Never `PUT /settings/:key`. */
  'config.set': (p: { key: string; value: string | null }) => Promise<void>;
}
