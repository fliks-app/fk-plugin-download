import { Pool, types, type CustomTypesConfig } from 'pg';

/** `acme.tool` -> `plugin_acme_tool`, mirroring core's `pluginDbIdentifier`
 *  (`backend/src/modules/plugins/plugin-database.service.ts`) — restated because a
 *  `process` plugin has no import access to `backend/src` at runtime. */
export function pluginSchemaName(pluginId: string): string {
  return `plugin_${pluginId.replace(/\./g, '_')}`;
}

/** Pins `search_path` to the plugin's own schema at the Postgres connection-startup
 *  parameter level, overwriting whatever the DSN's `options` query param already
 *  carries — the DSN core hands us already sets this, this survives one that doesn't
 *  (a hand-built test DSN, or a future core change), with a single source of truth. */
function withSearchPath(dsn: string, schema: string): string {
  const url = new URL(dsn);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

/** `stalled_checks.downloadedBytes` is `bigint`; node-postgres hands OID 20 back as a
 *  string by default. `Number` is lossless up to 2^53 — far past any real torrent size. */
function customTypes(): CustomTypesConfig {
  return {
    getTypeParser(oid, format) {
      if (oid === types.builtins.INT8) return (val: string) => Number(val);
      if (oid === types.builtins.TIMESTAMPTZ) return (val: string) => new Date(val).toISOString();
      return types.getTypeParser(oid, format);
    },
  };
}

export interface PluginDbConfig {
  /** `FLIKS_DB_URL` — see `src/plugin.ts`'s env reads and `spawn-plan.ts` in the Fliks repo. */
  dsn: string;
  /** `FLIKS_PLUGIN_ID` — derives the schema this pool is pinned to. */
  pluginId: string;
}

/**
 * One pool per process, scoped to this plugin's own schema. It never assumes it may
 * read core tables: core only ever grants `REFERENCES` on the `coreRefs` it declared
 * (see the manifest's `database.coreRefs`), never `SELECT` — enforced by Postgres
 * itself, not by anything in this module, so no query here ever targets `public.*`.
 */
export function createPluginPool(config: PluginDbConfig): Pool {
  const schema = pluginSchemaName(config.pluginId);
  return new Pool({
    connectionString: withSearchPath(config.dsn, schema),
    types: customTypes(),
  });
}
