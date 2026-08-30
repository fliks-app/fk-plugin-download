import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBaseUrl, QbittorrentDriver } from '../src/download-clients/qbittorrent-driver';
import {
  DownloadClientHttpError,
  ReleaseUnobtainableError,
  TorrentAlreadyPresentError,
  TorrentHashUnresolvedError,
} from '../src/download-clients/types';
import type { DownloadClientRow } from '../src/db/rows';
import { log } from '../src/log';
import { FakeQbitServer, makeTorrent } from './fake-qbittorrent-server';

const CREDS = { username: 'admin', password: 'S3cr3t-Pw!' };

/** Only the stop/start/pause/resume calls, in order — login and info are noise here. */
function controlPaths(server: FakeQbitServer): string[] {
  return server.requests.filter((r) => /\/(stop|start|pause|resume)$/.test(r.path)).map((r) => r.path);
}

function clientFor(url: string, over: Partial<Record<string, unknown>> = {}): DownloadClientRow {
  const u = new URL(url);
  return {
    id: 1,
    name: 'test-client',
    implementation: 'qbittorrent',
    enabled: true,
    priority: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    settings: { host: u.hostname, port: Number(u.port), useSsl: false, ...CREDS, ...over },
  };
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originals = { info: log.info, warn: log.warn, error: log.error };
  log.info = (m: string) => void lines.push(m);
  log.warn = (m: string) => void lines.push(m);
  log.error = (m: string) => void lines.push(m);
  return {
    lines,
    restore: () => {
      log.info = originals.info;
      log.warn = originals.warn;
      log.error = originals.error;
    },
  };
}

// ---------------------------------------------------------------------------
// buildBaseUrl
// ---------------------------------------------------------------------------

test('buildBaseUrl: bare host + explicit port, no scheme', () => {
  assert.equal(buildBaseUrl({ host: '10.0.0.5', port: 8080 }), 'http://10.0.0.5:8080');
});

test('buildBaseUrl: host already carrying a scheme and port is normalised', () => {
  assert.equal(buildBaseUrl({ host: 'https://qbit.example:9999/', useSsl: true }), 'https://qbit.example:9999');
});

test('buildBaseUrl: explicit port overrides one embedded in the host', () => {
  assert.equal(buildBaseUrl({ host: 'qbit.example:8080', port: 9090 }), 'http://qbit.example:9090');
});

test('buildBaseUrl: empty host returns null', () => {
  assert.equal(buildBaseUrl({ host: '' }), null);
});

// ---------------------------------------------------------------------------
// The getTorrentsResult adversarial table
// ---------------------------------------------------------------------------

test('getTorrentsResult: reachable client with torrents -> ok:true, torrents=[...]', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [makeTorrent({ hash: 'a'.repeat(40), name: 'X' })] });
  try {
    const driver = new QbittorrentDriver();
    const result = await driver.getTorrentsResult(clientFor(server.url));
    assert.equal(result.ok, true);
    assert.equal(result.torrents.length, 1);
    assert.equal(result.torrents[0]?.hash, 'a'.repeat(40));
  } finally {
    await server.close();
  }
});

test('getTorrentsResult: reachable client with none -> ok:true, torrents=[]', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [] });
  try {
    const driver = new QbittorrentDriver();
    const result = await driver.getTorrentsResult(clientFor(server.url));
    assert.deepEqual(result, { ok: true, torrents: [] });
  } finally {
    await server.close();
  }
});

test('getTorrentsResult: wrong credentials -> ok:false, torrents=[]', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [makeTorrent()] });
  try {
    const driver = new QbittorrentDriver();
    const result = await driver.getTorrentsResult(clientFor(server.url, { password: 'not-the-password' }));
    assert.deepEqual(result, { ok: false, torrents: [] });
  } finally {
    await server.close();
  }
});

test('getTorrentsResult: connection refused -> ok:false, torrents=[]', async () => {
  const driver = new QbittorrentDriver();
  const result = await driver.getTorrentsResult(clientFor('http://127.0.0.1:39999'));
  assert.deepEqual(result, { ok: false, torrents: [] });
});

test('getTorrentsResult: a 500 -> ok:false, torrents=[]', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [makeTorrent()] });
  server.infoStatus = 500;
  try {
    const driver = new QbittorrentDriver();
    const result = await driver.getTorrentsResult(clientFor(server.url));
    assert.deepEqual(result, { ok: false, torrents: [] });
  } finally {
    await server.close();
  }
});

test('getTorrentsResult: a body that is not JSON -> ok:false, torrents=[]', async () => {
  const server = await FakeQbitServer.start({ ...CREDS });
  server.infoMode = 'not-json';
  try {
    const driver = new QbittorrentDriver();
    const result = await driver.getTorrentsResult(clientFor(server.url));
    assert.deepEqual(result, { ok: false, torrents: [] });
  } finally {
    await server.close();
  }
});

test('getTorrentsResult: a body that is JSON but not an array -> ok:false, torrents=[]', async () => {
  const server = await FakeQbitServer.start({ ...CREDS });
  server.infoMode = 'not-array';
  try {
    const driver = new QbittorrentDriver();
    const result = await driver.getTorrentsResult(clientFor(server.url));
    assert.deepEqual(result, { ok: false, torrents: [] });
  } finally {
    await server.close();
  }
});

test('getTorrentsResult: a missing host -> ok:false, torrents=[], no network call', async () => {
  const driver = new QbittorrentDriver();
  const client = { ...clientFor('http://placeholder'), settings: {} };
  const result = await driver.getTorrentsResult(client);
  assert.deepEqual(result, { ok: false, torrents: [] });
});

// ---------------------------------------------------------------------------
// Authentication flow + cookie handling
// ---------------------------------------------------------------------------

test('the driver sends back exactly the cookie the login response issued', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [] });
  try {
    const driver = new QbittorrentDriver();
    await driver.getTorrentsResult(clientFor(server.url));
    const infoReq = server.requests.find((r) => r.path === '/api/v2/torrents/info');
    assert.ok(infoReq?.cookie?.includes('SID='), 'the SID cookie from Set-Cookie must be replayed');
    assert.ok(infoReq?.cookie?.includes('other=x'), 'a second Set-Cookie header must be joined in too');
  } finally {
    await server.close();
  }
});

test('getTorrents() unwraps getTorrentsResult() to the bare torrent list', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [makeTorrent({ hash: 'd'.repeat(40) })] });
  try {
    const driver = new QbittorrentDriver();
    const torrents = await driver.getTorrents(clientFor(server.url));
    assert.equal(torrents.length, 1);
    assert.equal(torrents[0]?.hash, 'd'.repeat(40));
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// testConnection
// ---------------------------------------------------------------------------

test('testConnection: ok on valid credentials', async () => {
  const server = await FakeQbitServer.start({ ...CREDS });
  try {
    const driver = new QbittorrentDriver();
    const result = await driver.testConnection({ host: new URL(server.url).hostname, port: Number(new URL(server.url).port), ...CREDS });
    assert.deepEqual(result, { ok: true, messageKey: 'download.download_clients.test.ok' });
  } finally {
    await server.close();
  }
});

test('testConnection: auth_failed on wrong credentials, without leaking the password', async () => {
  const server = await FakeQbitServer.start({ ...CREDS });
  try {
    const driver = new QbittorrentDriver();
    const result = await driver.testConnection({
      host: new URL(server.url).hostname,
      port: Number(new URL(server.url).port),
      username: 'admin',
      password: 'wrong-password',
    });
    assert.equal(result.ok, false);
    assert.equal(result.messageKey, 'download.download_clients.test.auth_failed');
    assert.equal(JSON.stringify(result).includes('wrong-password'), false);
  } finally {
    await server.close();
  }
});

test('testConnection: host_missing without any network call', async () => {
  const driver = new QbittorrentDriver();
  const result = await driver.testConnection({});
  assert.deepEqual(result, { ok: false, messageKey: 'download.download_clients.test.host_missing' });
});

test('testConnection: network_error on connection refused', async () => {
  const driver = new QbittorrentDriver();
  const result = await driver.testConnection({ host: '127.0.0.1', port: 39999 });
  assert.equal(result.ok, false);
  assert.equal(result.messageKey, 'download.download_clients.test.network_error');
});

// ---------------------------------------------------------------------------
// addTorrentUrl
// ---------------------------------------------------------------------------

const MAGNET_HASH = 'e'.repeat(40);
const magnetFor = (hash: string) => `magnet:?xt=urn:btih:${hash}&dn=Some+Release`;

test('addTorrentUrl: resolves the hash on a magnet add', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [] });
  try {
    const driver = new QbittorrentDriver();
    const hash = await driver.addTorrentUrl(clientFor(server.url), magnetFor(MAGNET_HASH));
    assert.equal(hash, MAGNET_HASH);
    assert.ok(server.torrents.some((t) => t.hash === MAGNET_HASH));
  } finally {
    await server.close();
  }
});

test('addTorrentUrl: resolves the hash via redirect-to-magnet from an indexer URL', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [] });
  try {
    const driver = new QbittorrentDriver();
    const hash = await driver.addTorrentUrl(clientFor(server.url), `${server.url}/indexer/magnet-redirect`);
    assert.equal(hash, 'b'.repeat(40));
  } finally {
    await server.close();
  }
});

test('addTorrentUrl: downloads and adds a .torrent file, computing the hash itself', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [], nextAddHash: 'f'.repeat(40) });
  try {
    const driver = new QbittorrentDriver();
    const hash = await driver.addTorrentUrl(clientFor(server.url), `${server.url}/indexer/torrent-file`);
    // The bencode fixture's info dict is `d4:name5:hello12:piece lengthi16384ee`.
    const { createHash } = await import('crypto');
    const expected = createHash('sha1').update(Buffer.from('d4:name5:hello12:piece lengthi16384ee')).digest('hex');
    assert.equal(hash, expected);
  } finally {
    await server.close();
  }
});

test('addTorrentUrl: rejects on a duplicate hash when asked to', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [makeTorrent({ hash: MAGNET_HASH })] });
  try {
    const driver = new QbittorrentDriver();
    await assert.rejects(
      () => driver.addTorrentUrl(clientFor(server.url), magnetFor(MAGNET_HASH), undefined, true),
      TorrentAlreadyPresentError,
    );
  } finally {
    await server.close();
  }
});

test('addTorrentUrl: does NOT reject on a duplicate hash when rejectIfAlreadyPresent is left off', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [makeTorrent({ hash: MAGNET_HASH })] });
  try {
    const driver = new QbittorrentDriver();
    const hash = await driver.addTorrentUrl(clientFor(server.url), magnetFor(MAGNET_HASH));
    assert.equal(hash, MAGNET_HASH);
  } finally {
    await server.close();
  }
});

test('addTorrentUrl: never resolves with an empty value — rejects when the hash cannot be determined', async () => {
  // No btih in the magnet -> no upfront hash. The fake server's add fallback hash
  // ("c" x40, the driver's own request carries no other one) is already present,
  // so the add is a genuine qBit-style no-op: the list-diff recovery sees zero
  // "fresh" torrents on every one of its 6 polls and must reject rather than
  // resolve with an empty string.
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [makeTorrent({ hash: 'c'.repeat(40) })] });
  try {
    const driver = new QbittorrentDriver();
    await assert.rejects(
      () => driver.addTorrentUrl(clientFor(server.url), 'magnet:?dn=no-hash-here'),
      TorrentHashUnresolvedError,
    );
  } finally {
    await server.close();
  }
});

test('addTorrentUrl: a non-200 add response rejects, never resolves', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [] });
  server.addStatus = 500;
  try {
    const driver = new QbittorrentDriver();
    await assert.rejects(() => driver.addTorrentUrl(clientFor(server.url), magnetFor(MAGNET_HASH)));
  } finally {
    await server.close();
  }
});

test('addTorrentUrl: propagates a login failure as a rejection, never as an empty hash', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [] });
  try {
    const driver = new QbittorrentDriver();
    await assert.rejects(() => driver.addTorrentUrl(clientFor(server.url, { password: 'wrong' }), magnetFor(MAGNET_HASH)));
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// deleteTorrent / getTorrentFilesResult
// ---------------------------------------------------------------------------

test('deleteTorrent: removes the torrent from the fake client', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [makeTorrent({ hash: MAGNET_HASH })] });
  try {
    const driver = new QbittorrentDriver();
    await driver.deleteTorrent(clientFor(server.url), MAGNET_HASH, true);
    assert.equal(server.torrents.length, 0);
  } finally {
    await server.close();
  }
});

test('deleteTorrent: rejects when the client refuses with a non-200', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [makeTorrent({ hash: MAGNET_HASH })] });
  server.deleteStatus = 409;
  try {
    const driver = new QbittorrentDriver();
    await assert.rejects(() => driver.deleteTorrent(clientFor(server.url), MAGNET_HASH));
  } finally {
    await server.close();
  }
});

test('getTorrentFilesResult: ok:true with the fake client\'s file list', async () => {
  const server = await FakeQbitServer.start({ ...CREDS });
  server.files = [{ name: 'movie.mkv', size: 123, progress: 1, priority: 1 }];
  try {
    const driver = new QbittorrentDriver();
    const result = await driver.getTorrentFilesResult(clientFor(server.url), MAGNET_HASH);
    assert.deepEqual(result, { ok: true, files: server.files });
  } finally {
    await server.close();
  }
});

test('getTorrentFilesResult: ok:false (not a throw) when the body is not an array', async () => {
  const server = await FakeQbitServer.start({ ...CREDS });
  server.filesMode = 'not-array';
  try {
    const driver = new QbittorrentDriver();
    const result = await driver.getTorrentFilesResult(clientFor(server.url), MAGNET_HASH);
    assert.deepEqual(result, { ok: false, files: [] });
  } finally {
    await server.close();
  }
});

test('getTorrentFilesResult: connection refused -> ok:false, files=[]', async () => {
  const driver = new QbittorrentDriver();
  const result = await driver.getTorrentFilesResult(clientFor('http://127.0.0.1:39999'), MAGNET_HASH);
  assert.deepEqual(result, { ok: false, files: [] });
});

// ---------------------------------------------------------------------------
// The secret: redaction never leaks the password into anything logged
// ---------------------------------------------------------------------------

test('a connection failure with a password in settings never logs the password', async () => {
  const capture = captureLogs();
  let testConnectionResult: unknown;
  try {
    const driver = new QbittorrentDriver();
    const client = clientFor('http://127.0.0.1:39999', { password: 'S3cr3t-Pw!' });
    await driver.getTorrentsResult(client); // unreachable -> hits the warn path
    testConnectionResult = await driver.testConnection(client.settings); // network_error path, detail carries e.message
  } finally {
    capture.restore();
  }
  assert.ok(capture.lines.length > 0, 'expected the failure path to actually log something, or this assertion is vacuous');
  const joined = capture.lines.join('\n');
  assert.equal(joined.includes('S3cr3t-Pw!'), false, `password leaked into logs:\n${joined}`);
  assert.equal(
    JSON.stringify(testConnectionResult).includes('S3cr3t-Pw!'),
    false,
    `password leaked into testConnection's own result: ${JSON.stringify(testConnectionResult)}`,
  );
});

test('pause and resume speak qBittorrent 5.x first', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [makeTorrent()] });
  try {
    const driver = new QbittorrentDriver();
    await driver.pauseTorrent(clientFor(server.url), 'a'.repeat(40));
    await driver.resumeTorrent(clientFor(server.url), 'a'.repeat(40));
    assert.deepEqual(
      controlPaths(server),
      ['/api/v2/torrents/stop', '/api/v2/torrents/start'],
      'no wasted round trip against a 5.x client',
    );
  } finally {
    await server.close();
  }
});

test('VERDICT: a 4.x client that 404s the new spelling still pauses, via the old one', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [makeTorrent()] });
  server.controlGeneration = 'v4';
  try {
    await new QbittorrentDriver().pauseTorrent(clientFor(server.url), 'a'.repeat(40));
    assert.deepEqual(controlPaths(server), ['/api/v2/torrents/stop', '/api/v2/torrents/pause']);
  } finally {
    await server.close();
  }
});

test('a refusal neither spelling answers is reported, never swallowed as success', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [makeTorrent()] });
  server.controlGeneration = 'none';
  try {
    await assert.rejects(() => new QbittorrentDriver().pauseTorrent(clientFor(server.url), 'a'.repeat(40)));
  } finally {
    await server.close();
  }
});

test('VERDICT: a torrent the client already holds is reused, not re-added', async () => {
  const held = makeTorrent({ hash: 'a'.repeat(40) });
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [held] });
  try {
    const hash = await new QbittorrentDriver().addTorrentUrl(
      clientFor(server.url),
      `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
    );
    assert.equal(hash, 'a'.repeat(40));
    // The add is what qBittorrent answers 409 to; not making it is the fix.
    assert.equal(server.requests.some((r) => r.path === '/api/v2/torrents/add'), false);
  } finally {
    await server.close();
  }
});

test('a torrent it does not hold is added as before', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [] });
  try {
    await new QbittorrentDriver().addTorrentUrl(clientFor(server.url), `magnet:?xt=urn:btih:${'b'.repeat(40)}`);
    assert.ok(server.requests.some((r) => r.path === '/api/v2/torrents/add'));
  } finally {
    await server.close();
  }
});

test('an unattended grab still refuses a torrent already held, without adding it', async () => {
  const held = makeTorrent({ hash: 'a'.repeat(40) });
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [held] });
  try {
    await assert.rejects(
      () =>
        new QbittorrentDriver().addTorrentUrl(
          clientFor(server.url),
          `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
          undefined,
          true,
        ),
      TorrentAlreadyPresentError,
    );
    assert.equal(server.requests.some((r) => r.path === '/api/v2/torrents/add'), false);
  } finally {
    await server.close();
  }
});

test('VERDICT: a torrent held in the managed category is reused; one held outside it is not touched', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [makeTorrent({ hash: 'a'.repeat(40) })] });
  server.categoryByHash.set('a'.repeat(40), 'someone-elses');
  try {
    // The snapshot is scoped to the client's own category, so this torrent is not "held" to us.
    // qBittorrent then answers the add with 409, and that is a release we cannot have.
    server.addStatus = 409;
    await assert.rejects(
      () =>
        new QbittorrentDriver().addTorrentUrl(
          clientFor(server.url, { category: 'fliks' }),
          `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
        ),
      ReleaseUnobtainableError,
    );
    // Never recategorised: it is a download the user arranged themselves.
    assert.equal(server.categoryByHash.get('a'.repeat(40)), 'someone-elses');
    assert.equal(server.requests.some((r) => r.path.endsWith('/setCategory')), false);
  } finally {
    await server.close();
  }
});

test('a client refusal that is not a duplicate stays a client error, so no other release is tried', async () => {
  const server = await FakeQbitServer.start({ ...CREDS, torrents: [] });
  server.addStatus = 415;
  try {
    await assert.rejects(
      () => new QbittorrentDriver().addTorrentUrl(clientFor(server.url), `magnet:?xt=urn:btih:${'b'.repeat(40)}`),
      DownloadClientHttpError,
    );
  } finally {
    await server.close();
  }
});
