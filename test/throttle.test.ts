import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexerThrottle } from '../src/indexers/throttle';
import type { IndexerRow } from '../src/db/rows';

const indexer = (over: Partial<IndexerRow> = {}): IndexerRow =>
  ({ id: 1, name: 'test', requestDelay: 2, ...over }) as IndexerRow;

test('cooldown gate: fresh indexer reads ready (0ms remaining)', () => {
  const t = new IndexerThrottle();
  assert.equal(t.cooldownRemainingMs(1), 0);
});

test('cooldown gate: mid-cooldown indexer reports a positive remaining window', () => {
  const t = new IndexerThrottle();
  t.notifyFailure(indexer());
  const remaining = t.cooldownRemainingMs(1);
  assert.ok(remaining > 25_000 && remaining <= 30_000, `expected ~30s, got ${remaining}ms`);
});

test('cooldown gate: an expired cooldown reads ready again without being cleared explicitly', () => {
  const t = new IndexerThrottle();
  t.notifyFailure(indexer());
  const clock = Date.now() + 30_001;
  const originalNow = Date.now;
  Date.now = () => clock;
  try {
    assert.equal(t.cooldownRemainingMs(1), 0);
    assert.equal(t.getCooldown(1), null);
  } finally {
    Date.now = originalNow;
  }
});

test('run(): requestDelay=0 lets a second call fire immediately after the first resolves', async () => {
  const t = new IndexerThrottle();
  const ix = indexer({ requestDelay: 0 });
  const order: number[] = [];
  await Promise.all([
    t.run(ix, async () => {
      order.push(1);
    }),
    t.run(ix, async () => {
      order.push(2);
    }),
  ]);
  const elapsed = await (async () => {
    const start = Date.now();
    await t.run(ix, async () => undefined);
    return Date.now() - start;
  })();
  assert.deepEqual(order, [1, 2]);
  assert.ok(elapsed < 100, `expected near-instant with requestDelay=0, took ${elapsed}ms`);
});

test('run(): a negative requestDelay is clamped to 0, not treated as "run in the past"', async () => {
  const t = new IndexerThrottle();
  const ix = indexer({ requestDelay: -5 });
  const start = Date.now();
  await t.run(ix, async () => undefined);
  await t.run(ix, async () => undefined);
  assert.ok(Date.now() - start < 100, 'two calls back-to-back with a negative delay must not wait');
});

test('run(): an absurdly large requestDelay serialises the second call behind it (bounded wait, not run in this test)', async () => {
  const t = new IndexerThrottle();
  const ix = indexer({ requestDelay: 999_999 });
  await t.run(ix, async () => undefined);
  const raced = await Promise.race([
    t.run(ix, async () => 'ran'),
    new Promise((r) => setTimeout(() => r('still-waiting'), 150)),
  ]);
  assert.equal(raced, 'still-waiting', 'the second call must still be queued behind the ~11.5-day gate');
});

test('escalation ladder: 1st=30s, 2nd(after window)=2min, no escalation on failures inside an open window', () => {
  const t = new IndexerThrottle();
  t.notifyFailure(indexer());
  assert.ok(t.cooldownRemainingMs(1) <= 30_000);

  const afterFirst = t.cooldownRemainingMs(1);
  t.notifyFailure(indexer()); // inside the open window — must not escalate
  assert.ok(t.cooldownRemainingMs(1) <= afterFirst);
});

test('Retry-After (seconds) opens a cooldown of that exact window', () => {
  const t = new IndexerThrottle();
  t.setRetryAfter(indexer(), '120');
  const remaining = t.cooldownRemainingMs(1);
  assert.ok(remaining > 110_000 && remaining <= 120_000, `expected ~120s, got ${remaining}ms`);
});

test('clearCooldown lifts both the skip gate and the queue gate together', async () => {
  const t = new IndexerThrottle();
  t.setRetryAfter(indexer(), '3600');
  assert.equal(t.clearCooldown(1), true);
  assert.equal(t.cooldownRemainingMs(1), 0);
  const ran = await Promise.race([
    t.run(indexer(), async () => 'ok'),
    new Promise((r) => setTimeout(() => r('timeout'), 200)),
  ]);
  assert.equal(ran, 'ok', 'if the queue gate had been left set, this would sleep out the hour instead');
});
