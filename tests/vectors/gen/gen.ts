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
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
