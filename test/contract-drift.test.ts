/**
 * The host contract is core's to change, and it does: two methods and a scope were
 * removed once the blocklist moved into this plugin, and a required field was added
 * to `releases.score`. A stale copy here does not fail to compile — it fails at
 * install, as `PLUGIN_BAD_MANIFEST`. So the drift check belongs in the default test
 * loop, not only in a release step.
 *
 * Skips loudly without a sibling Fliks checkout (CI has none — Fliks is a separate
 * repo), rather than passing silently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import * as path from 'path';

const FLIKS_REPO =
  process.env.FLIKS_REPO ?? path.join(__dirname, '..', '..', 'fliks');
const CORE_CONTRACT = path.join(
  FLIKS_REPO,
  'backend/src/common/plugin-contract/host-methods.ts',
);

test('the host contract matches core, method for method', (t) => {
  if (!fs.existsSync(CORE_CONTRACT)) {
    t.skip(
      `no Fliks checkout at ${FLIKS_REPO} — set FLIKS_REPO to check the contract for drift`,
    );
    return;
  }
  const out = execFileSync(
    'npx',
    ['tsx', path.join(__dirname, '..', 'scripts', 'check-contract-drift.ts')],
    { encoding: 'utf8', env: { ...process.env, FLIKS_REPO } },
  );
  assert.match(out, /OK: PluginHostApi/);
});
