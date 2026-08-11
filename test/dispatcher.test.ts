import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import type { Socket } from 'net';
import { attachDispatcher } from '../src/dispatcher';

/** Minimal stand-in for `net.Socket` — dispatcher only ever calls `.on`,
 *  `.write` and `.destroy` on it. */
class FakeSocket extends EventEmitter {
  written: Buffer[] = [];
  destroyed = false;
  write(data: Buffer): boolean {
    this.written.push(data);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
  }
  feed(text: string): void {
    this.emit('data', Buffer.from(text, 'utf8'));
  }
  repliesAsJson(): unknown[] {
    return this.written.map((b) => JSON.parse(b.toString('utf8').trimEnd()));
  }
}

test('answers a request via the matching handler', async () => {
  const socket = new FakeSocket();
  attachDispatcher(
    socket as unknown as Socket,
    { hello: async () => ({ manifest: {}, token: 'abc' }) },
    {},
  );
  socket.feed('{"i":1,"m":"hello","p":{}}\n');
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(socket.repliesAsJson(), [{ i: 1, r: { manifest: {}, token: 'abc' } }]);
});

test('replies with an error frame when the handler rejects', async () => {
  const socket = new FakeSocket();
  attachDispatcher(
    socket as unknown as Socket,
    {
      health: async () => {
        throw new Error('boom');
      },
    },
    {},
  );
  socket.feed('{"i":2,"m":"health"}\n');
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(socket.repliesAsJson(), [{ i: 2, e: { c: 'ERR', m: 'boom' } }]);
});

test('replies with ERR_NO_METHOD for an unknown method', async () => {
  const socket = new FakeSocket();
  attachDispatcher(socket as unknown as Socket, {}, {});
  socket.feed('{"i":3,"m":"nope"}\n');
  await new Promise((r) => setImmediate(r));

  const replies = socket.repliesAsJson() as { e: { c: string } }[];
  assert.equal(replies[0]?.e.c, 'ERR_NO_METHOD');
});

test('routes a note to its handler and never replies to it', async () => {
  const socket = new FakeSocket();
  let received: unknown = null;
  attachDispatcher(socket as unknown as Socket, {}, { event: (p) => (received = p) });
  socket.feed('{"m":"event","p":{"name":"media.imported","payload":{"id":1}}}\n');
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(received, { name: 'media.imported', payload: { id: 1 } });
  assert.equal(socket.written.length, 0);
});

test('destroys the socket on a malformed line', async () => {
  const socket = new FakeSocket();
  attachDispatcher(socket as unknown as Socket, {}, {});
  socket.feed('not json\n');
  assert.equal(socket.destroyed, true);
});

test('a slow handler does not block a faster one queued behind it on the same socket', async () => {
  const socket = new FakeSocket();
  let resolveSlow!: (v?: unknown) => void;
  attachDispatcher(
    socket as unknown as Socket,
    {
      slow: () => new Promise((r) => (resolveSlow = r)).then(() => ({ done: 'slow' })),
      fast: async () => ({ done: 'fast' }),
    },
    {},
  );
  socket.feed('{"i":1,"m":"slow"}\n{"i":2,"m":"fast"}\n');
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(socket.repliesAsJson(), [{ i: 2, r: { done: 'fast' } }], 'the fast reply lands while the slow one is still pending');

  resolveSlow();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(socket.repliesAsJson(), [{ i: 2, r: { done: 'fast' } }, { i: 1, r: { done: 'slow' } }]);
});

test('destroys the socket on an oversize frame', async () => {
  const socket = new FakeSocket();
  attachDispatcher(socket as unknown as Socket, {}, {});
  socket.feed('x'.repeat(4 * 1024 * 1024 + 1) + '\n');
  assert.equal(socket.destroyed, true);
});
