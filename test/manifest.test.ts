import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { build } from '../scripts/build';
import { CORE_REFS, JOBS, LEGACY_PATHS, PERMISSIONS, PLUGIN_ID, ROUTES, SCOPES } from '../scripts/manifest-template';

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/** Minimal comparator-range check for the exact ">=X.Y.Z <A.B.C" shape this
 *  build ever emits — not a general semver parser, so no `semver` dependency
 *  just to check one string in a test. */
function tupleOf(v: string): [number, number, number] {
  const [maj, min, pat] = v.split('.').map(Number);
  return [maj ?? 0, min ?? 0, pat ?? 0];
}
function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}
function satisfiesRange(version: string, range: string): boolean {
  const v = tupleOf(version);
  return range
    .trim()
    .split(/\s+/)
    .every((clause) => {
      const m = /^(>=|<)(\d+\.\d+\.\d+)$/.exec(clause);
      if (!m) throw new Error(`unsupported clause: ${clause}`);
      const bound = tupleOf(m[2]!);
      return m[1] === '>=' ? cmp(v, bound) >= 0 : cmp(v, bound) < 0;
    });
}

/** Prefer the sibling Fliks checkout's real version when present; otherwise
 *  fall back to the value read from it at authoring time. */
function currentFliksVersion(): string {
  const siblingPkg = path.join(ROOT, '..', 'fliks', 'backend', 'package.json');
  if (fs.existsSync(siblingPkg)) {
    const pkg = JSON.parse(fs.readFileSync(siblingPkg, 'utf8')) as { version: string };
    return pkg.version;
  }
  return '2.0.1';
}

test('build emits a manifest whose files hashes match the real bundle bytes', () => {
  build();
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'plugin.json'), 'utf8')) as {
    files: Record<string, string>;
  };

  for (const [name, expectedHash] of Object.entries(manifest.files)) {
    const actual = createHash('sha256').update(fs.readFileSync(path.join(DIST, name))).digest('hex');
    assert.equal(actual, expectedHash, `sha256 of ${name} must match manifest.files`);
  }
  assert.deepEqual(Object.keys(manifest.files).sort(), ['logo.svg', 'plugin.js']);
});

test('the fliks range satisfies the real Fliks version', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'plugin.json'), 'utf8')) as { fliks: string };
  const version = currentFliksVersion();
  assert.ok(satisfiesRange(version, manifest.fliks), `${manifest.fliks} must satisfy ${version}`);
  // and the range must carry a mandatory upper bound, not just a floor
  assert.match(manifest.fliks, /<\d+\.\d+\.\d+/);
});

test('manifest carries the required process-tier shape', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'plugin.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(manifest.id, PLUGIN_ID);
  assert.equal(manifest.kind, 'process');
  assert.equal(manifest.pluginApi, 0);
  assert.equal(manifest.runtime, 'node');
  assert.deepEqual(manifest.database, { schema: true, coreRefs: [...CORE_REFS] });
  assert.deepEqual(manifest.scopes, [...SCOPES]);
  assert.deepEqual(manifest.ingestRoots, ['/downloads']);
});

test('permissions[] are bare, unnamespaced names legal under core\'s plugin-permission pattern', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'plugin.json'), 'utf8')) as { permissions: string[] };
  assert.deepEqual(manifest.permissions.sort(), [...Object.values(PERMISSIONS)].sort());
  for (const permission of manifest.permissions) {
    assert.match(permission, /^[a-z][a-z0-9_-]{0,63}$/);
    assert.ok(!permission.includes(':'), 'a permission name must never carry the core-built prefix itself');
  }
});

test('every route policy is "<Action>:plugin:fliks.download:<declared permission>"', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'plugin.json'), 'utf8')) as {
    routes: { method: string; path: string; policy: string; objectGuard?: string }[];
    permissions: string[];
  };
  assert.deepEqual(manifest.routes, ROUTES);
  assert.ok(manifest.routes.length >= 8, 'at least the 8 legacy grab/release routes must be declared');

  for (const route of manifest.routes) {
    const m = /^[a-z]+:plugin:fliks\.download:([a-z0-9_-]+)$/.exec(route.policy);
    assert.ok(m, `route policy "${route.policy}" must be "<action>:plugin:fliks.download:<permission>"`);
    assert.ok(manifest.permissions.includes(m![1]!), `route policy must reference a declared permission`);

    // objectGuard, where present, must be one of the two closed names and name a
    // param this same route's own path declares.
    if (route.objectGuard) {
      const gm = /^(mediaAccessible|libraryAccessible):([a-zA-Z0-9_]+)$/.exec(route.objectGuard);
      assert.ok(gm, `objectGuard "${route.objectGuard}" must be one of the two closed guard names`);
      assert.ok(
        route.path.includes(`:${gm![2]}`),
        `objectGuard param "${gm![2]}" must appear in route path "${route.path}"`,
      );
    }
  }
});

test('legacyPaths values are each one of the declared routes, verbatim', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'plugin.json'), 'utf8')) as {
    legacyPaths: Record<string, string>;
    routes: { method: string; path: string }[];
  };
  assert.deepEqual(manifest.legacyPaths, LEGACY_PATHS);
  const declared = new Set(manifest.routes.map((r) => `${r.method} ${r.path}`));
  for (const [oldPath, newPath] of Object.entries(manifest.legacyPaths)) {
    assert.match(oldPath, /^(GET|POST) \/api\/media\//, `legacy path "${oldPath}" must be a real old media.controller.ts URL`);
    assert.ok(declared.has(newPath), `legacyPaths target "${newPath}" must be one of routes[]`);
  }
});

test('jobs[] mirror the five acquisition-side core scheduler names, each with a valid cron and label', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'plugin.json'), 'utf8')) as {
    jobs: { name: string; cron: string; triggerable: boolean; labelKey: string }[];
  };
  assert.deepEqual(manifest.jobs, JOBS);
  assert.deepEqual(
    manifest.jobs.map((j) => j.name).sort(),
    ['CleanSeeded', 'CleanStalled', 'ImportCompleted', 'RssSync', 'SearchMissing'],
  );
  for (const job of manifest.jobs) {
    assert.ok(job.cron.length > 0);
    assert.equal(job.triggerable, true);
    assert.ok(job.labelKey.length > 0);
  }
});
