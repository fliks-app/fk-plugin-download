/**
 * The `supportedParams` each typed search advertises. An id the tracker does not index yields an
 * empty `200`, so queries are filtered against it.
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
