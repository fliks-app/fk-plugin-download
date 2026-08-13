import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { build } from '../scripts/build';
import { CORE_REFS, JOBS, PERMISSIONS, PLUGIN_ID, RELEASE_PICKER, ROUTES, SCOPES } from '../scripts/manifest-template';

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

/** The core version this manifest's `fliks` range is checked against. `FLIKS_CORE_VERSION` is for
 *  CI, which has no sibling checkout; without either, the check cannot run and must not pass. */
function currentFliksVersion(): string {
  const override = process.env.FLIKS_CORE_VERSION?.trim();
  if (override) return override;
  const siblingPkg = path.join(ROOT, '..', 'fliks', 'backend', 'package.json');
  if (fs.existsSync(siblingPkg)) {
    const pkg = JSON.parse(fs.readFileSync(siblingPkg, 'utf8')) as { version: string };
    return pkg.version;
  }
  throw new Error(
    'no Fliks version to check against: set FLIKS_CORE_VERSION or place a sibling fliks checkout',
  );
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
  assert.ok(manifest.routes.length >= 6, "at least the release picker's six routes must be declared");

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

test('ui.releasePicker names six declared routes, with the method each half implies', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'plugin.json'), 'utf8')) as {
    ui: { releasePicker: Record<string, { search: string; grab: string }> };
    routes: { method: string; path: string }[];
  };
  assert.deepEqual(manifest.ui.releasePicker, RELEASE_PICKER);
  const declared = new Set(manifest.routes.map((r) => `${r.method} ${r.path}`));
  const contexts = Object.entries(manifest.ui.releasePicker);
  assert.equal(contexts.length, 3, 'movie, season, episode');
  for (const [context, pair] of contexts) {
    // Core refuses the whole manifest when one of these is not a declared route: an
    // undeclared route carries no policy.
    assert.ok(declared.has(`GET ${pair.search}`), `releasePicker.${context}.search must be a declared GET`);
    assert.ok(declared.has(`POST ${pair.grab}`), `releasePicker.${context}.grab must be a declared POST`);
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

/** Walks any nested object/array, collecting the value of every property whose name is
 *  "hint" or ends in "Key" (`labelKey`, `shortLabelKey`, `newKey`, `emptyKey`, `testKey`,
 *  `deleteConfirmKey`, `confirmKey`, ...) — the manifest's own convention for "this string
 *  names an i18n key, not literal text". */
function collectI18nKeyRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectI18nKeyRefs(item, out);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'hint' || key.endsWith('Key')) && typeof value === 'string') out.push(value);
      else collectI18nKeyRefs(value, out);
    }
  }
  return out;
}

test('ui.contributions: settings.page paths sit under the admin settings shell, nav.* paths never do', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'plugin.json'), 'utf8')) as {
    ui: { contributions: { id: string; slot: string; action: { kind: string; path?: string } }[] };
  };
  const ADMIN_SETTINGS_PREFIX = '/admin/settings/';
  let settingsPagesChecked = 0;
  let navChecked = 0;

  for (const c of manifest.ui.contributions) {
    if (c.action.kind !== 'route') continue;
    const path = c.action.path!;
    if (c.slot === 'settings.page') {
      settingsPagesChecked++;
      assert.ok(
        path.startsWith(ADMIN_SETTINGS_PREFIX),
        `"${c.id}" is a settings.page contribution but its path "${path}" doesn't sit under ` +
          `${ADMIN_SETTINGS_PREFIX} — it would render in the main frame, wrong sidebar`,
      );
    } else if (c.slot.startsWith('nav.')) {
      navChecked++;
      assert.ok(
        !path.startsWith(ADMIN_SETTINGS_PREFIX),
        `"${c.id}" is a nav.* (main-navigation) contribution but its path "${path}" sits under ` +
          `${ADMIN_SETTINGS_PREFIX} — it belongs in the top-level frame, not the settings shell`,
      );
    }
  }

  assert.equal(settingsPagesChecked, 4, 'general, indexers, download-clients, history');
  assert.equal(navChecked, 1, 'the queue nav item');
});

test('every labelKey/hint/*Key referenced anywhere in ui.contributions and ui.configPages resolves in every declared locale', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'plugin.json'), 'utf8')) as {
    ui: { contributions: unknown[]; configPages: unknown[] };
    i18n: Record<string, Record<string, string>>;
  };
  const referenced = new Set([
    ...collectI18nKeyRefs(manifest.ui.contributions),
    ...collectI18nKeyRefs(manifest.ui.configPages),
  ]);
  assert.ok(referenced.size > 10, 'sanity: the walk must actually find keys');
  const locales = Object.keys(manifest.i18n);
  assert.ok(locales.length > 1, 'sanity: more than one locale must be declared');
  for (const locale of locales) {
    for (const key of referenced) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(manifest.i18n[locale], key),
        `"${key}" is referenced by ui.* but missing from i18n.${locale} — it would render as a raw key, or a literal if never keyed at all`,
      );
    }
  }
});

test('every locale carries exactly the same key set as i18n.en — a locale silently missing a key would ship English', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'plugin.json'), 'utf8')) as {
    i18n: { en: Record<string, string> } & Record<string, Record<string, string>>;
  };
  const enKeys = new Set(Object.keys(manifest.i18n.en));
  assert.ok(enKeys.size > 10, 'sanity: i18n.en must actually carry keys');
  for (const [locale, dict] of Object.entries(manifest.i18n)) {
    if (locale === 'en') continue;
    const keys = new Set(Object.keys(dict));
    const missing = [...enKeys].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !enKeys.has(k));
    assert.deepEqual(missing, [], `i18n.${locale} is missing keys present in i18n.en: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `i18n.${locale} has keys absent from i18n.en: ${extra.join(', ')}`);
  }
});
