import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { computeInfoHash, extractMagnetInfoHash } from '../src/download-clients/torrent-hash';

test('extractMagnetInfoHash reads a 40-char hex btih, lowercased', () => {
  const hash = extractMagnetInfoHash(`magnet:?xt=urn:btih:${'A1B2C3D4E5'.repeat(4)}&dn=x`);
  assert.equal(hash, 'a1b2c3d4e5'.repeat(4));
});

test('extractMagnetInfoHash decodes a 32-char base32 btih to 40 hex chars', () => {
  // Base32 encoding of 20 zero bytes is "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".
  const hash = extractMagnetInfoHash('magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(hash, '00'.repeat(20));
});

test('extractMagnetInfoHash returns undefined when no btih is present', () => {
  assert.equal(extractMagnetInfoHash('magnet:?dn=no-hash-here'), undefined);
});

test('computeInfoHash returns the sha1 of the bencoded "info" dict bytes', () => {
  const infoBencode = 'd4:name5:helloe';
  const torrent = Buffer.from(`d8:announce3:foo4:info${infoBencode}e`);
  const expected = createHash('sha1').update(Buffer.from(infoBencode)).digest('hex');
  assert.equal(computeInfoHash(torrent), expected);
});

test('computeInfoHash handles an info dict whose value is a list (multi-file torrent)', () => {
  const infoBencode = 'd4:name5:hello5:filesl5:a.txt5:b.txtee';
  const torrent = Buffer.from(`d8:announce3:foo4:info${infoBencode}e`);
  const expected = createHash('sha1').update(Buffer.from(infoBencode)).digest('hex');
  assert.equal(computeInfoHash(torrent), expected);
});

test('computeInfoHash returns undefined when there is no "4:info" marker', () => {
  assert.equal(computeInfoHash(Buffer.from('d8:announce3:fooe')), undefined);
});

test('computeInfoHash returns undefined when "4:info" is not followed by a dict', () => {
  assert.equal(computeInfoHash(Buffer.from('d4:infoi5ee')), undefined);
});
