import type { IndexerRow } from '../db/rows';
import type { IndexerRelease } from './types';
import { decodeHtmlEntities } from './decode-html-entities';

/** Parses a `supportedParams` attribute into a lookup. A tracker handed an id it does not
 *  index answers 200 with an empty feed rather than an error, so an unsupported param is a
 *  silent zero-result search — always filter against this before sending one. Null means the
 *  caps predate the column, so nothing beyond `q` is assumed. */
export function parseSupportedParams(attr: string | null | undefined): Set<string> {
  return new Set(
    (attr ?? '')
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Reads `supportedParams` off a caps element, e.g. `<movie-search available="yes"
 *  supportedParams="q,imdbid" />`. Null when the element or the attribute is absent. */
export function supportedParamsOf(capsBody: string, element: string): string | null {
  const el = capsBody.match(new RegExp(`<${element}\\s[^>]*>`, 'i'))?.[0];
  return el?.match(/supportedParams="([^"]*)"/i)?.[1]?.trim() || null;
}

/** Builds a Torznab query string, dropping null/undefined optional params so
 *  external-id filters are only sent when known. IMDb IDs lose their `tt`
 *  prefix — what every Newznab-spec indexer expects on the wire.
 *  `supportedParams`, when given, additionally drops any id the indexer does not advertise. */
export function buildTorznabQuery(opts: {
  t: string;
  q?: string;
  season?: number;
  ep?: number;
  cat: string;
  apiKey: string;
  tvdbId?: number | null;
  imdbId?: string | null;
  tmdbId?: number | null;
  supportedParams?: Set<string>;
}): string {
  const allows = (param: string) => !opts.supportedParams || opts.supportedParams.has(param);
  const parts: string[] = [`t=${opts.t}`];
  if (opts.q) parts.push(`q=${encodeURIComponent(opts.q)}`);
  if (opts.season != null) parts.push(`season=${opts.season}`);
  if (opts.ep != null) parts.push(`ep=${opts.ep}`);
  parts.push(`cat=${opts.cat}`);
  parts.push(`apikey=${encodeURIComponent(opts.apiKey)}`);
  if (opts.tvdbId && allows('tvdbid')) parts.push(`tvdbid=${opts.tvdbId}`);
  if (opts.imdbId && allows('imdbid')) {
    const stripped = opts.imdbId.replace(/^tt/i, '');
    if (stripped) parts.push(`imdbid=${stripped}`);
  }
  if (opts.tmdbId && allows('tmdbid')) parts.push(`tmdbid=${opts.tmdbId}`);
  return parts.join('&');
}

/** Log-friendly summary of a Torznab query URL. Never includes the API key. */
export function describeTorznabQuery(url: string): string {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return 'search';
  }
  const parts = [params.get('t') ?? 'search'];
  const q = params.get('q');
  if (q) parts.push(`q="${q}"`);
  for (const key of ['season', 'ep', 'cat', 'tvdbid', 'imdbid', 'tmdbid']) {
    const value = params.get(key);
    if (value) parts.push(`${key}=${value}`);
  }
  return parts.join(' ');
}

function extractInnerXml(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const inner = block.match(re)?.[1];
  if (inner === undefined) return null;
  return decodeHtmlEntities(inner.replace(/<!\[CDATA\[|\]\]>/g, '').trim());
}

function torznabAttr(block: string, name: string): string | null {
  const re = new RegExp(`<torznab:attr[^>]+name="${name}"[^>]+value="([^"]*)"`, 'i');
  return block.match(re)?.[1]?.trim() ?? null;
}

/** Forces the configured API key onto a download URL — the XML may carry a stale
 *  or invalid one. No-op for magnet links (they carry no query string worth touching). */
function ensureApiKey(url: string, apiKey: string): string {
  if (!apiKey || url.startsWith('magnet:')) return url;
  try {
    const u = new URL(decodeHtmlEntities(url));
    u.searchParams.set('apikey', apiKey);
    return u.toString();
  } catch {
    return url;
  }
}

/** Parses every `<item>` in a Torznab RSS body into an {@link IndexerRelease}.
 *  Skips silently (no throw) whenever a hit is missing a title or a usable URL —
 *  a third-party feed is never trusted to be well-formed. */
export function parseTorznabItems(xml: string, indexer: IndexerRow): IndexerRelease[] {
  const settings = indexer.settings as { apiKey?: string };
  const apiKey = String(settings.apiKey || '');
  const out: IndexerRelease[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1] ?? '';
    const title = extractInnerXml(block, 'title');
    const link = extractInnerXml(block, 'link');
    const magnetMatch =
      block.match(/name="magneturl"\s+value="([^"]*)"/i) ?? block.match(/name='magneturl'\s+value='([^']*)'/i);
    const magnetRaw = magnetMatch?.[1];
    const magnet = magnetRaw ? decodeHtmlEntities(magnetRaw.trim()) : undefined;
    const enc = block.match(/<enclosure[^>]*\surl="([^"]+)"/i);
    const encUrlRaw = enc?.[1];
    const encUrl = encUrlRaw ? decodeHtmlEntities(encUrlRaw.trim()) : undefined;
    const url =
      magnet ||
      (link?.startsWith('magnet:') ? link : null) ||
      encUrl ||
      (link && !link.startsWith('http://localhost') ? link : null);
    if (!title || !url) continue;

    // Size: prefer <enclosure length="…">, fallback to torznab:attr name="size"
    const encLen = enc?.[0]?.match(/\blength="(\d+)"/i)?.[1];
    const sizeStr = encLen ?? torznabAttr(block, 'size') ?? extractInnerXml(block, 'size');
    const size = sizeStr ? parseInt(sizeStr, 10) || 0 : 0;

    const seeders = parseInt(torznabAttr(block, 'seeders') ?? '0', 10) || 0;
    const leechers = parseInt(torznabAttr(block, 'leechers') ?? torznabAttr(block, 'peers') ?? '0', 10) || 0;

    const dvfStr = torznabAttr(block, 'downloadvolumefactor');
    const downloadVolumeFactor = dvfStr !== null ? parseFloat(dvfStr) : 1;
    const freeleech = downloadVolumeFactor === 0;

    // The tracker's own page for this release. Torznab puts it in <comments>; Jackett and
    // Prowlarr also repeat it as a permalink <guid>, which is the fallback. Never the
    // download URL, which carries the API key.
    const commentsRaw = extractInnerXml(block, 'comments');
    const guidRaw = extractInnerXml(block, 'guid');
    const infoCandidate = commentsRaw || (guidRaw?.startsWith('http') ? guidRaw : undefined);
    const infoUrl = infoCandidate ? decodeHtmlEntities(infoCandidate.trim()) : undefined;

    const pubDateRaw = extractInnerXml(block, 'pubDate');
    let publishDate: string | null = null;
    if (pubDateRaw) {
      const d = new Date(pubDateRaw);
      if (!isNaN(d.getTime())) publishDate = d.toISOString();
    }

    out.push({
      title,
      downloadUrl: ensureApiKey(url, apiKey),
      ...(infoUrl ? { infoUrl } : {}),
      indexerId: indexer.id,
      indexerName: indexer.name,
      size,
      seeders,
      leechers,
      publishDate,
      freeleech,
      downloadVolumeFactor,
    });
  }
  return out;
}
