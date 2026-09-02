/**
 * The gate a manual release search checks, independent of `enableSearch` (automatic) and
 * `enableRss`: the three usages an indexer can be put to no longer imply one another.
 */
const up = `
  ALTER TABLE "indexers" ADD COLUMN IF NOT EXISTS "enableInteractiveSearch" boolean NOT NULL DEFAULT true;

  -- Backfilled from the column that used to gate both kinds of search: a row with searches off
  -- must not come out of this migration answering manual ones. New rows take the default.
  UPDATE "indexers" SET "enableInteractiveSearch" = "enableSearch"
`;

const down = `
  ALTER TABLE "indexers" DROP COLUMN IF EXISTS "enableInteractiveSearch"
`;

export const migration_0006_indexer_interactive_search = {
  name: '0006_indexer_interactive_search',
  up,
  down,
};
