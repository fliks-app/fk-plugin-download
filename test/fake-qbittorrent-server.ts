/** A tiny real HTTP server that impersonates qBittorrent's Web API — not a
 *  suffix, so `npm test`'s `test/*.test.ts` glob skips it (see `db-test-helpers.ts`).
 *  Exercises the real driver's authentication, cookie handling and error paths
 *  against actual HTTP responses instead of a mock of the driver's own code. */
import * as http from 'http';
import { randomBytes } from 'crypto';

export interface FakeTorrent {
  hash: string;
  name: string;
  size: number;
  downloaded: number;
  progress: number;
  dlspeed: number;
  upspeed: number;
  ratio: number;
  eta: number;
  state: string;
  category: string;
  num_seeds: number;
  num_leechs: number;
  added_on: number;
}

export type InfoResponseMode = 'array' | 'not-json' | 'not-array' | 'error-500';

export interface FakeQbitOptions {
  username?: string;
  password?: string;
  torrents?: FakeTorrent[];
  /** Hash assigned when an add can't be attributed to a magnet's own `xt=urn:btih:`. */
  nextAddHash?: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  cookie?: string;
}

const CONTROL_NAMES: Record<'v5' | 'v4' | 'none', string[]> = {
  v5: ['stop', 'start'],
  v4: ['pause', 'resume'],
  none: [],
};

export function makeTorrent(over: Partial<FakeTorrent> = {}): FakeTorrent {
  return {
    hash: 'a'.repeat(40),
    name: 'Some.Release.1080p',
    size: 1_000_000,
    downloaded: 0,
    progress: 0,
    dlspeed: 0,
    upspeed: 0,
    ratio: 0,
    eta: 8640000,
    state: 'downloading',
    category: '',
    num_seeds: 1,
    num_leechs: 1,
    added_on: Math.floor(Date.now() / 1000),
    ...over,
  };
}

export class FakeQbitServer {
  readonly torrents: FakeTorrent[];
  readonly requests: RecordedRequest[] = [];
  infoMode: InfoResponseMode = 'array';
  infoStatus = 200;
  filesMode: 'array' | 'not-array' = 'array';
  files: { name: string; size: number; progress: number; priority: number }[] = [];
  addStatus = 200;
  deleteStatus = 200;
  /** Which spelling of stop/resume this server answers. qBittorrent 5.x renamed
   *  `pause`/`resume` to `stop`/`start`; whichever pair is not this generation's 404s,
   *  as a real one does. `none` answers neither — a client too old or too broken for both. */
  controlGeneration: 'v5' | 'v4' | 'none' = 'v5';

  private readonly sessions = new Set<string>();

  private constructor(
    private readonly server: http.Server,
    private readonly opts: FakeQbitOptions,
  ) {
    this.torrents = opts.torrents ?? [];
  }

  static async start(opts: FakeQbitOptions = {}): Promise<FakeQbitServer> {
    const instance: { self?: FakeQbitServer } = {};
    const server = http.createServer((req, res) => void instance.self!.handle(req, res));
    const self = new FakeQbitServer(server, opts);
    instance.self = self;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return self;
  }

  get url(): string {
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') throw new Error('server not listening');
    return `http://127.0.0.1:${addr.port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, cookie: req.headers.cookie });
    const body = await this.readBody(req);

    if (req.method === 'POST' && url.pathname === '/api/v2/auth/login') {
      return this.handleLogin(body, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/v2/torrents/info') {
      return this.handleInfo(url, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/v2/torrents/files') {
      return this.handleFiles(res);
    }
    if (req.method === 'POST' && url.pathname === '/api/v2/torrents/add') {
      return this.handleAdd(req, body, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/v2/torrents/delete') {
      return this.handleDelete(body, res);
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/v2/torrents/')) {
      const known = CONTROL_NAMES[this.controlGeneration];
      if (known.includes(url.pathname.split('/').pop() ?? '')) {
        res.writeHead(200).end();
        return;
      }
    }
    if (req.method === 'GET' && url.pathname === '/indexer/magnet-redirect') {
      res.writeHead(302, { Location: `magnet:?xt=urn:btih:${'b'.repeat(40)}` });
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/indexer/torrent-file') {
      // Minimal valid bencode: a dict with one "info" dict inside.
      const infoBencode = 'd4:name5:hello12:piece lengthi16384ee';
      const torrent = `d4:info${infoBencode}e`;
      res.end(Buffer.from(torrent));
      return;
    }
    res.writeHead(404).end();
  }

  private handleLogin(body: Buffer, res: http.ServerResponse): void {
    const params = new URLSearchParams(body.toString('utf8'));
    const username = this.opts.username ?? 'admin';
    const password = this.opts.password ?? 'adminpw';
    if (params.get('username') === username && params.get('password') === password) {
      const sid = randomBytes(8).toString('hex');
      this.sessions.add(sid);
      res.setHeader('Set-Cookie', [`SID=${sid}; HttpOnly; Path=/`, `other=x; Path=/`]);
      res.writeHead(200);
      res.end('Ok.');
      return;
    }
    res.writeHead(200);
    res.end('Fails.');
  }

  private handleInfo(url: URL, res: http.ServerResponse): void {
    if (this.infoStatus !== 200) {
      res.writeHead(this.infoStatus);
      res.end('Internal Server Error');
      return;
    }
    if (this.infoMode === 'not-json') {
      res.writeHead(200);
      res.end('not json at all');
      return;
    }
    if (this.infoMode === 'not-array') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const category = url.searchParams.get('category');
    const list = category ? this.torrents.filter((t) => t.category === category) : this.torrents;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
  }

  private handleFiles(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(this.filesMode === 'array' ? JSON.stringify(this.files) : '{}');
  }

  private async handleAdd(req: http.IncomingMessage, body: Buffer, res: http.ServerResponse): Promise<void> {
    if (this.addStatus !== 200) {
      res.writeHead(this.addStatus);
      res.end('refused');
      return;
    }
    const contentType = req.headers['content-type'] ?? '';
    let hash: string | undefined;
    let category: string | undefined;
    if (contentType.includes('multipart/form-data')) {
      hash = this.opts.nextAddHash ?? 'c'.repeat(40);
      const catMatch = body.toString('latin1').match(/name="category"\r\n\r\n([^\r\n]*)/);
      category = catMatch?.[1];
    } else {
      const params = new URLSearchParams(body.toString('utf8'));
      const urls = params.get('urls') ?? '';
      hash = urls.match(/xt=urn:btih:([a-fA-F0-9]{40})/)?.[1]?.toLowerCase() ?? (this.opts.nextAddHash ?? 'c'.repeat(40));
      category = params.get('category') ?? undefined;
    }
    if (hash && !this.torrents.some((t) => t.hash.toLowerCase() === hash!.toLowerCase())) {
      this.torrents.push(makeTorrent({ hash, category: category ?? '' }));
    }
    res.writeHead(200);
    res.end('Ok.');
  }

  private handleDelete(body: Buffer, res: http.ServerResponse): void {
    if (this.deleteStatus !== 200) {
      res.writeHead(this.deleteStatus);
      res.end('refused');
      return;
    }
    const params = new URLSearchParams(body.toString('utf8'));
    const hashes = (params.get('hashes') ?? '').split('|').map((h) => h.toLowerCase());
    for (const h of hashes) {
      const idx = this.torrents.findIndex((t) => t.hash.toLowerCase() === h);
      if (idx >= 0) this.torrents.splice(idx, 1);
    }
    res.writeHead(200);
    res.end();
  }
}
