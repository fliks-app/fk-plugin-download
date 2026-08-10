import * as fs from 'fs';
import * as path from 'path';
import { createPrivateKey, sign as ed25519Sign } from 'crypto';

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT_FILE = path.join(DIST, 'fliks-download.fkplugin');

/** DOS date/time fixed at zero and general-purpose UTF-8 flag set — every
 *  byte here depends only on file content, so re-running produces the same
 *  archive bytes (deterministic packaging). Store method (0): no zlib
 *  settings to pin, and these files are small enough that it costs nothing. */
const GP_FLAG_UTF8 = 0x0800;
const DOS_TIME = 0;
const DOS_DATE = 0x21;
const UNIX_REGULAR_FILE_0644 = (0o100644 << 16) >>> 0; // `<<` yields a signed int32; force it back to unsigned

interface Entry {
  name: string;
  content: Buffer;
}

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function buildZip(entries: Entry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let cursor = 0;

  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(content);
    const offset = cursor;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(GP_FLAG_UTF8, 6);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, content);
    cursor += local.length + nameBuf.length + content.length;

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(GP_FLAG_UTF8, 8);
    central.writeUInt16LE(0, 10); // store
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(UNIX_REGULAR_FILE_0644, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralDirectoryOffset = cursor;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  eocd.writeUInt16LE(0, 20); // no archive comment

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

/** Signs unsigned when `FK_DOWNLOAD_SIGNING_KEY` (a PEM Ed25519 private key) is
 *  absent — local installs use the core's `FLIKS_UNSIGNED_PLUGINS` allowlist
 *  instead of a production key. */
export function packageArchive(): string {
  const manifestBytes = fs.readFileSync(path.join(DIST, 'plugin.json'));
  const pluginJsBytes = fs.readFileSync(path.join(DIST, 'plugin.js'));
  const logoBytes = fs.readFileSync(path.join(DIST, 'logo.svg'));

  const entries: Entry[] = [{ name: 'plugin.json', content: manifestBytes }];

  const keyPem = process.env.FK_DOWNLOAD_SIGNING_KEY;
  if (keyPem) {
    const privateKey = createPrivateKey({ key: keyPem, format: 'pem' });
    const signature = ed25519Sign(null, manifestBytes, privateKey).toString('base64');
    entries.push({ name: 'plugin.json.sig', content: Buffer.from(signature, 'utf8') });
  }

  entries.push({ name: 'plugin.js', content: pluginJsBytes }, { name: 'logo.svg', content: logoBytes });

  const zip = buildZip(entries);
  fs.writeFileSync(OUT_FILE, zip);
  return OUT_FILE;
}

if (require.main === module) {
  const outFile = packageArchive();
  console.log(`wrote ${outFile} (${process.env.FK_DOWNLOAD_SIGNING_KEY ? 'signed' : 'unsigned'})`);
}
