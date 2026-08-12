import type { Migration } from '../src/db/migrate';
import { migration_0001_initial_schema } from './0001_initial_schema';
import { migration_0002_indexer_caps_probed_at } from './0002_indexer_caps_probed_at';

/** Applied in this order — see `src/db/migrate.ts` for how a run is recorded. */
export const MIGRATIONS: Migration[] = [migration_0001_initial_schema, migration_0002_indexer_caps_probed_at];
