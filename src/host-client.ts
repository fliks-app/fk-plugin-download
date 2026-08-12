import * as net from 'net';
import { FrameReader, encodeFrame, isReq, parseFrame, type Req } from './protocol';
import type { PluginHostApi } from './host-methods';
import { log } from './log';

export type HostMethodName = keyof PluginHostApi;
export type HostParams<M extends HostMethodName> = Parameters<PluginHostApi[M]>[0];
export type HostResult<M extends HostMethodName> = Awaited<ReturnType<PluginHostApi[M]>>;

/** Applied when a call site doesn't pass its own — every call still carries a deadline. */
export const DEFAULT_CALL_TIMEOUT_MS = 10_000;

/** A stalled core must not grow this without bound; the 257th concurrent call fails
 *  immediately rather than queuing behind 256 that may never resolve. */
export const MAX_OUTSTANDING_CALLS = 256;

/** `outcome`: 'unknown' means core never saw or never answered the request (safe to retry);
 *  'rejected' means core answered with an error (definitive). */
export class HostCallError extends Error {
  constructor(
    message: string,
    readonly outcome: 'unknown' | 'rejected',
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Typed client over `FLIKS_CORE_SOCK`, the uplink for every `PluginHostApi`
 * method. One request in flight per `i`; replies correlate back to their
 * caller via the same map `test/host-client.test.ts` exercises directly.
 *
 * Core never attaches a `Principal` to a `PluginHostApi` reply — that field
 * only ever arrives on an inbound `http` request (see `src/principal.ts`).
 * A caller that needs to reason about `delegated` vs `system` threads the
 * `Principal` it already has from that request through its own call sites;
 * `HostClient` has nothing to add there and does not invent a parameter the
 * real contract does not carry.
 */
export class HostClient {
  private socket: net.Socket | null = null;
  private readonly reader = new FrameReader();
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private connected = false;

  constructor(private readonly sockPath: string) {}

  connect(): void {
    const socket = net.connect(this.sockPath);
    this.socket = socket;
    socket.on('connect', () => {
      this.connected = true;
    });
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err: Error) => this.onFatal(new Error(`core socket error: ${err.message}`)));
    socket.on('close', () => {
      this.connected = false;
      this.onFatal(new Error('core socket closed'));
    });
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Every call carries a deadline and rejects — never hangs — once it elapses. */
  call<M extends HostMethodName>(
    method: M,
    payload: HostParams<M>,
    timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  ): Promise<HostResult<M>> {
    if (!this.socket || !this.connected) {
      return Promise.reject(new HostCallError(`not connected to core (method "${method}")`, 'unknown'));
    }
    if (this.pending.size >= MAX_OUTSTANDING_CALLS) {
      return Promise.reject(new HostCallError(`too many outstanding core calls (>= ${MAX_OUTSTANDING_CALLS})`, 'unknown'));
    }

    const i = this.nextId++;
    const req: Req = { i, m: method, p: payload };
    const socket = this.socket;

    return new Promise<HostResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(i);
        reject(new HostCallError(`"${method}" timed out after ${timeoutMs}ms`, 'unknown'));
      }, timeoutMs);
      this.pending.set(i, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      socket.write(encodeFrame(req));
    });
  }

  /** Fails every outstanding call and stops tracking new replies — never leaves one hanging. */
  close(): void {
    this.socket?.destroy();
    this.onFatal(new Error('client closed'));
  }

  private onData(chunk: Buffer): void {
    let lines: string[];
    try {
      lines = this.reader.push(chunk);
    } catch (err) {
      this.onFatal(err as Error);
      return;
    }
    for (const line of lines) {
      let frame;
      try {
        frame = parseFrame(line);
      } catch (err) {
        this.onFatal(err as Error);
        return;
      }
      if (isReq(frame)) continue; // core never sends a request on this socket
      const res = frame as { i?: number; r?: unknown; e?: { c: string; m: string } };
      if (typeof res.i !== 'number') continue; // a note, or malformed — nothing to correlate
      const pending = this.pending.get(res.i);
      if (!pending) continue; // already timed out, or an id we never sent
      this.pending.delete(res.i);
      clearTimeout(pending.timer);
      if (res.e) pending.reject(new HostCallError(`${res.e.c}: ${res.e.m}`, 'rejected'));
      else pending.resolve(res.r);
    }
  }

  /** Fails every outstanding call rather than wedging the client. Core may have processed
   *  any of these before the connection dropped, so 'unknown', not 'rejected'. */
  private onFatal(err: Error): void {
    if (this.connected) log.error(err.message);
    this.connected = false;
    this.socket?.destroy();
    const rejection = new HostCallError(err.message, 'unknown');
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(rejection);
      this.pending.delete(id);
    }
  }
}
