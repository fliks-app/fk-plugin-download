/**
 * Ported from `qbittorrent.service.ts`'s magnet/bencode hash helpers — pure
 * functions, no framework or network dependency.
 */
import * as crypto from 'crypto';

/** A magnet's info-hash is either 40 hex chars or 32 base32 chars; base32
 *  trackers (uncommon but real) silently fell back to list-diff recovery
 *  under a hex-only regex, so both forms are matched here. */
export function extractMagnetInfoHash(magnet: string): string | undefined {
  const hex = magnet.match(/xt=urn:btih:([a-fA-F0-9]{40})/)?.[1];
  if (hex) return hex.toLowerCase();
  const b32 = magnet.match(/xt=urn:btih:([A-Z2-7]{32})/i)?.[1];
  if (!b32) return undefined;
  const upper = b32.toUpperCase();
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out = Buffer.alloc(20);
  let idx = 0;
  for (const ch of upper) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return undefined;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[idx++] = (value >>> bits) & 0xff;
    }
  }
  return out.toString('hex');
}

/** Return the byte position just past the bencoded value starting at `pos`. */
function bencodedEnd(buf: Buffer, pos: number): number {
  if (pos >= buf.length) return -1;
  const ch = buf[pos];

  if (ch === 0x69 /* 'i' */) {
    const e = buf.indexOf(0x65 /* 'e' */, pos + 1);
    return e === -1 ? -1 : e + 1;
  }

  if (ch === 0x6c /* 'l' */ || ch === 0x64 /* 'd' */) {
    let cur = pos + 1;
    while (cur < buf.length && buf[cur] !== 0x65 /* 'e' */) {
      cur = bencodedEnd(buf, cur);
      if (cur === -1) return -1;
    }
    return cur < buf.length ? cur + 1 : -1;
  }

  if (ch !== undefined && ch >= 0x30 && ch <= 0x39 /* '0'-'9' */) {
    const colon = buf.indexOf(0x3a /* ':' */, pos);
    if (colon === -1) return -1;
    const len = parseInt(buf.subarray(pos, colon).toString('ascii'), 10);
    return colon + 1 + len;
  }

  return -1;
}

/** SHA1 of the raw bytes of the bencoded top-level "info" dict — the
 *  BitTorrent info-hash, computed client-side so a magnet is available
 *  immediately instead of waiting on the client to parse the upload. */
export function computeInfoHash(buf: Buffer): string | undefined {
  const marker = Buffer.from('4:info');
  const idx = buf.indexOf(marker);
  if (idx === -1) return undefined;

  const start = idx + marker.length;
  if (start >= buf.length || buf[start] !== 0x64 /* 'd' */) return undefined;

  const end = bencodedEnd(buf, start);
  if (end === -1) return undefined;

  return crypto.createHash('sha1').update(buf.subarray(start, end)).digest('hex');
}
