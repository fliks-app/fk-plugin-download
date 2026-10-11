/**
 * What the grabbed release's title covers, as core parsed it: a season range, an optional episode
 * range within its first season, or the whole series. Rows grabbed before this migration (or by a
 * core that sends no coverage) keep nulls, and dedup falls back to their seasonId / source title.
 */
const up = `
  ALTER TABLE "download_history"
    ADD COLUMN IF NOT EXISTS "coverSeasonFrom" integer,
    ADD COLUMN IF NOT EXISTS "coverSeasonTo" integer,
    ADD COLUMN IF NOT EXISTS "coverEpisodeFrom" integer,
    ADD COLUMN IF NOT EXISTS "coverEpisodeTo" integer,
    ADD COLUMN IF NOT EXISTS "coverCompleteSeries" boolean
`;

const down = `
  ALTER TABLE "download_history"
    DROP COLUMN IF EXISTS "coverSeasonFrom",
    DROP COLUMN IF EXISTS "coverSeasonTo",
    DROP COLUMN IF EXISTS "coverEpisodeFrom",
    DROP COLUMN IF EXISTS "coverEpisodeTo",
    DROP COLUMN IF EXISTS "coverCompleteSeries"
`;

export const migration_0008_download_history_coverage = {
  name: '0008_download_history_coverage',
  up,
  down,
};
