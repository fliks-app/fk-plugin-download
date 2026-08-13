import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HostClient, HostCallError, MAX_OUTSTANDING_CALLS } from '../src/host-client';
import { FrameReader, encodeFrame, parseFrame, type Req } from '../src/protocol';

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Stands in for core's own RPC channel on `FLIKS_CORE_SOCK`: a real unix socket the
 *  client dials into, so these tests drive `HostClient`'s actual `net.Socket` handling. */
class CoreStub {
  socket: net.Socket | null = null;
  readonly received: Req[] = [];
  private readonly reader = new FrameReader();

  private constructor(
    private readonly dir: string,
    readonly sockPath: string,
    private readonly server: net.Server,
  ) {}

  static async start(): Promise<CoreStub> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-client-test-'));
    const sockPath = path.join(dir, 'core.sock');
    const server = net.createServer();
    const stub = new CoreStub(dir, sockPath, server);
    server.on('connection', (socket) => {
      stub.socket = socket;
      socket.on('data', (chunk: Buffer) => {
        for (const line of stub.reader.push(chunk)) stub.received.push(parseFrame(line) as Req);
      });
    });
    await new Promise<void>((r) => server.listen(sockPath, r));
    return stub;
  }

  reply(id: number, r: unknown): void {
    this.socket!.write(encodeFrame({ i: id, r }));
  }

  replyError(id: number, c: string, m: string): void {
    this.socket!.write(encodeFrame({ i: id, e: { c, m } }));
  }

  sendRaw(text: string): void {
    this.socket!.write(Buffer.from(text, 'utf8'));
  }

  closeConnection(): void {
    this.socket?.destroy();
  }

  async stop(): Promise<void> {
    this.socket?.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

async function connectedClient(core: CoreStub): Promise<HostClient> {
  const client = new HostClient(core.sockPath);
  client.connect();
  await waitUntil(() => client.isConnected);
  return client;
}

test('correlates concurrent calls to their matching reply by id, regardless of reply order', async () => {
  const core = await CoreStub.start();
  const client = await connectedClient(core);

  const p1 = client.call('media.exists', { mediaIds: [1] });
  const p2 = client.call('media.exists', { mediaIds: [2] });
  await waitUntil(() => core.received.length >= 2);

  const [req1, req2] = core.received;
  core.reply(req2!.i, [2]); // reply out of send order, on purpose
  core.reply(req1!.i, [1]);

  assert.deepEqual(await p1, [1]);
  assert.deepEqual(await p2, [2]);
  await core.stop();
});

test('rejects with the core error code/message on an error reply', async () => {
  const core = await CoreStub.start();
  const client = await connectedClient(core);

  const call = client.call('media.exists', { mediaIds: [1] });
  await waitUntil(() => core.received.length >= 1);
  core.replyError(core.received[0]!.i, 'ERR_SCOPE', 'not permitted');

  await assert.rejects(call, (err: Error) => {
    assert.ok(err instanceof HostCallError);
    assert.equal(err.outcome, 'rejected', 'core answered — definitive, not retryable');
    assert.equal((err as HostCallError).code, 'ERR_SCOPE');
    return true;
  });
  await core.stop();
});

test('carries a core code the client has never seen without throwing', async () => {
  const core = await CoreStub.start();
  const client = await connectedClient(core);

  const call = client.call('media.exists', { mediaIds: [1] });
  await waitUntil(() => core.received.length >= 1);
  core.replyError(core.received[0]!.i, 'ERR_TOTALLY_NEW', 'from a future core release');

  await assert.rejects(call, (err: Error) => {
    assert.ok(err instanceof HostCallError);
    assert.equal(err.outcome, 'rejected');
    assert.equal((err as HostCallError).code, 'ERR_TOTALLY_NEW');
    assert.match(err.message, /ERR_TOTALLY_NEW: from a future core release/);
    return true;
  });
  await core.stop();
});

test('leaves code unset for an unknown outcome — core never answered', async () => {
  const core = await CoreStub.start();
  const client = await connectedClient(core);

  const call = client.call('media.exists', { mediaIds: [1] }, 100);
  await assert.rejects(call, (err: Error) => {
    assert.ok(err instanceof HostCallError);
    assert.equal(err.outcome, 'unknown');
    assert.equal((err as HostCallError).code, undefined);
    return true;
  });
  await core.stop();
});

test('a call times out and rejects rather than hanging, without affecting other outstanding calls', async () => {
  const core = await CoreStub.start();
  const client = await connectedClient(core);

  const slow = client.call('media.exists', { mediaIds: [1] }, 100);
  const fast = client.call('media.exists', { mediaIds: [2] }, 5000);
  await waitUntil(() => core.received.length >= 2);
  core.reply(core.received[1]!.i, [2]);

  await assert.rejects(slow, (err: Error) => {
    assert.ok(err instanceof HostCallError);
    assert.match(err.message, /timed out after 100ms/);
    assert.equal(err.outcome, 'unknown', 'core may still finish the work after the deadline');
    return true;
  });
  assert.deepEqual(await fast, [2]);
  await core.stop();
});

test('a protocol violation from core fails every outstanding call rather than wedging the client', async () => {
  const core = await CoreStub.start();
  const client = await connectedClient(core);

  const p1 = client.call('media.exists', { mediaIds: [1] });
  const p2 = client.call('media.exists', { mediaIds: [2] });
  await waitUntil(() => core.received.length >= 2);

  core.sendRaw('not json\n');

  const isUnknown = (err: Error): boolean => {
    assert.ok(err instanceof HostCallError);
    assert.equal(err.outcome, 'unknown');
    return true;
  };
  await assert.rejects(p1, isUnknown);
  await assert.rejects(p2, isUnknown);
  await waitUntil(() => !client.isConnected);
  await core.stop();
});

test('a lost connection fails every outstanding call', async () => {
  const core = await CoreStub.start();
  const client = await connectedClient(core);

  const call = client.call('media.exists', { mediaIds: [1] });
  await waitUntil(() => core.received.length >= 1);
  core.closeConnection();

  await assert.rejects(call, (err: Error) => {
    assert.ok(err instanceof HostCallError);
    assert.equal(err.outcome, 'unknown', 'core may have processed the call before the socket dropped');
    return true;
  });
  await core.stop();
});

test('rejects immediately when not connected, rather than queuing', async () => {
  const client = new HostClient('/nonexistent/sock/path/for/test');
  await assert.rejects(client.call('media.exists', { mediaIds: [1] }), (err: Error) => {
    assert.ok(err instanceof HostCallError);
    assert.equal(err.outcome, 'unknown');
    return true;
  });
});

test('bounds outstanding calls: the (n+1)th rejects rather than growing the map without limit', async () => {
  const core = await CoreStub.start();
  const client = await connectedClient(core);

  const calls = [];
  for (let i = 0; i < MAX_OUTSTANDING_CALLS; i++) {
    calls.push(client.call('media.exists', { mediaIds: [i] }, 5000));
  }
  await assert.rejects(client.call('media.exists', { mediaIds: [999] }), (err: Error) => {
    assert.match(err.message, /too many outstanding/);
    assert.ok(err instanceof HostCallError);
    assert.equal(err.outcome, 'unknown');
    return true;
  });

  await waitUntil(() => core.received.length >= MAX_OUTSTANDING_CALLS);
  for (const req of core.received) core.reply(req.i, []);
  await Promise.all(calls);
  await core.stop();
});
