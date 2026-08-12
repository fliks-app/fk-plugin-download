/**
 * Records when a capability probe last succeeded. Without it, "probed and this tracker
 * supports neither typed search" and "never probed successfully" are the same two false
 * flags, so one failed probe at create time pinned an indexer to text-only search forever.
 */
const up = `
  ALTER TABLE "indexers" ADD COLUMN IF NOT EXISTS "capsProbedAt" timestamptz
`;

const down = `
  ALTER TABLE "indexers" DROP COLUMN IF EXISTS "capsProbedAt"
`;

export const migration_0002_indexer_caps_probed_at = {
  name: '0002_indexer_caps_probed_at',
  up,
  down,
};
