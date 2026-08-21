/** Ported from `stall-config.util.ts` — `samples` unset must return `null`,
 *  never a default that starts deleting torrents. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getStallConfig } from '../src/grab/stall-config';
import { FakeHost } from './grab-test-helpers';

describe('getStallConfig', () => {
  test('returns null when config.get reports no keys at all (fresh install)', async () => {
    const host = new FakeHost().on('config.get', () => ({}));
    assert.equal(await getStallConfig(host), null);
  });

  test('returns null when samples is present but not a number', async () => {
    const host = new FakeHost().on('config.get', () => ({ stall_samples: 'not-a-number' }));
    assert.equal(await getStallConfig(host), null);
  });

  test('returns null when samples is below the 2-sample minimum', async () => {
    const host = new FakeHost().on('config.get', () => ({ stall_samples: '1' }));
    assert.equal(await getStallConfig(host), null);
  });

  test('returns a config once samples is validly set, defaulting interval to 60m and autoRestart to the manifest default', async () => {
    const host = new FakeHost().on('config.get', () => ({ stall_samples: '3' }));
    assert.deepEqual(await getStallConfig(host), { samples: 3, intervalMinutes: 60, autoRestart: true, includeManualGrabs: false });
  });

  test('an explicitly disabled autoRestart is honoured', async () => {
    const host = new FakeHost().on('config.get', () => ({ stall_samples: '3', stall_auto_restart: 'false' }));
    assert.equal((await getStallConfig(host))?.autoRestart, false);
  });

  test('honours an explicit interval/autoRestart/includeManualGrabs', async () => {
    const host = new FakeHost().on('config.get', () => ({
      stall_samples: '4',
      stall_interval_minutes: '20',
      stall_auto_restart: 'true',
      stall_include_manual_grabs: 'true',
    }));
    assert.deepEqual(await getStallConfig(host), { samples: 4, intervalMinutes: 20, autoRestart: true, includeManualGrabs: true });
  });
});
