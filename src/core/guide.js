// Guides, fetched once and kept. Server and CLI side: a browser asks the API.

import { between, matchChannels, nowNext } from './epg.js';
import { gunzipIfNeeded, parseXmltv } from './xmltv.js';

const TTL_MS = 6 * 60 * 60 * 1000;
const PAST_MS = 2 * 24 * 60 * 60 * 1000; // catch-up reaches back
const AHEAD_MS = 4 * 24 * 60 * 60 * 1000;
const MAX_GUIDES = 8;

const cache = new Map(); // url -> { at, promise }

async function* bodyOf(res) {
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

/**
 * The parsed guide for a URL, from cache when it is fresh.
 * @param {string} url
 * @param {{ fetch?: Function, force?: boolean }} [opts]
 */
export function loadGuide(url, { fetch: fetchImpl = fetch, force = false } = {}) {
  const hit = cache.get(url);
  if (hit && !force && Date.now() - hit.at < TTL_MS) return hit.promise;
  const now = Date.now();
  const promise = (async () => {
    const res = await fetchImpl(url, { headers: { 'user-agent': 'hdtilt' } });
    if (!res.ok) throw new Error(`guide answered ${res.status}`);
    const g = await parseXmltv(gunzipIfNeeded(bodyOf(res)), {
      from: now - PAST_MS,
      to: now + AHEAD_MS,
    });
    return { ...g, url, fetchedAt: now };
  })();
  cache.set(url, { at: now, promise });
  promise.catch(() => cache.delete(url));
  while (cache.size > MAX_GUIDES) cache.delete(cache.keys().next().value);
  return promise;
}

/**
 * Programmes for a set of channels, keyed by OUR channel id.
 * @param {object} guide from loadGuide
 * @param {{id:string,name:string,tvgId?:string}[]} channels
 */
export function guideFor(guide, channels, { from = Date.now() - 3 * 3600_000, to = Date.now() + 24 * 3600_000 } = {}) {
  const map = matchChannels(channels, guide.channels);
  const out = {};
  for (const c of channels) {
    const gid = map.get(c.id);
    if (!gid) continue;
    const list = between(guide.programmes.get(gid), from, to);
    if (list.length) out[c.id] = list;
  }
  return out;
}

export function nowNextFor(guide, channels, t = Date.now()) {
  const map = matchChannels(channels, guide.channels);
  const out = {};
  for (const c of channels) {
    const gid = map.get(c.id);
    if (gid) out[c.id] = nowNext(guide.programmes.get(gid), t);
  }
  return out;
}
