// One HTTP server for every surface that is not a terminal: the PWA, its JSON
// API, MCP over HTTP, and the stream proxy. node:http so it runs unchanged
// under Node, Bun and Electron's main process.

import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { channelsFor, readConfig } from '../core/config.js';
import { guideFor, loadGuide, nowNextFor } from '../core/guide.js';
import { isPlaylist, rewritePlaylist } from '../core/hls.js';
import { fetchPublic } from '../core/publicurl.js';
import { groupsOf, loadSource } from '../core/sources.js';
import { b64urlDecode, proxyPath } from '../core/util.js';
import { VERSION } from '../version.js';
import { createAccounts } from './accounts.js';
import { withFooter } from './footer.js';
import { handleRpc } from './mcp.js';
import { createRemuxer, hasFfmpeg } from './remux.js';

const here = dirname(fileURLToPath(import.meta.url));
export const WEB_DIR = process.env.HDTILT_WEB_DIR || join(here, '../../web/dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// Some providers only answer players they recognise. Overridable.
const UPSTREAM_UA = process.env.HDTILT_UA || 'VLC/3.0.21 LibVLC/3.0.21';

/**
 * @param {{ public?: boolean, allowPrivate?: boolean, maxStreamsPerIp?: number }} opts
 *   public: a shared deployment (hdtilt.com). It keeps no playlists, refuses
 *   private addresses, and caps concurrent proxied streams per client.
 */
export function createApp(opts = {}) {
  const isPublic = opts.public ?? process.env.HDTILT_PUBLIC === '1';
  // HDTILT_ALLOW_PRIVATE=1: a public box that also serves a tuner on its own LAN (and tests).
  const allowPrivate = opts.allowPrivate ?? (process.env.HDTILT_ALLOW_PRIVATE === '1' || !isPublic);
  const maxStreams = opts.maxStreamsPerIp ?? (isPublic ? 3 : Number.POSITIVE_INFINITY);
  const streamsByIp = new Map();

  /** fetch, routed through the SSRF guard. */
  const guardedFetch = async (url, init = {}) => {
    const headers = { 'user-agent': UPSTREAM_UA, ...(init.headers || {}) };
    const { res } = await fetchPublic(String(url), { headers, allowPrivate, signal: init.signal });
    return res;
  };
  const ctx = { public: isPublic, fetch: guardedFetch };
  // Set by startServer once the port is known: ffmpeg reads through our own proxy.
  let selfPort = 0;
  const remuxBy = new Map(); // client ip -> conversion keys it started
  // Proves a proxy request is ffmpeg's own read, not a viewer's. Per process.
  const internalKey = randomBytes(16).toString('hex');
  const remux =
    opts.remux === false || !hasFfmpeg()
      ? null
      : createRemuxer({
          inputFor: (url) => `http://127.0.0.1:${selfPort}${proxyPath(url, 'mpegts')}`,
          headers: { 'x-hdtilt-internal': internalKey },
        });
  const accounts = opts.accounts === undefined ? createAccounts() : opts.accounts;
  const gated = isPublic && Boolean(accounts);

  // Sign-in and sign-up are the guessable endpoints: 20 tries a minute per address.
  const authPerMinute = opts.authPerMinute ?? 20;
  const hits = new Map();
  const limited = (ip) => {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.at > 60_000) {
      hits.set(ip, { at: now, n: 1 });
      if (hits.size > 10_000) hits.clear();
      return false;
    }
    return ++h.n > authPerMinute;
  };

  const clientIp = (req) =>
    (isPublic &&
      (req.headers['x-real-ip'] ||
        String(req.headers['x-forwarded-for'] || '')
          .split(',')[0]
          .trim())) ||
    req.socket.remoteAddress ||
    '?';

  const send = (res, status, body, headers = {}) => {
    const isJson = typeof body !== 'string' && !(body instanceof Uint8Array);
    res.writeHead(status, {
      'content-type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body);
  };

  const readJson = (req, limit = 1 << 20) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const parts = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('request too large'));
          req.destroy();
        } else parts.push(c);
      });
      req.on('end', () => {
        try {
          resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {});
        } catch {
          reject(new Error('body is not JSON'));
        }
      });
      req.on('error', reject);
    });

  async function proxy(req, res, token) {
    let upstream;
    try {
      upstream = b64urlDecode(token);
      new URL(upstream);
    } catch {
      return send(res, 400, 'bad stream address');
    }
    const ip = clientIp(req);
    // ffmpeg reading for the HLS converter: inside the box, no X-Real-IP.
    const internal = isInternal(req);
    const short = /\.(m3u8?|png|jpe?g|gif|webp|svg|ico)$/i.test(new URL(upstream).pathname);
    // Playlists and logos are short requests; only a long-lived body counts.
    const counted = !short && !internal;
    if (counted) {
      const n = streamsByIp.get(ip) || 0;
      if (n >= maxStreams) return send(res, 429, 'too many streams from this address');
      streamsByIp.set(ip, n + 1);
    }
    const release = () => {
      if (!counted) return;
      const n = (streamsByIp.get(ip) || 1) - 1;
      if (n <= 0) streamsByIp.delete(ip);
      else streamsByIp.set(ip, n);
    };
    const ac = new AbortController();
    res.on('close', () => {
      ac.abort();
      release();
    });

    let up;
    try {
      const headers = { 'user-agent': UPSTREAM_UA };
      if (req.headers.range) headers.range = req.headers.range;
      up = (await fetchPublic(upstream, { headers, allowPrivate, signal: ac.signal })).res;
    } catch (e) {
      return send(res, 502, `upstream: ${e.message}`);
    }
    const type = up.headers.get('content-type') || '';
    if (up.ok && isPlaylist(type, upstream)) {
      const text = await up.text();
      // A provider that 302s to a CDN has moved the playlist; resolve against where it ended up.
      const body = rewritePlaylist(text, up.url || upstream, (abs) => proxyPath(abs));
      return send(res, 200, body, { 'content-type': 'application/vnd.apple.mpegurl' });
    }
    const headers = {
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      'content-type': type || 'video/mp2t',
    };
    for (const h of ['content-length', 'content-range', 'accept-ranges']) {
      const v = up.headers.get(h);
      if (v) headers[h] = v;
    }
    res.writeHead(up.status, headers);
    if (!up.body) return res.end();
    Readable.fromWeb(up.body)
      .on('error', () => res.destroy())
      .pipe(res);
  }

  async function api(req, res, path) {
    if (path === '/api/health')
      return send(res, 200, {
        ok: true,
        version: VERSION,
        public: isPublic,
        accounts: Boolean(accounts),
        hls: Boolean(remux),
      });

    if (
      path.startsWith('/api/auth/') ||
      path === '/api/me' ||
      path === '/api/library' ||
      path === '/api/oauth/authorize'
    ) {
      if (!accounts) return send(res, 404, { error: 'accounts are not enabled on this server' });
      return account(req, res, path);
    }

    // hdtilt.com needs an account before it loads anything; a local install has none.
    if (gated && (path === '/api/load' || path === '/api/guide' || path === '/api/nownext')) {
      if (!(await accounts.whoFrom(req.headers.authorization)))
        return send(res, 401, { error: 'Sign in first', code: 'signin' });
    }

    // Load a playlist the browser holds. Stateless: nothing is stored.
    if (path === '/api/load' && req.method === 'POST') {
      const { source } = await readJson(req);
      if (!source?.type) return send(res, 400, { error: 'source required' });
      const data = await loadSource(source, { fetch: guardedFetch });
      return send(res, 200, { ...data, groups: groupsOf(data.channels) });
    }

    // Programmes for a set of channels. channels: [{id, name, tvgId}]
    if (path === '/api/guide' && req.method === 'POST') {
      const { url, channels, from, to } = await readJson(req, 16 << 20);
      if (!url || !Array.isArray(channels)) return send(res, 400, { error: 'url and channels required' });
      const g = await loadGuide(url, { fetch: guardedFetch });
      return send(res, 200, { programmes: guideFor(g, channels, { from, to }), fetchedAt: g.fetchedAt });
    }
    if (path === '/api/nownext' && req.method === 'POST') {
      const { url, channels } = await readJson(req, 16 << 20);
      if (!url || !Array.isArray(channels)) return send(res, 400, { error: 'url and channels required' });
      return send(res, 200, nowNextFor(await loadGuide(url, { fetch: guardedFetch }), channels));
    }

    // The local install's saved playlists, for the desktop app and the TUI.
    if (path === '/api/playlists' && !isPublic) {
      const cfg = await readConfig();
      return send(
        res,
        200,
        Object.entries(cfg.playlists).map(([name, s]) => ({ name, type: s.type, current: name === cfg.current })),
      );
    }
    const m = /^\/api\/playlists\/([^/]+)$/.exec(path);
    if (m && !isPublic) {
      const pl = await channelsFor(decodeURIComponent(m[1]));
      return send(res, 200, {
        name: pl.name,
        source: pl.source,
        channels: pl.channels,
        epgUrl: pl.epgUrl,
        groups: groupsOf(pl.channels),
      });
    }
    return send(res, 404, { error: 'no such endpoint' });
  }

  /** ffmpeg reading for the HLS converter: it carries this process's secret header. */
  const isInternal = (req) => req.headers['x-hdtilt-internal'] === internalKey;

  const cookieOf = (req, name) => {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return decodeURIComponent(v.join('='));
    }
    return '';
  };

  /** Secure wherever the page came over https (hdtilt.com, behind nginx). */
  const mediaCookie = (value, maxAge, req) =>
    `hdtilt_media=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;

  async function mediaAllowed(req) {
    if (accounts.mediaUser(cookieOf(req, 'hdtilt_media'))) return true;
    return Boolean(req.headers.authorization && (await accounts.whoFrom(req.headers.authorization)));
  }

  /** Token and revocation endpoints take a form body (RFC 6749) or JSON. */
  const readBody = async (req) => {
    const type = String(req.headers['content-type'] || '');
    if (type.includes('application/json')) return readJson(req);
    const parts = [];
    for await (const c of req) parts.push(c);
    return Object.fromEntries(new URLSearchParams(Buffer.concat(parts).toString('utf8')));
  };

  async function oauthEndpoint(req, res, path) {
    if (path === '/.well-known/oauth-authorization-server') return send(res, 200, accounts.oauth.metadata());
    if (req.method !== 'POST') return send(res, 405, { error: 'POST' });
    if (limited(clientIp(req))) return send(res, 429, { error: 'slow_down' });
    const body = await readBody(req);
    try {
      if (path === '/oauth/revoke') {
        await accounts.revoke(body.token);
        return send(res, 200, {});
      }
      return send(res, 200, await accounts.token(body));
    } catch (e) {
      return send(res, e.status || 400, { error: e.code || 'invalid_request', error_description: e.message });
    }
  }

  async function account(req, res, path) {
    const fail = (e, status = 400) =>
      send(res, e.code === 'conflict' ? 409 : status, { error: e.message, ...(e.code ? { code: e.code } : {}) });
    if (path.startsWith('/api/auth/')) {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST' });
      if (limited(clientIp(req))) return send(res, 429, { error: 'Too many tries; wait a minute' });
      const b = await readJson(req);
      try {
        switch (path) {
          case '/api/auth/register':
            return send(res, 200, await accounts.register(b));
          case '/api/auth/verify':
            return send(res, 200, await accounts.verify(b.token));
          case '/api/auth/login':
            return send(res, 200, await accounts.login(b));
          case '/api/auth/resend':
            return send(res, 200, await accounts.resendVerification(b.email));
          case '/api/auth/forgot':
            return send(res, 200, await accounts.forgot(b.email));
          case '/api/auth/reset':
            return send(res, 200, await accounts.reset(b));
          case '/api/auth/refresh':
            return send(res, 200, await accounts.refresh(b.refreshToken));
          case '/api/auth/logout':
            return send(res, 200, await accounts.logout(b), { 'set-cookie': mediaCookie('', 0, req) });
          case '/api/auth/media': {
            // Called by the app after any sign-in and at start: the cookie that
            // lets <video> and <img> through the proxy on hdtilt.com.
            const claims = await accounts.whoFrom(req.headers.authorization);
            if (!claims) return send(res, 401, { error: 'Sign in first', code: 'signin' });
            const days = 30;
            return send(
              res,
              200,
              { ok: true },
              { 'set-cookie': mediaCookie(accounts.mediaToken(claims.userId, days * 86400_000), days * 86400, req) },
            );
          }
        }
      } catch (e) {
        return fail(e, path === '/api/auth/login' || path === '/api/auth/refresh' ? 401 : 400);
      }
      return send(res, 404, { error: 'no such endpoint' });
    }
    const claims = await accounts.whoFrom(req.headers.authorization);
    if (!claims) return send(res, 401, { error: 'Sign in first' });
    try {
      if (path === '/api/me') return send(res, 200, await accounts.me(claims));
      // The consent page: only a browser session (not another OAuth token) may grant one.
      if (path === '/api/oauth/authorize') {
        if (claims.via === 'oauth') return send(res, 403, { error: 'Sign in on the website to approve' });
        const b = await readJson(req);
        return send(res, 200, await accounts.authorize(claims, b.query || {}, b.decision));
      }
      if (req.method === 'GET') return send(res, 200, await accounts.getLibrary(claims));
      if (req.method === 'PUT') return send(res, 200, await accounts.putLibrary(claims, await readJson(req, 8 << 20)));
      return send(res, 405, { error: 'GET or PUT' });
    } catch (e) {
      return fail(e);
    }
  }

  /** /hls/<b64>/index.m3u8 starts or joins a conversion; /hls/s/<key>/<segment> serves it. */
  async function hls(req, res, path) {
    if (!remux) return send(res, 501, 'this server cannot convert transport streams (no ffmpeg)');
    const seg = /^\/hls\/s\/([a-f0-9]{24})\/(seg\d+\.ts)$/.exec(path);
    if (seg) {
      const file = await remux.segment(seg[1], seg[2]);
      if (!file) return send(res, 404, 'gone');
      res.writeHead(200, {
        'content-type': 'video/mp2t',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      return createReadStream(file).pipe(res);
    }
    const m = /^\/hls\/([A-Za-z0-9_-]+)\/index\.m3u8$/.exec(path);
    if (!m) return send(res, 404, 'not found');
    let url;
    try {
      url = b64urlDecode(m[1]);
      new URL(url);
    } catch {
      return send(res, 400, 'bad stream address');
    }
    try {
      // A viewer starts at most as many conversions as streams; joining one is free.
      const ip = clientIp(req);
      const startedBy = (remuxBy.get(ip) || []).filter((k) => remux.has(k));
      const key0 = remux.keyOf(url);
      if (!remux.has(key0) && startedBy.length >= maxStreams)
        return send(res, 429, 'too many streams from this address');
      const key = await remux.start(url);
      if (!startedBy.includes(key)) remuxBy.set(ip, [...startedBy, key]);
      const text = await remux.playlist(key);
      const body = text.replace(/^(seg\d+\.ts)$/gm, `/hls/s/${key}/$1`);
      return send(res, 200, body, { 'content-type': 'application/vnd.apple.mpegurl' });
    } catch (e) {
      return send(res, e.status || 502, e.message);
    }
  }

  async function mcp(req, res) {
    if (req.method === 'GET') return send(res, 405, 'POST JSON-RPC here', { allow: 'POST' });
    const body = await readJson(req);
    // Tools need an account on hdtilt.com (a session or an `hdtilt login` token);
    // initialize and tools/list stay open so a client can discover them.
    if (gated && !(await accounts.whoFrom(req.headers.authorization))) {
      const deny = (m) =>
        m?.method === 'tools/call' && m.id != null
          ? {
              jsonrpc: '2.0',
              id: m.id,
              error: { code: -32001, message: 'Sign in first: send Authorization: Bearer <token> (hdtilt login)' },
            }
          : null;
      const msgs = Array.isArray(body) ? body : [body];
      if (msgs.some((m) => m?.method === 'tools/call')) {
        const out = await Promise.all(msgs.map((m) => deny(m) || handleRpc(m, ctx)));
        const kept = out.filter(Boolean);
        return Array.isArray(body) ? send(res, 200, kept) : send(res, 200, kept[0]);
      }
    }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleRpc(m, ctx)))).filter(Boolean);
      return out.length ? send(res, 200, out) : send(res, 202, '');
    }
    const out = await handleRpc(body, ctx);
    return out ? send(res, 200, out) : send(res, 202, '');
  }

  async function staticFile(_req, res, path) {
    const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '');
    let file = join(WEB_DIR, rel);
    if (!file.startsWith(WEB_DIR)) return send(res, 403, 'no');
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    } catch {
      // Unknown paths are app routes: hand back the shell.
      if (extname(rel)) return send(res, 404, 'not found');
      file = join(WEB_DIR, 'index.html');
    }
    try {
      let body = await readFile(file);
      const ext = extname(file);
      if (file === join(WEB_DIR, 'index.html')) body = await withFooter(body.toString('utf8'));
      res.writeHead(200, {
        'content-type': TYPES[ext] || 'application/octet-stream',
        // Content-named files never change; the page and the worker always revalidate.
        'cache-control': /-[a-z0-9]{8,}\.(js|css)$/i.test(file)
          ? 'public, max-age=31536000, immutable'
          : ext === '.html' || file.endsWith('sw.js') || ext === '.webmanifest'
            ? 'no-cache'
            : 'public, max-age=3600',
      });
      res.end(body);
    } catch {
      send(res, 404, 'not found');
    }
  }

  const handler = async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    try {
      if (req.method === 'OPTIONS') {
        return send(res, 204, '', {
          'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
          'access-control-allow-headers': 'content-type, range, authorization, mcp-protocol-version, mcp-session-id',
        });
      }
      const pm = /^\/p\/([A-Za-z0-9_-]+)(?:\/[^/]*)?$/.exec(path);
      // On hdtilt.com the stream proxy is for signed-in viewers only (the
      // media cookie, or a bearer); ffmpeg's own reads come from inside.
      if ((pm || path.startsWith('/hls/')) && gated && !isInternal(req) && !(await mediaAllowed(req)))
        return send(res, 401, 'Sign in to watch');
      if (pm) return await proxy(req, res, pm[1]);
      if (path.startsWith('/hls/')) return await hls(req, res, path);
      if (path === '/mcp') return await mcp(req, res);
      if (
        accounts &&
        (path === '/.well-known/oauth-authorization-server' || path === '/oauth/token' || path === '/oauth/revoke')
      )
        return await oauthEndpoint(req, res, path);
      if (path.startsWith('/api/')) return await api(req, res, path);
      return await staticFile(req, res, path);
    } catch (e) {
      if (!res.headersSent) send(res, 502, { error: String(e.message || e) });
      else res.destroy();
    }
  };
  handler.setPort = (p) => {
    selfPort = p;
  };
  handler.close = () => remux?.close();
  return handler;
}

export function startServer({
  port = Number(process.env.PORT) || 8930,
  host = process.env.HOST || '127.0.0.1',
  ...opts
} = {}) {
  const app = createApp(opts);
  const server = createServer(app);
  server.on('close', () => app.close());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      app.setPort(server.address().port);
      resolve(server);
    });
  });
}
