import type { Socket } from 'net';
import { FrameReader, encodeFrame, isNote, isReq, parseFrame, type Note } from './protocol';
import { log } from './log';

export type RequestHandler = (payload: unknown) => Promise<unknown>;
export type NoteHandler = (payload: unknown) => void;

/**
 * Binds the request/note handler tables to one connected socket. A protocol
 * violation (oversize or unparsable line) closes the socket — core treats
 * a dropped plugin connection the same as a crash on its next health check.
 */
export function attachDispatcher(
  socket: Socket,
  requestHandlers: Record<string, RequestHandler>,
  noteHandlers: Record<string, NoteHandler>,
): void {
  const reader = new FrameReader();

  socket.on('data', (chunk: Buffer) => {
    let lines: string[];
    try {
      lines = reader.push(chunk);
    } catch (err) {
      log.error(`protocol violation from core: ${(err as Error).message}`);
      socket.destroy();
      return;
    }
    for (const line of lines) {
      let frame;
      try {
        frame = parseFrame(line);
      } catch (err) {
        log.error(`protocol violation from core: ${(err as Error).message}`);
        socket.destroy();
        return;
      }

      if (isReq(frame)) {
        const handler = requestHandlers[frame.m];
        if (!handler) {
          socket.write(encodeFrame({ i: frame.i, e: { c: 'ERR_NO_METHOD', m: `no handler for "${frame.m}"` } }));
          continue;
        }
        handler(frame.p)
          .then((r) => socket.write(encodeFrame({ i: frame.i, r })))
          .catch((err: Error) => socket.write(encodeFrame({ i: frame.i, e: { c: 'ERR', m: err.message } })));
      } else if (isNote(frame)) {
        const noteFrame = frame as Note;
        noteHandlers[noteFrame.m]?.(noteFrame.p);
      }
    }
  });

  socket.on('error', () => {
    // connection loss surfaces to core as a missed health check — nothing to do here
  });
}
