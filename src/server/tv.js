// The TV side of hdtilt: what the Roku app (roku/) talks to.
//
// 1. Device sign-in (RFC 8628 shape). A TV has no browser to redirect, so it
//    asks for a short code, shows "go to hdtilt.com/link and enter ABCD-EFGH",
//    and polls /oauth/token until someone signed in on a phone approves it.
//    Underneath it is the same OAuth 2.1 server the CLI uses: approving mints
//    an authorization code (PKCE, our own verifier) that the poll exchanges,
//    so the TV ends up with ordinary ht_at_/ht_rt_ tokens.
//
// 2. Paged data. /api/load hands the browser the whole playlist (53k channels
//    on a big line is tens of MB of JSON); a Roku would run out of memory
//    parsing it. /api/tv/* keeps the loaded playlist here for a few minutes
//    and hands out groups and pages, each channel with a URL a Roku plays.

import { createHash, randomBytes } from 'node:crypto';
import { filterByWords } from '../core/match.js';
import { groupsOf, loadSource, normaliseSource, streamKind } from '../core/sources.js';
import { b64urlEncode } from '../core/util.js';
import { browseVod } from '../core/vod.js';

export const TV_CLIENT_ID = 'hdtilt-tv';
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const CODE_TTL_MS = 10 * 60_000;
const POLL_S = 5;
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels: no words, no 0/O 1/I

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const userCode = () => {
  const bytes = randomBytes(8);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
};
/** What a person typed, as we store it: upper case, letters only, dash in the middle. */
export const normaliseUserCode = (raw) => {
  const s = String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : null;
};

class DeviceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Pending device sign-ins, in memory: they live ten minutes, and a restart
 * only means the TV asks for a new code.
 */
export function createDeviceFlow({ oauth, site, now = Date.now }) {
  const byDevice = new Map();
  const byUser = new Map();
  const redirectUri = `${site}/oauth/device`;

  const sweep = () => {
    const t = now();
    for (const [k, d] of byDevice) {
      if (d.expires < t) {
        byDevice.delete(k);
        byUser.delete(d.userCode);
      }
    }
  };

  return {
    redirectUri,
    /** POST /oauth/device_authorization */
    start({ client_id } = {}) {
      if (client_id !== TV_CLIENT_ID) throw new DeviceError('invalid_client', 'unknown client_id', 401);
      sweep();
      if (byDevice.size > 5000) throw new DeviceError('slow_down', 'too many pending sign-ins', 429);
      const deviceCode = b64url(randomBytes(32));
      let code = userCode();
      while (byUser.has(code)) code = userCode();
      const verifier = b64url(randomBytes(32));
      const d = {
        deviceCode,
        userCode: code,
        verifier,
        challenge: b64url(createHash('sha256').update(verifier).digest()),
        expires: now() + CODE_TTL_MS,
        status: 'pending',
        code: null,
        lastPoll: 0,
      };
      byDevice.set(deviceCode, d);
      byUser.set(code, d);
      return {
        device_code: deviceCode,
        user_code: code,
        verification_uri: `${site}/link`,
        verification_uri_complete: `${site}/link?code=${code}`,
        expires_in: CODE_TTL_MS / 1000,
        interval: POLL_S,
      };
    },
    /** What /link shows before the person says yes. */
    lookup(raw) {
      sweep();
      const code = normaliseUserCode(raw);
      const d = code && byUser.get(code);
      if (!d || d.status !== 'pending')
        throw new DeviceError(
          'invalid_code',
          'That code is not right, or it expired. Check the TV for a new one.',
          404,
        );
      return { userCode: d.userCode, clientName: 'hdtilt on your TV' };
    },
    /** A signed-in person approves (or denies) the code on /link. */
    async decide(userId, raw, decision) {
      const { userCode: code } = this.lookup(raw);
      const d = byUser.get(code);
      if (decision !== 'approve') {
        d.status = 'denied';
        return { ok: true, denied: true };
      }
      const url = await oauth.approve({
        userId,
        clientId: TV_CLIENT_ID,
        redirectUri,
        codeChallenge: d.challenge,
        scope: 'read write',
        state: 'tv',
      });
      d.code = new URL(url).searchParams.get('code');
      if (!d.code) throw new DeviceError('server_error', 'could not approve that code', 500);
      d.status = 'approved';
      byUser.delete(code); // one approval per code
      return { ok: true };
    },
    /** The TV's poll: grant_type=urn:ietf:params:oauth:grant-type:device_code */
    async poll({ device_code, client_id }) {
      if (client_id !== TV_CLIENT_ID) throw new DeviceError('invalid_client', 'unknown client_id', 401);
      const d = byDevice.get(String(device_code || ''));
      if (!d || d.expires < now()) throw new DeviceError('expired_token', 'that code expired; ask for a new one');
      const t = now();
      const early = t - d.lastPoll < (POLL_S - 1) * 1000;
      d.lastPoll = t;
      if (d.status === 'denied') {
        byDevice.delete(d.deviceCode);
        throw new DeviceError('access_denied', 'the sign-in was refused');
      }
      if (d.status !== 'approved')
        throw new DeviceError(early ? 'slow_down' : 'authorization_pending', 'waiting for approval');
      byDevice.delete(d.deviceCode);
      return oauth.token({
        grant_type: 'authorization_code',
        code: d.code,
        client_id: TV_CLIENT_ID,
        redirect_uri: redirectUri,
        code_verifier: d.verifier,
      });
    },
    _pending: () => byDevice.size,
  };
}

/* ------------------------------------------------------------------ data */

const VOD_DIRECT = new Set(['mp4', 'm4v', 'mov', 'mkv']);
const extOf = (url) => {
  try {
    return (/\.([a-z0-9]{2,4})$/i.exec(new URL(url).pathname)?.[1] || '').toLowerCase();
  } catch {
    return '';
  }
};

/**
 * The URL a Roku plays, and its StreamFormat. A Roku has no CORS and no
 * mixed-content rule, so anything it decodes goes direct to the provider;
 * raw transport streams (which it does not play) come through our HLS remux.
 */
export function rokuPlay(url, { kind = 'live', m3u8 = false, remux = true } = {}) {
  const k = streamKind(url, kind);
  const via = (vod) => `/hls/${b64urlEncode(url)}/index.m3u8${vod ? '?vod=1' : ''}`;
  // A direct play the Roku turns out not to decode retries through the remux.
  const direct = (u, format, vod) => (remux ? { url: u, format, fallback: via(vod) } : { url: u, format });
  if (k === 'hls') return { url, format: 'hls' };
  if (kind === 'vod' || k === 'mp4') {
    const ext = extOf(url);
    if (VOD_DIRECT.has(ext)) return direct(url, ext === 'm4v' || ext === 'mov' ? 'mp4' : ext, true);
    if (remux) return { url: via(true), format: 'hls', media: true };
    return { url, format: ext || 'mp4' };
  }
  // An Xtream line that allows HLS: ask for .m3u8 instead of .ts.
  if (m3u8 && /\/live\/[^?]+\.ts$/i.test(url)) return direct(url.replace(/\.ts$/i, '.m3u8'), 'hls', false);
  if (remux) return { url: via(false), format: 'hls', media: true };
  return { url, format: 'ts' };
}

const slimChannel = (c, ctx) => {
  const o = { id: c.id, name: c.name, group: c.group, play: rokuPlay(c.url, ctx) };
  if (c.logo) o.logo = c.logo;
  if (c.chno != null) o.chno = c.chno;
  return o;
};

const page = (list, offset, limit) => {
  const o = Math.max(0, Number(offset) || 0);
  const l = Math.min(200, Math.max(1, Number(limit) || 50));
  return { items: list.slice(o, o + l), total: list.length, offset: o };
};

/**
 * Loaded playlists, kept a few minutes so paging does not reload the
 * provider. Keyed by user and source; a handful at most (a big line is
 * ~100 MB resident while it is held).
 */
export function createTvData({ fetch, remux = true, ttlMs = 10 * 60_000, max = 4, now = Date.now }) {
  const cache = new Map();
  const keyOf = (userId, source) =>
    `${userId}:${createHash('sha256')
      .update(JSON.stringify(normaliseSource(source)))
      .digest('base64url')}`;

  async function loaded(userId, source) {
    const key = keyOf(userId, source);
    const hit = cache.get(key);
    if (hit && hit.expires > now()) {
      cache.delete(key);
      cache.set(key, hit); // most recent last
      return hit.value;
    }
    const value = loadSource(source, { fetch }).then((data) => {
      const byId = new Map(data.channels.map((c) => [c.id, c]));
      const m3u8 = Boolean(data.account?.formats?.includes('m3u8'));
      return { ...data, byId, groups: groupsOf(data.channels), ctx: { kind: 'live', m3u8, remux } };
    });
    cache.set(key, { value, expires: now() + ttlMs });
    value.catch(() => cache.delete(key));
    while (cache.size > max) cache.delete(cache.keys().next().value);
    return value;
  }

  return {
    async load(userId, { source }) {
      if (!source?.type) throw Object.assign(new Error('source required'), { status: 400 });
      const d = await loaded(userId, source);
      return {
        groups: d.groups,
        total: d.channels.length,
        epgUrl: d.epgUrl,
        vod: normaliseSource(source).type === 'xtream',
      };
    },
    async channels(userId, { source, group, ids, q, offset, limit }) {
      if (!source?.type) throw Object.assign(new Error('source required'), { status: 400 });
      const d = await loaded(userId, source);
      let list;
      if (Array.isArray(ids)) list = ids.map((id) => d.byId.get(String(id))).filter(Boolean);
      else if (group) list = d.channels.filter((c) => c.group === group);
      else list = d.channels;
      if (q && String(q).trim()) list = filterByWords(list, String(q));
      const p = page(list, offset, limit);
      return { ...p, items: p.items.map((c) => slimChannel(c, d.ctx)) };
    },
    async vod(_userId, { source, kind, category, q, seriesId, offset, limit }) {
      if (!source?.type) throw Object.assign(new Error('source required'), { status: 400 });
      const r = await browseVod(source, { kind, category, q, seriesId }, { fetch });
      const ctx = { kind: 'vod', remux };
      if (r.show) {
        return {
          show: {
            ...r.show,
            episodes: r.show.episodes.map((e) => ({ ...e, play: rokuPlay(e.url, ctx), url: undefined })),
          },
        };
      }
      if (r.items) {
        const p = page(r.items, offset, limit);
        return {
          ...p,
          items: p.items.map((i) => {
            const o = {
              id: i.id,
              name: i.name,
              logo: i.logo,
              year: i.year,
              rating: i.rating,
              plot: i.plot,
              kind: i.kind,
            };
            if (i.seriesId != null) o.seriesId = i.seriesId;
            if (i.url) o.play = rokuPlay(i.url, ctx);
            return o;
          }),
        };
      }
      return r;
    },
    _cache: cache,
  };
}
