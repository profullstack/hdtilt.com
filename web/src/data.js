// Talking to the hdtilt server, and deciding how a stream reaches the player.

import { streamKind } from '../../src/core/sources.js';
import { proxyPath } from '../../src/core/util.js';

export let serverInfo = { public: true, version: '' };

async function json(path, body) {
  const res = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `server answered ${res.status}`);
  return data;
}

export async function health() {
  try {
    serverInfo = await json('/api/health');
  } catch {}
  return serverInfo;
}

/** Channels for a source. A 'saved' source is one the local install's CLI already has. */
export function load(source) {
  if (source.type === 'saved') return json(`/api/playlists/${encodeURIComponent(source.name)}`);
  return json('/api/load', { source });
}

/** Playlists saved by `hdtilt add` on this machine (desktop and self-hosted only). */
export async function savedPlaylists() {
  if (serverInfo.public) return [];
  try {
    return await json('/api/playlists');
  } catch {
    return [];
  }
}

export function guide(url, channels, from, to) {
  const slim = channels.map((c) => ({ id: c.id, name: c.name, tvgId: c.tvgId }));
  return json('/api/guide', { url, channels: slim, from, to }).then((r) => r.programmes);
}

/**
 * The URL the player should open, and the engine kind.
 *
 * An http:// stream on an https page is blocked as mixed content, and no CSP
 * loosening lets it back in, so those go through the proxy. So do transport
 * streams, and anything that already failed directly (CORS, usually).
 */
export function playable(url, { viaProxy = false, kind = 'live' } = {}) {
  const k = streamKind(url, kind);
  const mixed = location.protocol === 'https:' && url.startsWith('http:');
  // Provider transport streams almost never send CORS headers, and mpegts.js
  // reads them with fetch, so they always go through the proxy.
  if (viaProxy || mixed || k === 'mpegts') return { src: proxyPath(url, k), kind: k, proxied: true };
  return { src: url, kind: k, proxied: false };
}
