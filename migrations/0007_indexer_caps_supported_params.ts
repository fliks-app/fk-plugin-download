/**
 * Records the `supportedParams` each typed search advertises. Without it every typed query
 * carried `imdbid`/`tmdbid`/`tvdbid` whether or not the tracker indexed them, and a tracker
 * handed an id it does not index answers `200` with an empty feed — so the search returned
 * nothing and the error-driven `t=search` fallback never fired.
 */
const up = `
  ALTER TABLE "indexers"
    ADD COLUMN IF NOT EXISTS "capsMovieSearchParams" text,
    ADD COLUMN IF NOT EXISTS "capsTvSearchParams" text
`;

const down = `
  ALTER TABLE "indexers"
    DROP COLUMN IF EXISTS "capsMovieSearchParams",
    DROP COLUMN IF EXISTS "capsTvSearchParams"
`;

export const migration_0007_indexer_caps_supported_params = {
  name: '0007_indexer_caps_supported_params',
  up,
  down,
};
