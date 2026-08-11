/** Ported assertions from `torrent-history-matcher.spec.ts` (Fliks source),
 *  adapted to `DownloadHistoryRow` (no TypeORM entity in this plugin). */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TorrentHistoryMatcher, normaliseTorrentName } from '../src/grab/torrent-name-matcher';
import { makeHistoryRow } from './grab-test-helpers';
import type { DownloadHistoryRepository } from '../src/db/repositories';

function matcher(): TorrentHistoryMatcher {
  const repo = { updateTorrentHash: async () => {} } as unknown as Pick<DownloadHistoryRepository, 'updateTorrentHash'>;
  return new TorrentHistoryMatcher(repo);
}

describe('TorrentHistoryMatcher.findMatch priority', () => {
  const torrent = { hash: 'h1', name: 'Show.S01.1080p-GROUP' };

  test('prefers the live row over an already-completed one on a shared hash', () => {
    const rows = [
      makeHistoryRow({ id: 10, status: 'completed', mediaId: 42, torrentHash: 'h1' }),
      makeHistoryRow({ id: 11, status: 'grabbed', mediaId: 42, torrentHash: 'h1' }),
      makeHistoryRow({ id: 12, status: 'completed', mediaId: 42, torrentHash: 'h1' }),
    ];
    assert.equal(matcher().findMatch(torrent, rows)?.history.id, 11);
  });

  test('prefers a media-linked row over a media-less one', () => {
    const rows = [
      makeHistoryRow({ id: 20, status: 'grabbed', mediaId: 42, torrentHash: 'h1' }),
      makeHistoryRow({ id: 21, status: 'grabbed', mediaId: null, torrentHash: 'h1' }),
    ];
    assert.equal(matcher().findMatch(torrent, rows)?.history.id, 20);
  });

  test('falls back to the most recent row when rank ties', () => {
    const rows = [
      makeHistoryRow({ id: 30, status: 'completed', mediaId: 42, torrentHash: 'h1' }),
      makeHistoryRow({ id: 31, status: 'completed', mediaId: 42, torrentHash: 'h1' }),
    ];
    assert.equal(matcher().findMatch(torrent, rows)?.history.id, 31);
  });

  test('ranks rows sharing a title instead of refusing to choose', () => {
    const rows = [
      makeHistoryRow({ id: 40, status: 'completed', mediaId: 42, torrentHash: null, sourceTitle: 'Show_S01_1080p-GROUP' }),
      makeHistoryRow({ id: 41, status: 'grabbed', mediaId: 42, torrentHash: null, sourceTitle: 'Show_S01_1080p-GROUP' }),
    ];
    const match = matcher().findMatch({ hash: 'h9', name: 'Show_S01_1080p-GROUP' }, rows);
    assert.equal(match?.matchedBy, 'exact-name');
    assert.equal(match?.history.id, 41);
  });

  test('still refuses an ambiguous prefix overlap', () => {
    const rows = [
      makeHistoryRow({ id: 50, sourceTitle: 'Show.S01', torrentHash: null }),
      makeHistoryRow({ id: 51, sourceTitle: 'Show.S01.1080p', torrentHash: null }),
    ];
    assert.equal(matcher().findMatch({ hash: 'h9', name: 'Show.S01.1080p-GROUP' }, rows), null);
  });
});

describe('normaliseTorrentName', () => {
  test('decodes HTML entities the client renders on display', () => {
    assert.equal(normaliseTorrentName('Show &amp; Co S01E01-GROUP'), 'show & co s01e01-group');
    assert.equal(normaliseTorrentName('Berl&iacute;n.S02E01.1080p.WEB-DL.x265'), 'berlín s02e01 1080p web-dl x265');
  });

  test('decodes numeric and hex character references', () => {
    assert.equal(normaliseTorrentName("Mum&#39;s.S01.WEB-DL"), "mum's s01 web-dl");
    assert.equal(normaliseTorrentName('A&#x26;B.S01'), 'a&b s01');
  });

  test('treats dots, underscores and spaces as equivalent separators', () => {
    assert.equal(normaliseTorrentName('Show.S01E01-GROUP'), normaliseTorrentName('Show S01E01-GROUP'));
    assert.equal(normaliseTorrentName('Show_S01E01.GROUP'), normaliseTorrentName('Show.S01E01.GROUP'));
  });

  test('is case-insensitive', () => {
    assert.equal(normaliseTorrentName('Show S01E01'), normaliseTorrentName('SHOW S01E01'));
  });

  test('handles the empty input', () => {
    assert.equal(normaliseTorrentName(''), '');
  });
});
