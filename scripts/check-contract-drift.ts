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
 * It also diffs field names for a fixed allowlist of shapes (`ScoredRelease`,
 * `AcquisitionTarget`) and, for `AcquisitionEvent` — a discriminated union no
 * `export interface` parse can see — each variant's own field set, keyed by
 * its `type` literal. Every other shape's drift is still only covered by
 * `npm run typecheck` failing at the call site, once this repo hosts one.
 *
 * Usage: FLIKS_REPO=/path/to/fliks npx tsx scripts/check-contract-drift.ts
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * Field names of an exported interface. Method-name parity alone let a drifted
 * `ScoredRelease` through: core gained `qualityName`/`languageName` and this
 * restatement kept only the ids, which does not fail to compile — it stores a
 * digit where a user reads a quality.
 */
function interfaceFields(source: string, name: string): Set<string> {
  const start = source.indexOf(`export interface ${name} {`);
  if (start === -1) return new Set();
  const body = source.slice(start, source.indexOf('\n}', start));
  const fields = new Set<string>();
  const pattern = /^\s{2}([a-zA-Z][\w]*)\??:/gm;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(body))) fields.add(m[1]!);
  return fields;
}

/**
 * Field names of each variant of a discriminated union declared as
 * `export type <name> = | {...} | {...} | ...;`, keyed by that variant's own
 * `type: '...'` literal — the shape a plain `export interface` scan can't see at all,
 * which is exactly how `AcquisitionEvent` drifted unnoticed. Scans char-by-char tracking
 * brace depth (rather than splitting on `|`) so nested types and multi-line variants
 * parse the same as one-liners; strips comments first so one sitting ahead of a field
 * can't hide it from the anchored `;`-or-start field pattern below.
 */
function unionVariantFields(source: string, name: string): Map<string, Set<string>> {
  const marker = `export type ${name} =`;
  const start = source.indexOf(marker);
  const variants = new Map<string, Set<string>>();
  if (start === -1) return variants;

  let depth = 0;
  let bodyStart = -1;
  for (let i = start + marker.length; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      if (depth === 0) bodyStart = i + 1;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && bodyStart !== -1) {
        const body = source
          .slice(bodyStart, i)
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        const fields = new Set<string>();
        const fieldPattern = /(?:^|;)\s*([a-zA-Z_]\w*)\??\s*:/g;
        let fm: RegExpExecArray | null;
        while ((fm = fieldPattern.exec(body))) fields.add(fm[1]!);
        const typeLiteral = /(?:^|;)\s*type\s*:\s*'([^']*)'/.exec(body);
        if (typeLiteral) variants.set(typeLiteral[1]!, fields);
        bodyStart = -1;
      }
    } else if (depth === 0 && ch === ';') {
      break; // the alias declaration's own terminator, past the last variant
    }
  }
  return variants;
}

/** Variant-existence and per-variant field parity, reusing `diff` for the field half so a
 *  matching variant prints the same "N names match" line an interface diff would. */
function diffUnion(label: string, ours: Map<string, Set<string>>, theirs: Map<string, Set<string>>): boolean {
  let ok = true;
  for (const variant of new Set([...ours.keys(), ...theirs.keys()])) {
    const theirFields = theirs.get(variant);
    const ourFields = ours.get(variant);
    if (!theirFields) {
      console.error(`${label}: variant present here but not in core: ${variant}`);
      ok = false;
    } else if (!ourFields) {
      console.error(`${label}: variant missing from our restatement: ${variant}`);
      ok = false;
    } else if (!diff(`${label} "${variant}"`, ourFields, theirFields)) {
      ok = false;
    }
  }
  return ok;
}

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
    console.log(`OK: ${label} — ${theirs.size} names match`);
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
  let ok = diff('PluginHostApi', ours, theirs);

  // Shapes core hands back or takes in: a missing field here is silent at compile
  // time and wrong at runtime.
  const ourSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'host-methods.ts'), 'utf8');
  const coreSrc = fs.readFileSync(coreHostMethods, 'utf8');
  for (const shape of ['ScoredRelease', 'AcquisitionTarget']) {
    const theirFields = interfaceFields(coreSrc, shape);
    if (theirFields.size === 0) continue;
    ok = diff(shape, interfaceFields(ourSrc, shape), theirFields) && ok;
  }

  // Discriminated unions are invisible to `interfaceFields` — diffed variant by variant instead.
  for (const union of ['AcquisitionEvent']) {
    const theirVariants = unionVariantFields(coreSrc, union);
    if (theirVariants.size === 0) continue;
    ok = diffUnion(union, unionVariantFields(ourSrc, union), theirVariants) && ok;
  }
  process.exit(ok ? 0 : 1);
}

main();
