/**
 * Wire protocol for the two unix sockets between core and this plugin:
 * newline-delimited JSON, one object per line. Mirrors
 * `backend/src/common/plugin-contract/protocol.ts` and
 * `.../supervisor/wire.ts` in the Fliks repo — reimplemented here because a
 * `process` plugin ships with no access to that source at runtime.
 */

export interface Req {
  i: number;
  m: string;
  p?: unknown;
}

export interface Res {
  i: number;
  r?: unknown;
  e?: { c: string; m: string };
}

export type Note<P = unknown> = { m: string; p?: P };

export type Frame = Req | Res | Note;

/** Per-frame size ceiling. Must match core's `MAX_FRAME_BYTES`. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export class ProtocolViolationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ProtocolViolationError';
  }
}

export function encodeFrame(frame: Frame): Buffer {
  return Buffer.from(JSON.stringify(frame) + '\n', 'utf8');
}

/** Buffers raw bytes into lines; any line (complete or still growing) past
 *  MAX_FRAME_BYTES throws — bounded even before a newline arrives. */
export class FrameReader {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): string[] {
    const combined = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const nl = combined.indexOf(0x0a, start);
      if (nl === -1) break;
      if (nl - start > MAX_FRAME_BYTES) {
        throw new ProtocolViolationError(`frame exceeds ${MAX_FRAME_BYTES} bytes`);
      }
      lines.push(combined.subarray(start, nl).toString('utf8'));
      start = nl + 1;
    }
    const rest = combined.subarray(start);
    if (rest.length > MAX_FRAME_BYTES) {
      throw new ProtocolViolationError(`frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }
    this.pending = rest;
    return lines;
  }
}

export function parseFrame(line: string): Frame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ProtocolViolationError('malformed JSON line');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProtocolViolationError('frame is not a JSON object');
  }
  return parsed as Frame;
}

export function isReq(f: Frame): f is Req {
  return typeof (f as Req).i === 'number' && typeof (f as Req).m === 'string';
}

export function isNote(f: Frame): f is Note {
  return typeof (f as Note).m === 'string' && !('i' in f);
}
