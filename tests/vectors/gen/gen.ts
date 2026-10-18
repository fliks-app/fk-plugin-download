// Golden vectors from the TypeScript plugin. Run from a checkout of v0.12.1 with `npm ci`:
//   npx tsx tests/vectors/gen/gen.ts > tests/vectors/golden.json
import { MIGRATIONS } from '../../../migrations';
import { decodeHtmlEntities } from '../../../src/indexers/decode-html-entities';
import { buildTorznabQuery, describeTorznabQuery, parseTorznabItems } from '../../../src/indexers/torznab-parse';
import { extractMagnetInfoHash, computeInfoHash } from '../../../src/download-clients/torrent-hash';
import { normaliseTorrentName } from '../../../src/grab/torrent-name-matcher';
import { countStalledStrikes } from '../../../src/download-clients/stalled-progress';
import { buildBaseUrl } from '../../../src/download-clients/qbittorrent-driver';
import { mapClientStateToProgress } from '../../../src/grab/progress-state';
import { toCoverageColumns } from '../../../src/grab/grab-history';
import { mergeSecretSettings, redactSecretSettings } from '../../../src/secret-settings';
import { buildScoreRequest, pickReleases } from '../../../src/grab/release-scoring';
import { IndexerThrottle } from '../../../src/indexers/throttle';
import { createRouteTable, type RouteDeps } from '../../../src/seams/http-routes';
import type { IndexerRow } from '../../../src/db/rows';

const indexer = (settings: Record<string, unknown>): IndexerRow =>
  ({ id: 7, name: 'test-indexer', implementation: 'torznab', settings }) as IndexerRow;

const feeds: { xml: string; settings: Record<string, unknown> }[] = [
  {
    settings: { apiKey: 'k1' },
    xml: `<rss><channel><item>
    <title>Some.Movie.2024.1080p</title>
    <link>https://tracker.example/dl/abc?x=1&amp;apikey=old</link>
    <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
    <torznab:attr name="size" value="123456" />
    <torznab:attr name="seeders" value="42" />
    <torznab:attr name="leechers" value="3" />
    <torznab:attr name="downloadvolumefactor" value="0" />
  </item></channel></rss>`,
  },
  {
    settings: {},
    xml: `<rss><channel>
  <item><title><![CDATA[Berl&iacute;n S01E02 &amp; More]]></title>
    <guid>https://tracker.example/details/9</guid>
    <enclosure url="https://tracker.example/get/9?a=1&amp;b=2" length="999" type="application/x-bittorrent"/>
    <torznab:attr name="magneturl" value="magnet:?xt=urn:btih:ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD&amp;dn=x" />
    <torznab:attr name="peers" value="12" />
    <pubDate>Tue, 02 Jan 2024 10:20:30 +0100</pubDate>
  </item>
  <ITEM><title>Upper.Case.Item</title><link>magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567</link>
    <comments>https://tracker.example/c/1</comments><size>4567</size>
    <torznab:attr name="downloadvolumefactor" value="0.5" /></ITEM>
  <item><title>Local.Only</title><link>http://localhost:9117/dl/1</link></item>
  <item><title>No URL</title></item>
  <item><title>Bad.Date</title><link>https://t.example/x</link><pubDate>not a date</pubDate>
    <torznab:attr name="seeders" value="abc" /></item>
  <item><title>Iso.Date</title><link>https://t.example/y</link><pubDate>2024-03-04T05:06:07Z</pubDate></item>
</channel></rss>`,
  },
  { settings: {}, xml: `<rss><channel><item><title>Unclosed</title>` },
  {
    settings: { apiKey: 'k2' },
    xml: `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>
  <item><title>Show.S01E01.720p.WEB</title>
    <link>https://t.example/dl/1?apikey=SECRET&amp;file=a</link>
    <guid>https://t.example/details/1</guid>
    <comments>https://t.example/details/1#comments</comments>
    <pubDate>Wed, 03 Jan 2024 08:00:00 GMT</pubDate>
    <size>5000</size>
    <torznab:attr name="size" value="6000" />
    <torznab:attr name="seeders" value="0" />
    <torznab:attr name="leechers" value="5" />
    <torznab:attr name="uploadvolumefactor" value="1" />
    <torznab:attr name="downloadvolumefactor" value="1" />
  </item>
  <item><title>Peers.Only</title><link>https://t.example/dl/2</link>
    <torznab:attr name="peers" value="9" /><torznab:attr name="seeders" value="4" /></item>
  <item><title>Neg.Values</title><link>https://t.example/dl/3</link>
    <torznab:attr name="size" value="-5" /><torznab:attr name="seeders" value="-1" />
    <torznab:attr name="downloadvolumefactor" value="x" /></item>
  <item><title>Magnet.Enclosure</title>
    <enclosure url="magnet:?xt=urn:btih:ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD&amp;dn=m" length="77" type="application/x-bittorrent"/></item>
  <item><title>   </title><link>https://t.example/dl/4</link></item>
  <item><link>https://t.example/dl/5</link></item>
</channel></rss>`,
  },
  {
    settings: {},
    xml: `<rss><channel>
  <item><title><![CDATA[Cd&ata <b>Title</b>]]></title><link><![CDATA[https://t.example/dl/6?a=1&b=2]]></link></item>
  <item><title>Multi
    Line &#8211; Title &amp;amp; More</title><link>
      https://t.example/dl/7
    </link></item>
  <item><title>Attr.Order</title><link>https://t.example/dl/8</link>
    <torznab:attr value="33" name="seeders"/><torznab:attr name='leechers' value='2'/></item>
  <item><title>Freeleech</title><link>https://t.example/dl/9</link>
    <torznab:attr name="downloadvolumefactor" value="0.0"/><torznab:attr name="seeders" value="1.9"/></item>
</channel></rss>`,
  },
  {
    settings: { baseUrl: 'https://t.example/api', apiKey: 'zz' },
    xml: `<rss><channel>
  <item><title>Relative.Link</title><link>/dl/10</link></item>
  <item><title>Ftp.Link</title><link>ftp://t.example/dl/11</link></item>
  <item><title>Lan.Link</title><link>http://127.0.0.1:9117/dl/12</link></item>
  <item><title>Loopback6</title><link>http://[::1]/dl/13</link></item>
  <item><title>Info.Hash.Only</title><torznab:attr name="infohash" value="0123456789abcdef0123456789abcdef01234567"/></item>
  <item><title>Tz.Date</title><link>https://t.example/dl/14</link><pubDate>Fri, 05 Jan 2024 23:30:00 -0500</pubDate></item>
</channel></rss>`,
  },
  { settings: {}, xml: `` },
  { settings: {}, xml: `<rss><channel></channel></rss>` },
  { settings: {}, xml: `<error code="100" description="Incorrect user credentials"/>` },
];

function bencode(v: unknown): Buffer {
  if (typeof v === 'number') return Buffer.from(`i${v}e`);
  if (typeof v === 'string') return Buffer.concat([Buffer.from(`${Buffer.byteLength(v)}:`), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`${v.length}:`), v]);
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(bencode), Buffer.from('e')]);
  const o = v as Record<string, unknown>;
  return Buffer.concat([Buffer.from('d'), ...Object.keys(o).sort().flatMap((k) => [bencode(k), bencode(o[k])]), Buffer.from('e')]);
}
const torrents = [
  bencode({ announce: 'http://t/a', info: { length: 10, name: 'a.mkv', 'piece length': 16384, pieces: Buffer.alloc(20, 7) } }),
  bencode({ info: { files: [{ length: 1, path: ['x', 'y.mkv'] }], name: 'dir', 'piece length': 1, pieces: '' } }),
  Buffer.from('d4:infoi1ee'),
  Buffer.from('garbage'),
];

const sorted = (ids: number[], rej: number[]) => ids.map((id, i) => ({ id, rank: i, rejections: Array.from({ length: rej[i] ?? 0 }, () => ({ code: 'x' })) }));
const wants = [null, { decision: 'missing' }, { decision: 'upgrade' }, { decision: 'skip' }];

const release = (o: Record<string, unknown>) => ({
  title: 'T', downloadUrl: 'https://t/x', indexerId: 1, indexerName: 'ix', size: 10, seeders: 2, leechers: 1,
  publishDate: '2024-01-01T00:00:00.000Z', freeleech: false, downloadVolumeFactor: 1, ...o,
});
const scoreCases = [
  { releases: [release({}), release({ title: 'B', indexerId: 2, publishDate: null, freeleech: true, downloadVolumeFactor: 0 })],
    settings: { 1: { minSeeders: 5, unknownLanguageIsoCode: 'fr' }, 2: {} }, blocked: ['B'] },
  { releases: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => release({ title: `R${i}`, indexerId: i })),
    settings: { 1: { minSeeders: '3' }, 2: { minSeeders: 0 }, 3: { minSeeders: -2 }, 4: { minSeeders: 'abc' }, 5: { minSeeders: null },
      6: { minSeeders: 2.5 }, 7: { minSeeders: true }, 8: { unknownLanguageIsoCode: 7 } }, blocked: [] },
  { releases: [release({ title: 'Orphan', indexerId: 99 })], settings: {}, blocked: ['Orphan'] },
];

// Fixed clock: `Retry-After` dates and the failure ladder are relative to it.
const NOW = Date.UTC(2023, 10, 14, 22, 13, 20);
let clock = NOW;
Date.now = () => clock;
const tix = indexer({});
const cooldownMs = (t: IndexerThrottle): number => {
  const c = t.getCooldown(7);
  return c ? c.until - clock : 0;
};
const retryAfter = [
  '0', '30', '  45 ', '1.5', '-5', '', 'abc', '1e3', '٣', '007',
  'Tue, 14 Nov 2023 22:15:20 GMT', 'Tue, 14 Nov 2023 22:00:00 GMT', '2023-11-14T22:14:20Z', '2023-11-14T22:14:20+01:00',
  'Tuesday, 14-Nov-23 22:15:20 GMT', '2023-11-14T22:14:20.500Z', 'Tue, 14 Nov 2023 22:15:20 +0000',
].map((input) => {
  const t = new IndexerThrottle();
  t.setRetryAfter(tix, input);
  return { input, output: cooldownMs(t) };
});
const ladder = (() => {
  const t = new IndexerThrottle();
  const steps: number[] = [];
  for (let i = 0; i < 7; i++) {
    t.notifyFailure(tix);
    steps.push(cooldownMs(t));
    t.notifyFailure(tix); // inside the open window: no step
    steps.push(cooldownMs(t));
    clock += cooldownMs(t) + 1;
  }
  t.notifySuccess(7);
  t.notifyFailure(tix);
  steps.push(cooldownMs(t));
  clock = NOW;
  const m = new IndexerThrottle();
  m.notifyFailure(tix);
  const mono: number[] = [];
  for (const h of ['10', '120', '60']) {
    m.setRetryAfter(tix, h);
    mono.push(cooldownMs(m));
  }
  return { steps, mono };
})();

const routeTable = createRouteTable({} as RouteDeps);
const routeCases: [string, string][] = [
  ['GET', '/1/releases'], ['GET', '/1%2F2/releases'], ['GET', '/../releases'], ['GET', '/%2e%2e/releases'], ['GET', '/1/Releases'],
  ['get', '/1/releases'], ['GET', '/nonexistent'], ['GET', '/delay-profiles'], ['POST', '/5/grab'], ['POST', '/5/seasons/2/grab'],
  ['GET', '/1/seasons/../releases'], ['GET', '/1/episodes/9/releases'], ['DELETE', '/history/all'], ['DELETE', '/history/7'],
  ['DELETE', '/blocklist/all'], ['DELETE', '/blocklist/12'], ['DELETE', '/indexers/cooldowns'], ['DELETE', '/indexers/3'],
  ['DELETE', '/indexers/3/cooldown'], ['GET', '/indexers/implementations'], ['GET', '/indexers/3/stats'], ['PUT', '/indexers/implementations'],
  ['POST', '/indexers/test-connection'], ['POST', '/indexers/3/test-connection'], ['GET', '/queue'], ['GET', '/queue/'], ['GET', '/queue/3'],
  ['POST', '/queue/3/retry-import'], ['POST', '/queue/3/pause'], ['DELETE', '/queue/3'], ['GET', '/indexers/%E0%A4%A/stats'],
  ['GET', '/indexers/%zz/stats'], ['GET', '/indexers/a%20b/stats'], ['GET', ''], ['GET', '/'], ['GET', '//releases'], ['GET', '/1//releases'],
  ['POST', '/indexer-sources/4/import'], ['DELETE', '/download-clients/5'], ['GET', '/download-clients/implementations'],
  ['GET', '/indexers/%2Fx/stats'], ['GET', '/indexers/%2fx/stats'],
].map(([m, p]) => [m!, p!]);

const out = {
  migrations: MIGRATIONS.map((m) => ({ name: m.name, up: m.up })),
  htmlEntities: [
    'Berl&iacute;n', '&amp;&lt;&gt;&quot;&apos;', '&#233;&#xE9;&#XE9;', '&#0;', '&bogus;', '&#1114112;', 'no entities', '&amp',
    '&euro;&hellip;&nbsp;x',
  ].map((input) => ({ input, output: decodeHtmlEntities(input) })),
  torznabQuery: [
    { t: 'search', q: 'Dune 2021', cat: '2000', apiKey: 'k&y' },
    { t: 'movie', q: 'Dune', cat: '2000', apiKey: 'k', imdbId: 'tt1160419', tmdbId: 438631, supportedParams: 'q, imdbid,TMDBID' },
    { t: 'tvsearch', q: "L'été (2024)!*", season: 1, ep: 2, cat: '5000', apiKey: '', tvdbId: 5, imdbId: 'tt', supportedParams: 'q,tvdbid,imdbid' },
    { t: 'tvsearch', q: '', season: 0, cat: '5000', apiKey: 'a b', tvdbId: 5, supportedParams: null },
  ].map((input) => ({ input, output: buildTorznabQuery(input) })),
  describeQuery: [
    'https://t.example/api?t=tvsearch&q=Show%20Name&season=1&ep=2&cat=5000&apikey=SECRET&tvdbid=5',
    'https://t.example/api?apikey=x',
    'not a url',
  ].map((input) => ({ input, output: describeTorznabQuery(input) })),
  torznabItems: feeds.map((f) => ({ ...f, output: parseTorznabItems(f.xml, indexer(f.settings)) })),
  magnetHash: [
    'magnet:?xt=urn:btih:ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD&dn=x',
    'magnet:?xt=urn:btih:MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U&dn=y',
    'magnet:?xt=urn:btih:mfrggzdfmztwq2lknnwg23tpobyxe43u',
    'magnet:?dn=nohash',
  ].map((input) => ({ input, output: extractMagnetInfoHash(input) ?? null })),
  infoHash: torrents.map((b) => ({ input: b.toString('base64'), output: computeInfoHash(b) ?? null })),
  torrentName: ['Some.Movie_2024  1080p.torrent', 'Berl&iacute;n.S01', '', 'A__B..C'].map((input) => ({
    input,
    output: normaliseTorrentName(input),
  })),
  stallStrikes: [
    { minBytesPerSecond: 8192, samples: [] },
    { minBytesPerSecond: 8192, samples: [{ downloadedBytes: 100, checkedAt: '2026-01-01T02:00:00.000Z' }, { downloadedBytes: 100, checkedAt: '2026-01-01T01:00:00.000Z' }, { downloadedBytes: 50, checkedAt: '2026-01-01T00:00:00.000Z' }] },
    { minBytesPerSecond: 1, samples: [{ downloadedBytes: 10, checkedAt: '2026-01-01T02:00:00.000Z' }, { downloadedBytes: 99999, checkedAt: '2026-01-01T01:00:00.000Z' }, { downloadedBytes: 1, checkedAt: '2026-01-01T00:00:00.000Z' }] },
    { minBytesPerSecond: 1, samples: [{ downloadedBytes: 7300, checkedAt: '2026-01-01T02:00:00.000Z' }, { downloadedBytes: 3600, checkedAt: '2026-01-01T01:00:00.000Z' }, { downloadedBytes: 0, checkedAt: '2026-01-01T00:00:00.000Z' }] },
  ].map((input) => ({ input, output: countStalledStrikes(input.samples, input.minBytesPerSecond) })),
  qbitBaseUrl: [
    { host: 'localhost', port: 8080 },
    { host: 'https://qbit.lan:9090/', useSsl: true },
    { host: 'qbit.lan:9090', port: 1234 },
    { host: 'HTTP://x' },
    { host: '' },
  ].map((input) => ({ input, output: buildBaseUrl(input) })),
  progressState: ['queuedDL', 'stalledDL', 'error', 'missingFiles', 'pausedDL', 'stoppedUP', 'moving', 'downloading', 'uploading', 'weird'].map(
    (input) => ({ input, output: mapClientStateToProgress(input) }),
  ),
  encodeUriComponent: ["a b&c=d/é!'()*~-_.", '日本', ''].map((input) => ({ input, output: encodeURIComponent(input) })),
  coverageColumns: [
    null,
    { seasons: null, episodes: null, completeSeries: false },
    { seasons: null, episodes: null, completeSeries: true },
    { seasons: { from: 1, to: 3 }, episodes: null, completeSeries: false },
    { seasons: { from: 2, to: 2 }, episodes: { from: 4, to: 5 }, completeSeries: false },
  ].map((input) => ({ input, output: toCoverageColumns(input) })),
  secretSettings: [
    { existing: { apiKey: 'old', baseUrl: 'u' }, incoming: { apiKey: '', baseUrl: 'v', secretsSet: ['apiKey'] } },
    { existing: { apiKey: 'old' }, incoming: { apiKey: null } },
    { existing: null, incoming: { apiKey: 'new' } },
    { existing: {}, incoming: { apiKey: '' } },
  ].map((input) => ({
    input,
    merged: mergeSecretSettings(input.existing, input.incoming, ['apiKey']),
    redacted: redactSecretSettings(input.existing, ['apiKey']),
  })),
};
async function main(): Promise<void> {
const asyncOut = {
  pickRelease: [
    { ids: [], rej: [] }, { ids: [1, 2, 3], rej: [0, 0, 0] }, { ids: [1, 2, 3, 4, 5], rej: [0, 0, 0, 0, 0] },
    { ids: [1, 2, 3, 4], rej: [1, 0, 2, 0] }, { ids: [1, 2], rej: [1, 3] }, { ids: [1, 2, 3, 4, 5, 6], rej: [1, 0, 0, 1, 0, 0] },
  ].flatMap((c) =>
    wants.map((want) => ({
      input: { sorted: sorted(c.ids, c.rej).map((r) => ({ id: r.id, rejections: r.rejections.length })), want },
      output: pickReleases(sorted(c.ids, c.rej), want as never).map((r) => r.id),
    })),
  ),
  scoreRequest: await Promise.all(
    scoreCases.map(async (c) => {
      const ixs = Object.keys(c.settings).map((id) => ({ ...indexer((c.settings as Record<string, Record<string, unknown>>)[id]!), id: Number(id) }));
      const repo = { isBlocked: async (t: string) => c.blocked.some((b) => b.toLowerCase() === t.toLowerCase()) };
      const output = await buildScoreRequest(c.releases as never, ixs, repo);
      return { input: c, output };
    }),
  ),
  retryAfter,
  throttleLadder: ladder,
  routeMatch: routeCases.map(([method, path]) => {
    const r = routeTable.resolve(method, path);
    return { method, path, output: r ? r.params : null };
  }),
};
process.stdout.write(JSON.stringify({ ...out, ...asyncOut }, null, 2) + '\n');
}
void main();
