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

/** Raised when a frame we are about to send would breach MAX_FRAME_BYTES — our fault, not core's. */
export class FrameTooLargeError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'FrameTooLargeError';
  }
}

/** Refuses past MAX_FRAME_BYTES rather than breaching core's reader, which would be fatal there. */
export function encodeFrame(frame: Frame): Buffer {
  const json = JSON.stringify(frame);
  const size = Buffer.byteLength(json, 'utf8');
  if (size > MAX_FRAME_BYTES) {
    throw new FrameTooLargeError(`frame of ${size} bytes exceeds the ${MAX_FRAME_BYTES} byte limit`);
  }
  return Buffer.from(json + '\n', 'utf8');
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

/**
 * Environment core sets on every spawn (see `supervisor/spawn-plan.ts`) — the only way in
 * for a `process` plugin, since core never passes `...process.env`. Every value here is a
 * plain string; only `FLIKS_API_VERSION` has a typed counterpart ({@link PLUGIN_API_VERSION}).
 */
export interface PluginSpawnEnv {
  /** Random per spawn, known only to core and this child. Echo it back as `hello`'s `token` —
   *  proof the responder is the process core spawned, not an impostor on the socket. */
  FLIKS_PLUGIN_TOKEN: string;
  /** Unix socket this plugin dials to make its `PluginHostApi` calls. */
  FLIKS_CORE_SOCK: string;
  /** Unix socket this plugin listens on for core's `PluginApi` calls
   *  (`hello`, `health`, `http`, `job`, `event`, `config`, `shutdown`). */
  FLIKS_PLUGIN_SOCK: string;
  /** This plugin's own Postgres connection string; `''` when its manifest declared no schema. */
  FLIKS_DB_URL: string;
  /** This manifest's `id`, verbatim. */
  FLIKS_PLUGIN_ID: string;
  /** {@link PLUGIN_API_VERSION}, stringified — compared for exact equality, never a range. */
  FLIKS_API_VERSION: string;
  /** `${dir}/data` — the child's cwd, and the one path its sandbox may write to. */
  HOME: string;
  PATH: string;
  NODE_ENV: string;
  TZ: string;
}

/**
 * Every `plugin.<id>.<key>` admin setting also arrives re-keyed as an env var: strip the
 * `plugin.<id>.` prefix, upper-case what remains, replace every character outside
 * `[A-Z0-9_]` with `_`, and prepend `FLIKS_CFG_` (see `reKeyConfig` in `supervisor/spawn-plan.ts`).
 * Not a fixed set — read whichever `FLIKS_CFG_*` names your own manifest's settings resolve to.
 */
