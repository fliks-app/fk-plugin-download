import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FrameReader,
  FrameTooLargeError,
  MAX_FRAME_BYTES,
  ProtocolViolationError,
  encodeFrame,
  parseFrame,
  isNote,
  isReq,
} from '../src/protocol';

test('FrameReader splits multiple frames arriving in one chunk', () => {
  const reader = new FrameReader();
  const lines = reader.push(Buffer.from('{"i":1,"m":"hello"}\n{"i":2,"m":"health"}\n'));
  assert.deepEqual(lines, ['{"i":1,"m":"hello"}', '{"i":2,"m":"health"}']);
});

test('FrameReader buffers a frame split across chunks', () => {
  const reader = new FrameReader();
  assert.deepEqual(reader.push(Buffer.from('{"i":1,"m":"he')), []);
  assert.deepEqual(reader.push(Buffer.from('llo"}\n')), ['{"i":1,"m":"hello"}']);
});

test('FrameReader throws on a line exceeding MAX_FRAME_BYTES before a newline arrives', () => {
  const reader = new FrameReader();
  assert.throws(() => reader.push(Buffer.alloc(4 * 1024 * 1024 + 1, 'x')), ProtocolViolationError);
});

test('parseFrame rejects malformed JSON and non-object frames', () => {
  assert.throws(() => parseFrame('not json'), ProtocolViolationError);
  assert.throws(() => parseFrame('42'), ProtocolViolationError);
  assert.throws(() => parseFrame('null'), ProtocolViolationError);
});

test('encodeFrame/parseFrame round-trip', () => {
  const frame = { i: 7, r: { ok: true } };
  assert.deepEqual(parseFrame(encodeFrame(frame).toString('utf8').trimEnd()), frame);
});

test('isReq/isNote discriminate correctly', () => {
  assert.equal(isReq({ i: 1, m: 'hello' }), true);
  assert.equal(isReq({ m: 'event', p: {} }), false);
  assert.equal(isNote({ m: 'event', p: {} }), true);
  assert.equal(isNote({ i: 1, m: 'hello' }), false);
});

const ENCODE_OVERHEAD = Buffer.byteLength(JSON.stringify({ i: 1, m: 'x', p: '' }), 'utf8');

test('encodeFrame accepts a frame exactly at the ceiling', () => {
  const payload = 'a'.repeat(MAX_FRAME_BYTES - ENCODE_OVERHEAD);
  assert.equal(encodeFrame({ i: 1, m: 'x', p: payload }).length, MAX_FRAME_BYTES + 1);
});

test('encodeFrame refuses one byte over rather than breaching the reader at the other end', () => {
  const payload = 'a'.repeat(MAX_FRAME_BYTES - ENCODE_OVERHEAD + 1);
  assert.throws(() => encodeFrame({ i: 1, m: 'x', p: payload }), FrameTooLargeError);
});

test('encodeFrame measures bytes, so a multibyte payload cannot slip past a length check', () => {
  const payload = '\u{1D11E}'.repeat(Math.ceil((MAX_FRAME_BYTES - ENCODE_OVERHEAD) / 4) + 1);
  assert.ok(payload.length < MAX_FRAME_BYTES, 'fewer characters than the byte limit');
  assert.throws(() => encodeFrame({ i: 1, m: 'x', p: payload }), FrameTooLargeError);
});
