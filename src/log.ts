/** Strips `user:pass@` credentials — the DB password rotates every spawn, so a driver
 *  error that happens to echo its connection string must never survive into a log line. */
function redact(msg: string): string {
  return msg.replace(/:\/\/[^\s/@]+:[^\s/@]+@/g, '://***:***@');
}

/**
 * Core line-buffers stdout/stderr into its log viewer with a 64 KiB/min cap
 * per plugin — one JSON-safe line per call, never multi-line output.
 */
function line(stream: NodeJS.WriteStream, level: string, msg: string): void {
  stream.write(`[${new Date().toISOString()}] ${level} ${redact(msg).replace(/\n/g, ' ')}\n`);
}

export const log = {
  info: (msg: string): void => line(process.stdout, 'INFO', msg),
  warn: (msg: string): void => line(process.stderr, 'WARN', msg),
  error: (msg: string): void => line(process.stderr, 'ERROR', msg),
};
