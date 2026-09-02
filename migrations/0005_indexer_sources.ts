/**
 * Saved Prowlarr / Jackett instances an admin imports indexers from. Only the connection is
 * stored: the indexers themselves land in `indexers` as ordinary torznab rows, so nothing
 * downstream has to know a source exists.
 */
const up = `
CREATE TABLE IF NOT EXISTS "indexer_sources" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "name" varchar NOT NULL,
  "implementation" varchar NOT NULL,
  "settings" jsonb NOT NULL DEFAULT '{}',
  "priority" integer NOT NULL DEFAULT 1,
  "enabled" boolean NOT NULL DEFAULT true
)
`;

const down = `
DROP TABLE IF EXISTS "indexer_sources"
`;

export const migration_0005_indexer_sources = {
  name: '0005_indexer_sources',
  up,
  down,
};
