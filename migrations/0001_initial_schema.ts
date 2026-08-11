/**
 * The six tables this plugin owns, migrated out of the Fliks baseline schema and its
 * later migrations (`backend/src/migrations/1777816212948-baseline.ts` onward).
 *
 * Two deliberate departures from the columns as they exist in Fliks today:
 *  1. Every timestamp is `timestamptz`. `indexer_stats.queryDate` and
 *     `stalled_checks.checkedAt` are bare `timestamp` there, an inconsistency from
 *     `@CreateDateColumn()` never getting an explicit type before
 *     `AlignTimestampColumnsToTimestamptz1783000000000` fixed the other four — these
 *     are fresh tables, so there is nothing to migrate around.
 *  2. `download_history` and `blocklist` FK into core's `media`/`episodes`/`seasons`/
 *     `users` tables, schema-qualified to `public` (excluded from this plugin's
 *     `search_path`) and relying on the `REFERENCES`-only grant core provisions for
 *     `database.coreRefs`. `ON DELETE` actions are copied verbatim from the live FK
 *     definitions (`pg_constraint`), not re-derived from the entities.
 */

const up = `
CREATE TABLE "indexers" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "name" varchar NOT NULL,
  "implementation" varchar NOT NULL,
  "settings" jsonb NOT NULL DEFAULT '{}',
  "enableRss" boolean NOT NULL DEFAULT true,
  "enableSearch" boolean NOT NULL DEFAULT true,
  "priority" integer NOT NULL DEFAULT 25,
  "enabled" boolean NOT NULL DEFAULT true,
  "capsMovieSearch" boolean NOT NULL DEFAULT false,
  "capsTvSearch" boolean NOT NULL DEFAULT false,
  "capsSearchFallback" boolean NOT NULL DEFAULT false,
  "requestDelay" integer NOT NULL DEFAULT 2
);

CREATE TABLE "download_clients" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "name" varchar NOT NULL,
  "implementation" varchar NOT NULL,
  "settings" jsonb NOT NULL DEFAULT '{}',
  "enabled" boolean NOT NULL DEFAULT true,
  "priority" integer NOT NULL DEFAULT 1
);

CREATE TABLE "indexer_stats" (
  "id" SERIAL PRIMARY KEY,
  "indexerId" integer REFERENCES "indexers"("id") ON DELETE CASCADE,
  "queryDate" timestamptz NOT NULL DEFAULT now(),
  "queryType" varchar NOT NULL DEFAULT 'search',
  "responseTimeMs" integer NOT NULL DEFAULT 0,
  "resultCount" integer NOT NULL DEFAULT 0,
  "errorMessage" text
);

CREATE TABLE "download_history" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "sourceTitle" varchar NOT NULL,
  "quality" varchar NOT NULL,
  "language" varchar,
  "torrentHash" varchar,
  "status" varchar NOT NULL DEFAULT 'grabbed',
  "statusMessage" text,
  "grabSource" varchar(8) NOT NULL DEFAULT 'auto',
  "mediaId" integer REFERENCES public."media"("id") ON DELETE CASCADE,
  "episodeId" integer REFERENCES public."episodes"("id") ON DELETE SET NULL,
  "seasonId" integer REFERENCES public."seasons"("id") ON DELETE SET NULL,
  "indexerId" integer REFERENCES "indexers"("id") ON DELETE SET NULL,
  "downloadClientId" integer REFERENCES "download_clients"("id") ON DELETE SET NULL
);
CREATE INDEX "idx_download_history_torrent_hash_lower" ON "download_history" (LOWER("torrentHash")) WHERE "torrentHash" IS NOT NULL;

CREATE TABLE "blocklist" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "sourceTitle" varchar NOT NULL,
  "indexerId" integer,
  "indexerName" varchar,
  "downloadUrl" varchar,
  "quality" varchar,
  "note" varchar,
  "mediaId" integer REFERENCES public."media"("id") ON DELETE SET NULL,
  "userId" integer REFERENCES public."users"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "uq_blocklist_source_title_lower" ON "blocklist" (LOWER("sourceTitle"));

CREATE TABLE "stalled_checks" (
  "id" SERIAL PRIMARY KEY,
  "torrentHash" varchar(64) NOT NULL,
  "downloadedBytes" bigint NOT NULL,
  "checkedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "idx_stalled_checks_hash_checked_at" ON "stalled_checks" ("torrentHash", "checkedAt");
`;

const down = `
DROP TABLE IF EXISTS "stalled_checks";
DROP TABLE IF EXISTS "blocklist";
DROP TABLE IF EXISTS "download_history";
DROP TABLE IF EXISTS "indexer_stats";
DROP TABLE IF EXISTS "download_clients";
DROP TABLE IF EXISTS "indexers";
`;

export const migration_0001_initial_schema = {
  name: '0001_initial_schema',
  up,
  down,
};
