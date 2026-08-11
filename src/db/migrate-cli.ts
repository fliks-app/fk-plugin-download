/** `npm run migrate [down [steps]]` — same `migrateUp`/`migrateDown` the plugin runs at
 *  boot, exposed for manual/CI use against `FLIKS_DB_URL`/`FLIKS_PLUGIN_ID`. */
import { createPluginPool } from './pool';
import { migrateUp, migrateDown } from './migrate';

async function main(): Promise<void> {
  const dsn = process.env.FLIKS_DB_URL;
  const pluginId = process.env.FLIKS_PLUGIN_ID;
  if (!dsn) throw new Error('FLIKS_DB_URL is not set');
  if (!pluginId) throw new Error('FLIKS_PLUGIN_ID is not set');

  const pool = createPluginPool({ dsn, pluginId });
  try {
    const direction = process.argv[2];
    if (direction === 'down') {
      const steps = Number(process.argv[3] ?? '1');
      console.log(await migrateDown(pool, steps));
    } else {
      console.log(await migrateUp(pool));
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
