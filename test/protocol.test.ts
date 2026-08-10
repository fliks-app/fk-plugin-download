import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameReader, ProtocolViolationError, encodeFrame, parseFrame, isNote, isReq } from '../src/protocol';

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
