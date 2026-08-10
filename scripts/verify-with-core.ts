/**
 * Manual verification only — not part of `npm test` or CI, since it depends
 * on a sibling checkout of the Fliks repo that will not exist for anyone
 * else building this plugin. Runs the *real* core archive validator
 * (`inspect()`) against our packaged `.fkplugin`, imported straight from
 * that repo's TypeScript source (its compiled `dist/` did not carry the
 * plugins module in this checkout) via `tsx` — never a reimplementation.
 *
 * Usage: FLIKS_REPO=/path/to/fliks npx tsx scripts/verify-with-core.ts
 */
import * as fs from 'fs';
import * as path from 'path';

async function main(): Promise<void> {
  const fliksRepo = process.env.FLIKS_REPO ?? path.join(__dirname, '..', '..', 'fliks');
  const archiveIndex = path.join(fliksRepo, 'backend/src/modules/plugins/archive/zip-inspector.ts');
  const compiledArchive = path.join(fliksRepo, 'backend/dist/modules/plugins/archive/zip-inspector.js');

  const archivePath = path.join(__dirname, '..', 'dist', 'fliks-download.fkplugin');
  if (!fs.existsSync(archivePath)) {
    console.error(`no archive at ${archivePath} — run "npm run package" first`);
    process.exit(1);
  }
  const buffer = fs.readFileSync(archivePath);

  let inspect: (buf: Buffer, opts?: unknown) => Promise<{ ok: boolean; [k: string]: unknown }>;
  if (fs.existsSync(compiledArchive)) {
    ({ inspect } = await import(compiledArchive));
    console.log(`using compiled ${compiledArchive}`);
  } else if (fs.existsSync(archiveIndex)) {
    ({ inspect } = await import(archiveIndex));
    console.log(`compiled dist not found — using real TS source ${archiveIndex} via tsx`);
  } else {
    console.log(`Fliks repo not found at ${fliksRepo} (set FLIKS_REPO) — cannot run the real inspect()`);
    process.exit(1);
  }

  // Local install path: our archive is unsigned, so it only passes with this id allowlisted,
  // exactly as a real admin would set FLIKS_UNSIGNED_PLUGINS=fliks.download for a local install.
  const result = await inspect(buffer, { unsignedProcessAllowlist: ['fliks.download'] });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
  if (result.kind !== 'process') {
    console.error(`expected kind "process", got ${String(result.kind)}`);
    process.exit(1);
  }
  console.log('OK: real core inspect() accepts the packaged archive as a process-tier plugin');
}

void main();
