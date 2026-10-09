// A source is where channels come from: an M3U URL or an Xtream Codes login.
// Both come out as the same channel list, so nothing downstream cares which.

import { parseM3uStream } from '@profullstack/player/m3u';
import { hash } from './util.js';
import * as xtream from './xtream.js';

/**
 * @typedef {{ type: 'm3u', url: string, epg?: string }
 *         | { type: 'xtream', server: string, username: string, password: string, epg?: string }} Source
 *
 * @typedef {object} Channel
 * @property {string} id      stable within its source
 * @property {string} name
 * @property {string} url
 * @property {string} group
 * @property {'live'|'vod'|'series'} kind
 * @property {string} [logo]
 * @property {string} [tvgId]
 * @property {number} [chno]
 * @property {number} [streamId] Xtream only
 * @property {{type:string, days?:number, source?:string}} [catchup]
 */

/** An M3U URL that is really an Xtream line gets the richer API instead. */
export function normaliseSource(src) {
  if (src.type === 'm3u') {
    const login = xtream.loginFromM3uUrl(src.url);
    if (login) return { type: 'xtream', ...login, ...(src.epg ? { epg: src.epg } : {}) };
  }
  return src;
}

export function guideUrlOf(src, listEpgUrl) {
  if (src.epg) return src.epg;
  if (src.type === 'xtream') return xtream.xmltvUrl(src);
  return listEpgUrl || null;
}

async function* bodyOf(res) {
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

/** Channels from an M3U body (a fetch Response or plain text). */
export async function channelsFromM3u(input) {
  const chunks = typeof input === 'string' ? [input] : bodyOf(input);
  const { entries, epgUrl } = await parseM3uStream(chunks, { max: 0 });
  const seen = new Map();
  const channels = entries.map((e) => {
    let id = e.tvgId || `h${hash(`${e.title}|${e.url}`)}`;
    const n = seen.get(id) || 0;
    seen.set(id, n + 1);
    if (n) id = `${id}~${n}`;
    const ch = { id, name: e.title, url: e.url, group: e.group || 'Uncategorized', kind: e.kind };
    if (e.logo) ch.logo = e.logo;
    if (e.tvgId) ch.tvgId = e.tvgId;
    if (e.chno != null) ch.chno = e.chno;
    if (e.catchup) ch.catchup = e.catchup;
    return ch;
  });
  return { channels, epgUrl: epgUrl || null };
}

/**
 * Load a source's live channels.
 * @param {Source} source
 * @param {{ fetch?: typeof fetch }} [opts]
 * @returns {Promise<{ channels: Channel[], epgUrl: string|null, account?: object }>}
 */
export async function loadSource(source, { fetch: fetchImpl = fetch } = {}) {
  const src = normaliseSource(source);
  if (src.type === 'xtream') {
    const acct = await xtream.account(src, fetchImpl);
    const ext = acct.formats.includes('ts') || !acct.formats.length ? 'ts' : 'm3u8';
    const channels = await xtream.liveChannels(src, { fetchImpl, ext });
    return { channels, epgUrl: guideUrlOf(src), account: acct };
  }
  const res = await fetchImpl(src.url, { headers: { 'user-agent': 'hdtilt' } });
  if (!res.ok) throw new Error(`playlist answered ${res.status}`);
  const { channels, epgUrl } = await channelsFromM3u(res);
  if (!channels.length) throw new Error('no channels found in that playlist');
  return { channels, epgUrl: guideUrlOf(src, epgUrl) };
}

/** Groups in first-seen order with their channel counts. */
export function groupsOf(channels) {
  const m = new Map();
  for (const c of channels) m.set(c.group, (m.get(c.group) || 0) + 1);
  return [...m].map(([name, count]) => ({ name, count }));
}

/**
 * Catch-up URL for a past programme, or null when the channel has no archive.
 * Supports Xtream timeshift and the M3U `catchup-source` template forms.
 */
export function catchupUrl(channel, source, startMs, stopMs, timeZone) {
  const c = channel.catchup;
  if (!c) return null;
  const src = normaliseSource(source);
  if (src.type === 'xtream' && channel.streamId) {
    return xtream.timeshiftUrl(src, channel.streamId, startMs, (stopMs - startMs) / 60000, timeZone);
  }
  const s = Math.floor(startMs / 1000);
  const e = Math.floor(stopMs / 1000);
  const fill = (tpl) =>
    tpl
      .replace(/\{utc\}|\$\{start\}/g, String(s))
      .replace(/\{utcend\}|\$\{end\}/g, String(e))
      .replace(/\{lutc\}|\$\{now\}|\{now\}/g, String(Math.floor(Date.now() / 1000)))
      .replace(/\{duration\}|\$\{duration\}/g, String(e - s))
      .replace(/\{offset\}|\$\{offset\}/g, String(Math.floor(Date.now() / 1000) - s));
  if (c.source) {
    const t = fill(c.source);
    if (/^https?:\/\//i.test(t)) return t;
    return channel.url + (t.startsWith('?') && channel.url.includes('?') ? `&${t.slice(1)}` : t);
  }
  if (c.type === 'shift' || c.type === 'default' || c.type === 'append') {
    return `${channel.url}${channel.url.includes('?') ? '&' : '?'}utc=${s}&lutc=${Math.floor(Date.now() / 1000)}`;
  }
  if (c.type === 'flussonic' || c.type === 'fs') {
    return channel.url.replace(/[^/]+\.(m3u8|ts)(\?.*)?$/, `archive-${s}-${e - s}.$1`);
  }
  return null;
}

/** What the player should treat a URL as. Extensionless live URLs are MPEG-TS. */
export function streamKind(url, kind = 'live') {
  const p = (() => {
    try {
      return new URL(url, 'http://x').pathname.toLowerCase();
    } catch {
      return String(url).toLowerCase();
    }
  })();
  if (p.endsWith('.m3u8') || p.endsWith('.m3u')) return 'hls';
  if (/\.(mp4|m4v|webm|mov|mkv)$/.test(p)) return 'mp4';
  if (p.endsWith('.ts') || p.endsWith('.m2ts')) return 'mpegts';
  return kind === 'live' ? 'mpegts' : 'mp4';
}
