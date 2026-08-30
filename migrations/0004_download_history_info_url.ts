/**
 * The tracker's own page for the grabbed release, as the feed reported it. Rows grabbed before
 * this migration keep a null and the detail dialog simply omits the link for them.
 */
const up = `
  ALTER TABLE "download_history" ADD COLUMN IF NOT EXISTS "infoUrl" text
`;

const down = `
  ALTER TABLE "download_history" DROP COLUMN IF EXISTS "infoUrl"
`;

export const migration_0004_download_history_info_url = {
  name: '0004_download_history_info_url',
  up,
  down,
};
