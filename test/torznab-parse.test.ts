import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTorznabItems, buildTorznabQuery, describeTorznabQuery } from '../src/indexers/torznab-parse';
import type { IndexerRow } from '../src/db/rows';

const indexer = (settings: Record<string, unknown> = {}): IndexerRow =>
  ({
    id: 7,
    name: 'test-indexer',
    implementation: 'torznab',
    settings,
    enableRss: true,
    enableSearch: true,
    priority: 25,
    enabled: true,
    capsSearchFallback: false,
    capsMovieSearch: false,
    capsTvSearch: false,
    requestDelay: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }) as IndexerRow;

test('parses a well-formed item with every field present', () => {
  const xml = `<rss><channel><item>
    <title>Some.Movie.2024.1080p</title>
    <link>https://tracker.example/dl/abc</link>
    <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
    <torznab:attr name="size" value="123456" />
    <torznab:attr name="seeders" value="42" />
    <torznab:attr name="leechers" value="3" />
    <torznab:attr name="downloadvolumefactor" value="0" />
  </item></channel></rss>`;
  const [release] = parseTorznabItems(xml, indexer({ apiKey: 'k1' }));
  assert.equal(release?.title, 'Some.Movie.2024.1080p');
  assert.equal(release?.size, 123456);
  assert.equal(release?.seeders, 42);
  assert.equal(release?.leechers, 3);
  assert.equal(release?.freeleech, true);
  assert.equal(release?.downloadVolumeFactor, 0);
  assert.equal(release?.indexerId, 7);
  assert.equal(release?.indexerName, 'test-indexer');
  assert.equal(release?.publishDate, new Date('Mon, 01 Jan 2024 00:00:00 GMT').toISOString());
  assert.ok(release?.downloadUrl.includes('apikey=k1'), 'forces the configured apiKey onto the download URL');
});

test('malformed XML — an item never closed — yields no results, no throw', () => {
  const xml = `<rss><channel><item><title>Unclosed</title>`;
  assert.doesNotThrow(() => parseTorznabItems(xml, indexer()));
  assert.deepEqual(parseTorznabItems(xml, indexer()), []);
});

test('non-XML garbage body yields no results, no throw', () => {
  assert.deepEqual(parseTorznabItems('not xml at all, just plain text', indexer()), []);
  assert.deepEqual(parseTorznabItems('', indexer()), []);
});

test('an item missing both link and enclosure (no usable URL) is dropped silently', () => {
  const xml = `<item><title>No URL Here</title><torznab:attr name="size" value="10" /></item>`;
  assert.deepEqual(parseTorznabItems(xml, indexer()), []);
});

test('an item missing a title is dropped silently even with a usable link', () => {
  const xml = `<item><link>https://tracker.example/dl/x</link></item>`;
  assert.deepEqual(parseTorznabItems(xml, indexer()), []);
});

test('an unexpected namespace prefix on the attr tag is not recognised — falls back to defaults, item still kept', () => {
  // torznabAttr's regex matches literally "torznab:attr"; a differently-prefixed
  // attribute (as a non-conformant/newznab-flavoured indexer might emit) is invisible to it.
  const xml = `<item>
    <title>Odd Namespace Release</title>
    <link>https://tracker.example/dl/y</link>
    <newznab:attr name="seeders" value="99" />
    <newznab:attr name="downloadvolumefactor" value="0" />
  </item>`;
  const [release] = parseTorznabItems(xml, indexer());
  assert.equal(release?.title, 'Odd Namespace Release');
  assert.equal(release?.seeders, 0, 'unseen attr falls back to the "0" default, not the 99 that was actually sent');
  assert.equal(release?.downloadVolumeFactor, 1, 'unseen dvf attr falls back to 1 (paid/normal), not the free the source advertised');
  assert.equal(release?.freeleech, false);
});

test('non-numeric numeric fields: seeders/leechers/size fall back to 0 via the `|| 0` guard', () => {
  const xml = `<item>
    <title>Bad Numbers</title>
    <link>https://tracker.example/dl/z</link>
    <torznab:attr name="size" value="not-a-number" />
    <torznab:attr name="seeders" value="abc" />
    <torznab:attr name="leechers" value="xyz" />
  </item>`;
  const [release] = parseTorznabItems(xml, indexer());
  assert.equal(release?.size, 0);
  assert.equal(release?.seeders, 0);
  assert.equal(release?.leechers, 0);
});

test('a non-numeric downloadvolumefactor produces NaN — ported faithfully, no `|| 1` guard exists on this one field', () => {
  const xml = `<item>
    <title>Bad DVF</title>
    <link>https://tracker.example/dl/w</link>
    <torznab:attr name="downloadvolumefactor" value="not-a-number" />
  </item>`;
  const [release] = parseTorznabItems(xml, indexer());
  assert.ok(release && Number.isNaN(release.downloadVolumeFactor));
  assert.equal(release?.freeleech, false, 'NaN === 0 is false, so freeleech still resolves, just not meaningfully');
});

test('CDATA-wrapped and HTML-entity-encoded title is unwrapped and decoded', () => {
  const xml = `<item><title><![CDATA[Berl&iacute;n.2024]]></title><link>https://tracker.example/dl/e</link></item>`;
  const [release] = parseTorznabItems(xml, indexer());
  assert.equal(release?.title, 'Berlín.2024');
});

test('a magnet URI wins over an enclosure/link, and is left untouched by apikey injection', () => {
  const xml = `<item>
    <title>Magnet Wins</title>
    <link>https://tracker.example/dl/should-be-ignored</link>
    <enclosure url="https://tracker.example/enclosure" length="999" />
    <torznab:attr name="magneturl" value="magnet:?xt=urn:btih:abc123" />
  </item>`;
  const [release] = parseTorznabItems(xml, indexer({ apiKey: 'secret' }));
  assert.equal(release?.downloadUrl, 'magnet:?xt=urn:btih:abc123');
});

test('an enclosure length wins over a torznab:attr size — but only when "length" precedes "url" in the tag', () => {
  // The enclosure regex (`<enclosure[^>]*\surl="([^"]+)"`) stops matching right after the
  // captured url attribute, so `length="…"` is only inside `m[0]` (and thus visible to the
  // follow-up length lookup) when it happens to sit BEFORE url in the source markup.
  const xml = `<item>
    <title>Enclosure Size Wins</title>
    <enclosure length="555" url="https://tracker.example/dl/f" />
    <torznab:attr name="size" value="1" />
  </item>`;
  const [release] = parseTorznabItems(xml, indexer());
  assert.equal(release?.size, 555);
});

test('faithful defect: with the conventional url-then-length attribute order, the enclosure length is invisible and size falls through to torznab:attr', () => {
  // Real-world Torznab feeds (Jackett/Prowlarr et al.) write `url` before `length` — the RSS 2.0
  // convention. In that order the length is silently never read from the enclosure at all.
  const xml = `<item>
    <title>Conventional Order</title>
    <enclosure url="https://tracker.example/dl/h" length="777" />
    <torznab:attr name="size" value="42" />
  </item>`;
  const [release] = parseTorznabItems(xml, indexer());
  assert.equal(release?.size, 42, 'falls through to torznab:attr size — the 777 from the enclosure is never seen');
});

test('a link pointing at localhost is rejected as a download URL (only as a fallback last resort)', () => {
  const xml = `<item><title>Localhost Link</title><link>http://localhost/dl/g</link></item>`;
  assert.deepEqual(parseTorznabItems(xml, indexer()), []);
});

test('buildTorznabQuery strips the imdb "tt" prefix and omits absent optional ids', () => {
  const qs = buildTorznabQuery({ t: 'movie', q: 'Some Title', cat: '2000', apiKey: 'k', imdbId: 'tt1234567' });
  assert.equal(qs, 't=movie&q=Some%20Title&cat=2000&apikey=k&imdbid=1234567');
});

test('describeTorznabQuery never echoes the apikey', () => {
  const desc = describeTorznabQuery('https://tracker.example/api?t=search&q=foo&apikey=super-secret');
  assert.ok(!desc.includes('super-secret'));
  assert.equal(desc, 'search q="foo"');
});

const withInfo = (extra: string) =>
  parseTorznabItems(
    `<rss><channel><item>
      <title>Some.Movie.2024.1080p</title>
      <link>https://tracker.example/dl/abc</link>
      ${extra}
    </item></channel></rss>`,
    indexer({ apiKey: 'k1' }),
  )[0];

test('takes the tracker page from <comments>', () => {
  assert.equal(withInfo('<comments>https://tracker.example/details/42</comments>')?.infoUrl, 'https://tracker.example/details/42');
});

test('falls back to a permalink <guid> when there is no <comments>', () => {
  assert.equal(withInfo('<guid isPermaLink="true">https://tracker.example/t/42</guid>')?.infoUrl, 'https://tracker.example/t/42');
});

test('<comments> wins over <guid> — it is the one Torznab defines for this', () => {
  const r = withInfo('<comments>https://tracker.example/details/42</comments><guid>abc-123</guid>');
  assert.equal(r?.infoUrl, 'https://tracker.example/details/42');
});

test('VERDICT: a non-http <guid> is an opaque id, not a page — no link rather than a broken one', () => {
  assert.equal(withInfo('<guid isPermaLink="false">abc-123-def</guid>')?.infoUrl, undefined);
});

test('an item naming neither carries no page at all', () => {
  assert.equal(withInfo('')?.infoUrl, undefined);
});

test('VERDICT: the tracker page is never the download url — that one carries the API key', () => {
  const r = withInfo('<comments>https://tracker.example/details/42</comments>');
  assert.ok(r?.downloadUrl.includes('k1'), 'the download url is still api-keyed');
  assert.ok(!r?.infoUrl?.includes('k1'), 'the page url must not leak it');
});
