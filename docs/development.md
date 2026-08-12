# Development

How to build, test and publish this plugin. What it does for a user is in
[README.md](../README.md); how the plugin system itself works — tiers, manifest, contract, trust —
is in [Fliks's `docs/plugins.md`](https://github.com/fliks-app/fliks/blob/main/docs/plugins.md).

## Build

```sh
npm ci
npm run typecheck     # tsc --noEmit
npm run build         # esbuild -> dist/plugin.js, dist/plugin.json, dist/logo.svg
npm run package       # dist/fliks-download.fkplugin
```

The manifest is generated from `scripts/manifest-template.ts`, so an admin field or a job is
declared there and nowhere else.

## Test

```sh
npm test
```

**Run it with a database or it lies.** The database tests (`test/db.test.ts`,
`db-cross-schema-fk.test.ts`, the migration round trip) skip themselves when nothing answers on
port 55432, and the runner still prints a green summary — that is how CI stayed red for five
commits while local runs passed. Reproduce CI exactly:

```sh
docker run -d --name fk-migtest -p 55432:5432 \
  -e POSTGRES_USER=fliks -e POSTGRES_PASSWORD=fliks -e POSTGRES_DB=fliks postgres:17

# stand-ins for the core tables this plugin holds REFERENCES grants on, without which
# the FK tests fail with: relation "public.media" does not exist
docker exec fk-migtest psql -U fliks -d fliks -c \
  "CREATE TABLE IF NOT EXISTS public.\"media\" (id serial PRIMARY KEY, \"title\" text NOT NULL DEFAULT '', \"type\" text NOT NULL DEFAULT 'movie');"

for t in episodes seasons users; do
  docker exec fk-migtest psql -U fliks -d fliks -c "CREATE TABLE IF NOT EXISTS public.\"$t\" (id serial PRIMARY KEY);"
done
```

With the database and the stubs: 262 pass, 2 skip. Never point `FK_TEST_PG_DSN` at the Fliks dev
database.

`test/harness.test.ts` spawns the real `dist/plugin.js` under the same flags core uses and drives
the whole protocol against it, so a change to the wire behaviour fails there rather than in
production.

## Install it on a dev instance

```sh
npm run build && npm run package
```

Then upload `dist/fliks-download.fkplugin` from **Settings → Advanced → Plugins**. A `process`
plugin must be signed, so a locally built archive needs its id in the server's
`FLIKS_UNSIGNED_PLUGINS`.

## Publish

Pushing here publishes nothing. Copy the built `plugin.json`, `plugin.js` and `logo.svg` into
`plugins/fliks.download/src/` in the catalogue repository, add a `versions/<version>.json` entry,
then run its **Package plugin** workflow for this id — it signs with the catalogue key and records
the published archive's hash.

A published version's bytes are pinned by that hash, so any change ships as a new version rather
than as a correction to the old one. Dispatch one plugin id at a time.
