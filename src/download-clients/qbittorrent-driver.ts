import { decodeHtmlEntities } from '../indexers/decode-html-entities';
import { log } from '../log';
import type { ClientTestResult, ClientTorrent, ClientTorrentFile, ClientTorrentFilesResult, ClientTorrentsResult, DownloadClientDriver } from './contract';
import type { DownloadClientRow } from '../db/rows';
import { extractMagnetInfoHash, computeInfoHash } from './torrent-hash';
import {
  DownloadClientAuthError,
  DownloadClientHttpError,
  DownloadClientUnreachableError,
  TorrentAlreadyPresentError,
  TorrentHashUnresolvedError,
  type QbittorrentSettings,
} from './types';

const USER_AGENT = 'Fliks/1.0';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Host + port + scheme, normalised from whatever shape the admin typed in
 *  (a bare host, one with a scheme, one with a port already appended). */
export function buildBaseUrl(s: Pick<QbittorrentSettings, 'host' | 'port' | 'useSsl'>): string | null {
  let host = String(s.host || '').replace(/\/$/, '');
  if (!host) return null;
  const protocol = s.useSsl ? 'https' : 'http';
  host = host.replace(/^https?:\/\//i, '');
  const portFromHost = host.match(/:(\d+)$/);
  if (portFromHost) host = host.replace(/:\d+$/, '');
  const port = s.port || (portFromHost ? Number(portFromHost[1]) : undefined);
  return `${protocol}://${host}${port ? `:${port}` : ''}`;
}

/** Decodes the `&amp;` a Torznab XML response's download URL carries. */
function sanitizeUrl(url: string): string {
  return url.replace(/&amp;/g, '&');
}

interface RequestOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: RequestInit['body'];
  timeoutMs: number;
  redirect?: RequestInit['redirect'];
}

async function httpRequest(url: string, opts: RequestOpts): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    return await fetch(url, {
      method: opts.method ?? 'GET',
      headers: { 'User-Agent': USER_AGENT, ...opts.headers },
      body: opts.body,
      redirect: opts.redirect,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Authenticates and returns the `Cookie` header for subsequent calls. Rejects with
 *  {@link DownloadClientUnreachableError} on a network failure and
 *  {@link DownloadClientAuthError} on a login the client itself refused — the two
 *  outcomes every call site distinguishes. */
async function login(base: string, s: Pick<QbittorrentSettings, 'username' | 'password'>, timeoutMs: number): Promise<string> {
  const form = new URLSearchParams({ username: s.username ?? '', password: s.password ?? '' });
  let res: Response;
  try {
    res = await httpRequest(`${base}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      timeoutMs,
    });
  } catch (e) {
    const cause = (e as { cause?: Error }).cause;
    throw new DownloadClientUnreachableError(`could not reach the download client: ${cause?.message ?? (e as Error).message}`);
  }
  const cookies = res.headers.getSetCookie();
  const body = await res.text();
  if (!cookies.length || body === 'Fails.') {
    throw new DownloadClientAuthError('download client authentication failed');
  }
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

async function parseJsonArray(res: Response): Promise<unknown[] | null> {
  if (res.status !== 200) return null;
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

async function snapshotHashes(base: string, cookie: string): Promise<Set<string>> {
  try {
    const res = await httpRequest(`${base}/api/v2/torrents/info`, { headers: { Cookie: cookie }, timeoutMs: 60_000 });
    const parsed = await parseJsonArray(res);
    if (!parsed) return new Set();
    return new Set(
      (parsed as { hash?: string }[]).map((t) => t.hash?.toLowerCase()).filter((h): h is string => !!h),
    );
  } catch {
    return new Set();
  }
}

/** Polls `/torrents/info` for the torrent that just appeared, diffing against
 *  `before`. ~3s budget split across 6 attempts: the client needs a few hundred
 *  ms to register a magnet that hasn't fetched metadata yet. */
async function recoverNewlyAddedHash(base: string, cookie: string, before: Set<string>): Promise<string | undefined> {
  const ATTEMPTS = 6;
  const DELAY_MS = 500;
  for (let i = 0; i < ATTEMPTS; i++) {
    await sleep(DELAY_MS);
    const res = await httpRequest(`${base}/api/v2/torrents/info`, { headers: { Cookie: cookie }, timeoutMs: 60_000 });
    const parsed = await parseJsonArray(res);
    if (!parsed) continue;
    const after = parsed as { hash?: string; added_on?: number }[];
    const fresh = after.filter((t) => t.hash && !before.has(t.hash.toLowerCase()));
    if (fresh.length === 1) return fresh[0]!.hash!.toLowerCase();
    if (fresh.length > 1) {
      // Another consumer of the same client raced us — best effort, pick the newest.
      fresh.sort((a, b) => (b.added_on ?? 0) - (a.added_on ?? 0));
      return fresh[0]!.hash!.toLowerCase();
    }
  }
  return undefined;
}

/** Walks the indexer's redirect chain by hand so a `magnet:` Location header
 *  (LimeTorrents et al.) can be caught before it is dialled like a regular URL —
 *  `fetch` has no magnet protocol handler. */
async function fetchTorrentOrMagnet(startUrl: string, maxHops = 5): Promise<{ buffer: Buffer } | { magnet: string }> {
  let url = startUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    let res: Response;
    try {
      res = await httpRequest(url, { timeoutMs: 30_000, redirect: 'manual' });
    } catch (e) {
      const cause = (e as { cause?: Error }).cause;
      throw new DownloadClientUnreachableError(`could not fetch the torrent from the indexer: ${cause?.message ?? (e as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new DownloadClientHttpError(res.status, `indexer redirected without a Location header (HTTP ${res.status})`);
      if (location.startsWith('magnet:')) return { magnet: location };
      url = new URL(location, url).toString();
      continue;
    }
    if (res.status !== 200) {
      throw new DownloadClientHttpError(res.status, `indexer returned HTTP ${res.status} for the torrent download`);
    }
    return { buffer: Buffer.from(await res.arrayBuffer()) };
  }
  throw new Error(`indexer redirect chain exceeded ${maxHops} hops`);
}

async function addMagnet(base: string, cookie: string, magnetUrl: string, category: string): Promise<Response> {
  const form = new URLSearchParams({ urls: magnetUrl });
  if (category) form.set('category', category);
  return httpRequest(`${base}/api/v2/torrents/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: form,
    timeoutMs: 60_000,
  });
}

/** Native `FormData`/`Blob` encode the multipart body `fetch` needs — no
 *  extra dependency for what one file field and one text field require. */
async function addTorrentFile(base: string, cookie: string, buffer: Buffer, category: string): Promise<Response> {
  const fd = new FormData();
  fd.append('torrents', new Blob([buffer], { type: 'application/x-bittorrent' }), 'download.torrent');
  if (category) fd.append('category', category);
  return httpRequest(`${base}/api/v2/torrents/add`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: fd,
    timeoutMs: 60_000,
  });
}

export class QbittorrentDriver implements DownloadClientDriver {
  supports(client: DownloadClientRow): boolean {
    if (!client.enabled) return false;
    return (client.implementation || '').toLowerCase().includes('qbittorrent');
  }

  async testConnection(settings: Record<string, unknown>): Promise<ClientTestResult> {
    const s = settings as QbittorrentSettings;
    const base = buildBaseUrl(s);
    if (!base) return { ok: false, messageKey: 'download.download_clients.test.host_missing' };
    try {
      await login(base, s, 10_000);
      return { ok: true, messageKey: 'download.download_clients.test.ok' };
    } catch (e) {
      if (e instanceof DownloadClientAuthError) {
        return { ok: false, messageKey: 'download.download_clients.test.auth_failed' };
      }
      return { ok: false, messageKey: 'download.download_clients.test.network_error', detail: (e as Error).message };
    }
  }

  async getTorrents(client: DownloadClientRow): Promise<ClientTorrent[]> {
    return (await this.getTorrentsResult(client)).torrents;
  }

  async getTorrentsResult(client: DownloadClientRow): Promise<ClientTorrentsResult> {
    const s = client.settings as QbittorrentSettings;
    const base = buildBaseUrl(s);
    if (!base) return { ok: false, torrents: [] };

    let cookie: string;
    try {
      cookie = await login(base, s, 15_000);
    } catch (e) {
      log.warn(`getTorrentsResult: auth failed for client "${client.name}": ${(e as Error).message}`);
      return { ok: false, torrents: [] };
    }

    try {
      const category = String(s.category ?? '').trim();
      const qs = category ? `?category=${encodeURIComponent(category)}` : '';
      const res = await httpRequest(`${base}/api/v2/torrents/info${qs}`, { headers: { Cookie: cookie }, timeoutMs: 15_000 });
      const parsed = await parseJsonArray(res);
      if (!parsed) {
        log.warn(`getTorrentsResult: unexpected response from "${client.name}" (HTTP ${res.status})`);
        return { ok: false, torrents: [] };
      }
      // Decode HTML entities baked into the `.torrent` `name` field by misbehaving
      // indexers (`Berl&iacute;n` → `Berlín`) so history matching sees the real title.
      const torrents = (parsed as ClientTorrent[]).map((t) => ({
        ...t,
        name: t.name ? decodeHtmlEntities(t.name) : t.name,
        completion_on: Number.isFinite(Number(t.completion_on)) ? Number(t.completion_on) : undefined,
      }));
      return { ok: true, torrents };
    } catch (e) {
      log.warn(`getTorrentsResult: error fetching torrents from "${client.name}": ${(e as Error).message}`);
      return { ok: false, torrents: [] };
    }
  }

  async getTorrentFilesResult(client: DownloadClientRow, hash: string): Promise<ClientTorrentFilesResult> {
    const s = client.settings as QbittorrentSettings;
    const base = buildBaseUrl(s);
    if (!base) return { ok: false, files: [] };
    let cookie: string;
    try {
      cookie = await login(base, s, 15_000);
    } catch (e) {
      log.warn(`getTorrentFilesResult: auth failed for client "${client.name}": ${(e as Error).message}`);
      return { ok: false, files: [] };
    }
    try {
      const res = await httpRequest(`${base}/api/v2/torrents/files?hash=${encodeURIComponent(hash)}`, {
        headers: { Cookie: cookie },
        timeoutMs: 15_000,
      });
      const parsed = await parseJsonArray(res);
      if (!parsed) {
        log.warn(`getTorrentFilesResult: unexpected response for hash ${hash} (HTTP ${res.status})`);
        return { ok: false, files: [] };
      }
      return { ok: true, files: parsed as ClientTorrentFile[] };
    } catch (e) {
      log.warn(`getTorrentFilesResult: error for hash ${hash}: ${(e as Error).message}`);
      return { ok: false, files: [] };
    }
  }

  /**
   * qBittorrent 5.x spells these `/stop` and `/start`; 4.x spells them `/pause` and `/resume`.
   * Both are in the wild — `progress-state.ts` already maps both state vocabularies — so the
   * modern name is tried first and the older one only on a refusal, which costs one extra
   * round trip exactly once per 4.x client.
   */
  async pauseTorrent(client: DownloadClientRow, hash: string): Promise<void> {
    await this.command(client, hash, 'stop', 'pause');
  }

  async resumeTorrent(client: DownloadClientRow, hash: string): Promise<void> {
    await this.command(client, hash, 'start', 'resume');
  }

  private async command(
    client: DownloadClientRow,
    hash: string,
    action: string,
    legacyAction: string,
  ): Promise<void> {
    const s = client.settings as QbittorrentSettings;
    const base = buildBaseUrl(s);
    if (!base) throw new DownloadClientUnreachableError('download client has no host configured');
    const cookie = await login(base, s, 15_000);
    const post = (name: string) =>
      httpRequest(`${base}/api/v2/torrents/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: new URLSearchParams({ hashes: hash }),
        timeoutMs: 15_000,
      });
    let res = await post(action);
    if (res.status === 404) res = await post(legacyAction);
    if (res.status !== 200) {
      throw new DownloadClientHttpError(res.status, `the download client refused ${action} (HTTP ${res.status})`);
    }
  }

  async deleteTorrent(client: DownloadClientRow, hash: string, deleteFiles = false): Promise<void> {
    const s = client.settings as QbittorrentSettings;
    const base = buildBaseUrl(s);
    if (!base) throw new DownloadClientUnreachableError('download client has no host configured');
    const cookie = await login(base, s, 15_000);
    const params = new URLSearchParams({ hashes: hash, deleteFiles: String(deleteFiles) });
    const res = await httpRequest(`${base}/api/v2/torrents/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: params,
      timeoutMs: 15_000,
    });
    if (res.status !== 200) {
      throw new DownloadClientHttpError(res.status, `the download client refused the deletion (HTTP ${res.status})`);
    }
  }

  async addTorrentUrl(
    client: DownloadClientRow,
    torrentUrl: string,
    mediaType?: 'movie' | 'series',
    rejectIfAlreadyPresent = false,
  ): Promise<string> {
    const url = sanitizeUrl(torrentUrl);
    const s = client.settings as QbittorrentSettings;
    const base = buildBaseUrl(s);
    if (!base) throw new DownloadClientUnreachableError('download client has no host configured');

    let category = String(s.category ?? '').trim();
    if (mediaType === 'movie' && s.movieCategory) category = String(s.movieCategory).trim();
    if (mediaType === 'series' && s.seriesCategory) category = String(s.seriesCategory).trim();

    const cookie = await login(base, s, 60_000);

    // Snapshot before the add so a hash the upfront extractors missed can be
    // recovered by diffing, and so a duplicate add (the client dedupes by hash,
    // creating nothing) can be detected and rejected when asked to.
    const beforeHashes = await snapshotHashes(base, cookie);

    /**
     * An infohash identifies the content, so a torrent the client already holds *is* the release
     * being grabbed: there is nothing to add and nothing to re-download. Deciding this before the
     * add matters — qBittorrent answers a duplicate with 409, which used to surface as "the
     * download client refused the torrent" on a release that was already there, sometimes
     * already finished.
     */
    const alreadyHeld = (hash: string | undefined): string | undefined => {
      if (!hash || !beforeHashes.has(hash.toLowerCase())) return undefined;
      if (rejectIfAlreadyPresent) {
        throw new TorrentAlreadyPresentError(`torrent ${hash} is already in the download client`);
      }
      return hash;
    };

    let infoHash: string | undefined;
    let addRes: Response;

    if (url.startsWith('magnet:')) {
      infoHash = extractMagnetInfoHash(url);
      const held = alreadyHeld(infoHash);
      if (held) return held;
      addRes = await addMagnet(base, cookie, url, category);
    } else {
      const fetched = await fetchTorrentOrMagnet(url);
      if ('magnet' in fetched) {
        infoHash = extractMagnetInfoHash(fetched.magnet);
        const held = alreadyHeld(infoHash);
        if (held) return held;
        addRes = await addMagnet(base, cookie, fetched.magnet, category);
      } else {
        infoHash = computeInfoHash(fetched.buffer);
        const held = alreadyHeld(infoHash);
        if (held) return held;
        addRes = await addTorrentFile(base, cookie, fetched.buffer, category);
      }
    }

    if (addRes.status !== 200) {
      throw new DownloadClientHttpError(addRes.status, `the download client refused the torrent (HTTP ${addRes.status})`);
    }

    if (!infoHash) {
      infoHash = await recoverNewlyAddedHash(base, cookie, beforeHashes);
    }
    if (!infoHash) {
      throw new TorrentHashUnresolvedError('could not determine the hash of the torrent that was just added');
    }

    // Only reachable when the hash could not be read before the add: the checks above return
    // or throw otherwise. The add created nothing in that case (the client dedupes by hash),
    // so refusing after the fact costs nothing.
    if (rejectIfAlreadyPresent && beforeHashes.has(infoHash.toLowerCase())) {
      throw new TorrentAlreadyPresentError(`torrent ${infoHash} is already in the download client`);
    }

    return infoHash;
  }
}
