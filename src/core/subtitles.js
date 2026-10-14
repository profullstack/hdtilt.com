// Subtitles for films and episodes, from OpenSubtitles (api.opensubtitles.com).
//
// Searching is free; downloading is the scarce thing. A free API key gets 5
// downloads a day per IP without a login, and a signed-in account its own
// daily allowance (20 on a free one), so every file is kept on disk by its
// file id once fetched: the second viewer of a film costs nothing.
//
// A provider names a film "EN - The Matrix (1999) 4K"; cleanTitle() turns that
// into what OpenSubtitles knows it as. When the panel knows the TMDB id, that
// is sent instead (precise), and a moviehash of the file itself, when the
// provider answers range requests, puts subtitles made for that exact rip first.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../version.js';

const API = 'https://api.opensubtitles.com/api/v1';
const SEARCH_TTL = 3600_000;
const TOKEN_TTL = 23 * 3600_000; // tokens last 24 h
const HASH_CHUNK = 65536;
const MAX_VTT = 2 << 20;

/** Where the key and the optional account come from: env first, then the config's `opensubtitles`. */
export function credentialsFrom(env = process.env, cfg = {}) {
  const c = cfg?.opensubtitles || {};
  return {
    apiKey: env.OPENSUBTITLES_API_KEY || c.apiKey || '',
    username: env.OPENSUBTITLES_USERNAME || c.username || '',
    password: env.OPENSUBTITLES_PASSWORD || c.password || '',
  };
}

// Quality, source and language tags providers put around a title.
const NOISE =
  /\b(4k|uhd|fhd|hd|sd|hevc|h\.?26[45]|x26[45]|1080p|2160p|720p|480p|hdr10?\+?|hdr|dv|dolby ?vision|web-?dl|web-?rip|webrip|blu-?ray|bdrip|brrip|dvdrip|hdtv|remux|multi|dual|vost(fr)?|subbed|dubbed|sub|dub|imax|extended|unrated|remastered|directors? cut)\b/gi;

/**
 * "EN - The Matrix (1999) 4K" -> { title: "The Matrix", year: 1999 }.
 * Also "|EN| Title", "[4K] Title", "NF - Title", "Title [1999]".
 */
export function cleanTitle(raw) {
  let t = String(raw || '').trim();
  let year = 0;
  // Leading tags: |EN|, [4K], (EN), and "EN - " / "4K-NF: " style prefixes, repeatedly.
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t
      .replace(/^\s*[|[(][^|\])]{1,12}[|\])]\s*[-–:|]?\s*/, '')
      .replace(/^\s*[A-Z0-9][A-Z0-9+]{0,5}(?:[-_ ][A-Z0-9+]{1,5})?\s*[-–:|]\s+/, '');
    if (t === before) break;
  }
  const y = /[([]\s*((?:19|20)\d{2})\s*[)\]]|\b((?:19|20)\d{2})\s*$/.exec(t);
  if (y) {
    year = Number(y[1] || y[2]);
    t = t.slice(0, y.index) + t.slice(y.index + y[0].length);
  }
  t = t
    .replace(/[([][^)\]]*[)\]]/g, ' ')
    .replace(NOISE, ' ')
    .replace(/\s*[-–|:]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { title: t || String(raw || '').trim(), year };
}

/**
 * The query string OpenSubtitles wants: keys sorted, values lowercase, no
 * empty or default values (anything else is a 301 to the same thing).
 */
export function searchParams(ask = {}) {
  const p = {};
  const set = (k, v) => {
    if (v === undefined || v === null || v === '' || v === 0) return;
    p[k] = String(v).toLowerCase();
  };
  const langs = String(ask.languages || 'en')
    .split(/[,\s]+/)
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  set('languages', [...new Set(langs)].join(','));
  set('moviehash', ask.moviehash);
  const episode = ask.season != null && ask.episode != null;
  if (episode) {
    set('season_number', Number(ask.season));
    set('episode_number', Number(ask.episode));
  }
  if (ask.tmdbId) set(episode ? 'parent_tmdb_id' : 'tmdb_id', String(ask.tmdbId).replace(/^0+/, ''));
  else if (ask.imdbId) set(episode ? 'parent_imdb_id' : 'imdb_id', String(ask.imdbId).replace(/^tt0*/i, ''));
  else {
    const { title, year } = cleanTitle(ask.title);
    set('query', title);
    // A year only narrows a film: an episode's year is not its show's.
    if (!episode) set('year', ask.year || year);
  }
  set('type', episode ? 'episode' : ask.title || ask.tmdbId || ask.imdbId ? 'movie' : '');
  return new URLSearchParams(
    Object.keys(p)
      .sort()
      .map((k) => [k, p[k]]),
  ).toString();
}

/** One search result, in the terms the player shows. Best first is the caller's sort. */
export function resultOf(d) {
  const a = d?.attributes || {};
  const f = a.files?.[0] || {};
  const fd = a.feature_details || {};
  return {
    fileId: Number(f.file_id) || 0,
    language: a.language || '',
    release: a.release || f.file_name || '',
    fileName: f.file_name || '',
    downloads: Number(a.download_count) || 0,
    hearingImpaired: Boolean(a.hearing_impaired),
    trusted: Boolean(a.from_trusted),
    aiTranslated: Boolean(a.ai_translated),
    hashMatch: Boolean(a.moviehash_match),
    fps: Number(a.fps) || undefined,
    cds: Number(a.nb_cd) || 1,
    title: fd.parent_title ? `${fd.parent_title} S${fd.season_number}E${fd.episode_number}` : fd.title || fd.movie_name,
    year: fd.year || undefined,
  };
}

/** Exact-file matches first, then one-file subtitles, then the most downloaded. */
export function rankResults(list) {
  return list
    .filter((r) => r.fileId)
    .sort(
      (a, b) =>
        b.hashMatch - a.hashMatch ||
        (a.cds > 1) - (b.cds > 1) ||
        b.trusted - a.trusted ||
        a.aiTranslated - b.aiTranslated ||
        b.downloads - a.downloads,
    );
}

/** SubRip (or anything close) to WebVTT, which is what a <track> plays. */
export function toVtt(text) {
  let t = String(text || '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n');
  if (/^WEBVTT/.test(t)) return t;
  t = t
    // 00:01:02,345 --> 00:01:04,000  (also a single-digit hour, and a dot)
    .replace(
      /(\d{1,2}:\d{2}:\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2})[,.](\d{1,3})/g,
      (_, a, ams, b, bms) =>
        `${a.padStart(8, '0')}.${ams.padEnd(3, '0')} --> ${b.padStart(8, '0')}.${bms.padEnd(3, '0')}`,
    )
    // SRT's {\an8} positioning and <font> tags mean nothing to VTT.
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<\/?font[^>]*>/gi, '');
  return `WEBVTT\n\n${t.trim()}\n`;
}

/** Every cue moved by `seconds` (negative = earlier); cues that end before 0 are dropped. */
export function shiftVtt(vtt, seconds) {
  if (!seconds) return vtt;
  const toS = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  const fmt = (x) => {
    const ms = Math.round(Math.max(0, x) * 1000);
    const h = Math.floor(ms / 3600_000);
    const m = Math.floor((ms % 3600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    const r = (n, w = 2) => String(n).padStart(w, '0');
    return `${r(h)}:${r(m)}:${r(s)}.${r(ms % 1000, 3)}`;
  };
  const time = /(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/;
  const [head, ...blocks] = String(vtt).split(/\n\n+/);
  const kept = [];
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) {
      kept.push(b);
      continue;
    }
    const [l, r] = lines[i].split('-->');
    const a = time.exec(l);
    const z = time.exec(r);
    if (!a || !z) continue;
    const start = toS(a[1] || 0, a[2], a[3], a[4]) + seconds;
    const end = toS(z[1] || 0, z[2], z[3], z[4]) + seconds;
    if (end <= 0) continue;
    const settings = r.replace(time, '').trim();
    lines[i] = `${fmt(start)} --> ${fmt(end)}${settings ? ` ${settings}` : ''}`;
    kept.push(lines.join('\n'));
  }
  return `${[head, ...kept].join('\n\n')}\n`;
}

/**
 * OpenSubtitles' moviehash: the file size plus the 64-bit little-endian words
 * of its first and last 64 KiB, mod 2^64, as 16 hex digits.
 */
export function moviehashOf(size, head, tail) {
  const mask = (1n << 64n) - 1n;
  let h = BigInt(size);
  for (const buf of [head, tail]) {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let i = 0; i + 8 <= buf.byteLength; i += 8) h = (h + v.getBigUint64(i, true)) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

/** A file's moviehash by two range requests, or null if the provider will not say. */
export async function moviehash(url, fetchImpl = fetch, timeoutMs = 8000) {
  const signal = AbortSignal.timeout(timeoutMs);
  const range = async (spec) => {
    const res = await fetchImpl(url, { headers: { range: `bytes=${spec}` }, signal });
    if (res.status !== 206) {
      res.body?.cancel?.().catch(() => {});
      return null;
    }
    const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') || '')?.[1]);
    return { total, buf: new Uint8Array(await res.arrayBuffer()) };
  };
  try {
    const head = await range(`0-${HASH_CHUNK - 1}`);
    if (!head?.total || head.total < HASH_CHUNK * 2 || head.buf.byteLength !== HASH_CHUNK) return null;
    const tail = await range(`${head.total - HASH_CHUNK}-${head.total - 1}`);
    if (!tail || tail.buf.byteLength !== HASH_CHUNK) return null;
    return moviehashOf(head.total, head.buf, tail.buf);
  } catch {
    return null;
  }
}

const quotaError = (msg, status = 429) => Object.assign(new Error(msg), { status, code: 'quota' });

/**
 * @param {{ apiKey?: string, username?: string, password?: string, fetch?: typeof fetch,
 *   cacheDir?: string, appName?: string }} opts
 */
export function createSubtitles({
  apiKey = '',
  username = '',
  password = '',
  fetch: fetchImpl = fetch,
  cacheDir,
  appName = 'hdtilt',
} = {}) {
  const dir = cacheDir || join(process.env.HDTILT_CACHE || tmpdir(), 'hdtilt-subs');
  const searches = new Map(); // query -> { at, p }
  let login = null; // { at, p: Promise<{ token, base }> }
  let loginFailed = false; // a 401 is final: OpenSubtitles asks clients to stop retrying

  const headers = (extra = {}) => ({
    'api-key': apiKey,
    'user-agent': `${appName} v${VERSION}`,
    accept: 'application/json',
    ...extra,
  });

  async function session() {
    if (!username || !password || loginFailed) return null;
    if (login && Date.now() - login.at < TOKEN_TTL) return login.p;
    const p = (async () => {
      const res = await fetchImpl(`${API}/login`, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ username, password }),
      });
      if (res.status === 401) {
        loginFailed = true;
        throw new Error('OpenSubtitles refused the username or password');
      }
      if (!res.ok) throw new Error(`OpenSubtitles login answered ${res.status}`);
      const j = await res.json();
      return { token: j.token, base: j.base_url ? `https://${j.base_url}/api/v1` : API };
    })();
    login = { at: Date.now(), p };
    p.catch(() => {
      login = null;
    });
    return p;
  }

  async function call(path, init = {}) {
    if (!apiKey) throw Object.assign(new Error('subtitles are not set up on this server'), { status: 501 });
    const s = await session().catch(() => null);
    const auth = s?.token ? { authorization: `Bearer ${s.token}` } : {};
    const res = await fetchImpl(`${s?.base || API}${path}`, {
      ...init,
      headers: headers({ ...auth, ...(init.body ? { 'content-type': 'application/json' } : {}) }),
      redirect: 'follow',
    });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401 && s) login = null; // token expired early: next call logs in again
    if (res.status === 406 || (res.status === 429 && path === '/download'))
      throw quotaError(
        `Today's subtitle downloads are used up${j.reset_time ? `; more in ${j.reset_time}` : ''}. Ones already fetched still work.`,
      );
    if (res.status === 429) throw quotaError('OpenSubtitles is busy; try again in a moment', 503);
    if (!res.ok)
      throw Object.assign(new Error(j.message || j.errors?.[0] || `OpenSubtitles answered ${res.status}`), {
        status: 502,
      });
    return j;
  }

  /**
   * @param {{ title?: string, year?: number, tmdbId?: number|string, imdbId?: string,
   *   season?: number, episode?: number, languages?: string, moviehash?: string }} ask
   */
  function search(ask) {
    const qs = searchParams(ask);
    const have = searches.get(qs);
    if (have && Date.now() - have.at < SEARCH_TTL) return have.p;
    const p = call(`/subtitles?${qs}`).then((j) => rankResults((j.data || []).map(resultOf)));
    searches.set(qs, { at: Date.now(), p });
    p.catch(() => searches.delete(qs));
    while (searches.size > 500) searches.delete(searches.keys().next().value);
    return p;
  }

  const fileOf = (fileId) => join(dir, `${Number(fileId)}.vtt`);

  async function cached(fileId) {
    try {
      return await readFile(fileOf(fileId), 'utf8');
    } catch {
      return null;
    }
  }

  // Two viewers asking for the same new file spend one download.
  const inflight = new Map();
  /** A subtitle file as WebVTT. `fresh` is true when it spent a download. */
  async function download(fileId, { onFresh } = {}) {
    fileId = Number(fileId);
    if (!Number.isInteger(fileId) || fileId <= 0) throw Object.assign(new Error('bad subtitle id'), { status: 400 });
    const hit = await cached(fileId);
    if (hit) return { vtt: hit, fresh: false };
    if (inflight.has(fileId)) return inflight.get(fileId);
    const p = (async () => {
      onFresh?.();
      const j = await call('/download', { method: 'POST', body: JSON.stringify({ file_id: fileId }) });
      if (!j.link) throw Object.assign(new Error(j.message || 'no download link'), { status: 502 });
      const res = await fetchImpl(j.link, { headers: { 'user-agent': `${appName} v${VERSION}` } });
      if (!res.ok) throw Object.assign(new Error(`subtitle file answered ${res.status}`), { status: 502 });
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_VTT) throw Object.assign(new Error('subtitle file is too large'), { status: 502 });
      const vtt = toVtt(new TextDecoder('utf-8').decode(buf));
      await mkdir(dir, { recursive: true });
      const tmp = `${fileOf(fileId)}.${process.pid}.tmp`;
      await writeFile(tmp, vtt);
      await rename(tmp, fileOf(fileId));
      return { vtt, fresh: true, remaining: j.remaining };
    })();
    inflight.set(fileId, p);
    p.finally(() => inflight.delete(fileId)).catch(() => {});
    return p;
  }

  return { enabled: Boolean(apiKey), search, download, cached, hasCached: async (id) => Boolean(await cached(id)) };
}
