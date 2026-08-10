/**
 * Manual verification only — not part of `npm test` or CI, since it depends
 * on a sibling checkout of the Fliks repo (same constraint as
 * `verify-with-core.ts`). `src/host-methods.ts` and `src/principal.ts` are
 * hand-kept mirrors of `backend/src/common/plugin-contract/{host-methods,principal}.ts`
 * (types only — a `process` plugin has no access to that source at
 * runtime). This diffs the *method-name* sets so a core PR that adds,
 * removes or renames a `PluginHostApi` method is caught here rather than
 * discovered by a call that silently 404s in production.
 *
 * It does not diff field-level shape — that half is covered by `npm run
 * typecheck` failing the moment domain logic actually calls a method with
 * the old signature, once this repo hosts one.
 *
 * Usage: FLIKS_REPO=/path/to/fliks npx tsx scripts/check-contract-drift.ts
 */
import * as fs from 'fs';
import * as path from 'path';

/** `'group.method':` at the start of a line — how every entry in both files is written. */
function methodNames(source: string): Set<string> {
  const names = new Set<string>();
  const pattern = /^\s*'([a-zA-Z][\w.]*)':/gm;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(source))) names.add(m[1]!);
  return names;
}

function diff(label: string, ours: Set<string>, theirs: Set<string>): boolean {
  const missing = [...theirs].filter((n) => !ours.has(n));
  const extra = [...ours].filter((n) => !theirs.has(n));
  if (missing.length === 0 && extra.length === 0) {
    console.log(`OK: ${label} — ${theirs.size} methods match`);
    return true;
  }
  if (missing.length) console.error(`${label}: missing from our restatement: ${missing.join(', ')}`);
  if (extra.length) console.error(`${label}: present here but not in core: ${extra.join(', ')}`);
  return false;
}

function main(): void {
  const fliksRepo = process.env.FLIKS_REPO ?? path.join(__dirname, '..', '..', 'fliks');
  const coreHostMethods = path.join(fliksRepo, 'backend/src/common/plugin-contract/host-methods.ts');
  if (!fs.existsSync(coreHostMethods)) {
    console.log(`Fliks repo not found at ${fliksRepo} (set FLIKS_REPO) — cannot check for drift`);
    process.exit(1);
  }

  const ours = methodNames(fs.readFileSync(path.join(__dirname, '..', 'src', 'host-methods.ts'), 'utf8'));
  const theirs = methodNames(fs.readFileSync(coreHostMethods, 'utf8'));
  const ok = diff('PluginHostApi', ours, theirs);
  process.exit(ok ? 0 : 1);
}

main();
