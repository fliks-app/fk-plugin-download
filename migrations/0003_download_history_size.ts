/**
 * Release size in bytes, as the indexer reported it at grab time. Rows grabbed before
 * this migration keep a null — the history view simply omits the value for them.
 */
const up = `
  ALTER TABLE "download_history" ADD COLUMN IF NOT EXISTS "size" bigint
`;

const down = `
  ALTER TABLE "download_history" DROP COLUMN IF EXISTS "size"
`;

export const migration_0003_download_history_size = {
  name: '0003_download_history_size',
  up,
  down,
};
