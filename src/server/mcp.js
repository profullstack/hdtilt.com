// MCP over JSON-RPC: one handler, served on stdio (`hdtilt mcp`) and HTTP (POST /mcp).

import { addPlaylist, channelsFor, findChannels, readConfig } from '../core/config.js';
import { guideFor, loadGuide, nowNextFor } from '../core/guide.js';
import { catchupUrl, groupsOf, loadSource } from '../core/sources.js';
import { VERSION } from '../version.js';

const PROTOCOL = '2025-06-18';

const playlistArg = { type: 'string', description: 'Saved playlist name; defaults to the current one' };
const sourceArg = {
  type: 'object',
  description:
    'Use this playlist instead of a saved one: {type:"m3u", url} or {type:"xtream", server, username, password}; optional epg',
};

export const TOOLS = [
  {
    name: 'list_playlists',
    description: 'Saved IPTV playlists (names and kinds; never passwords).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_playlist',
    description: 'Save an M3U URL or an Xtream Codes login as a named playlist.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        url: { type: 'string', description: 'M3U/M3U8 playlist URL' },
        server: { type: 'string', description: 'Xtream server, e.g. http://host:8080' },
        username: { type: 'string' },
        password: { type: 'string' },
        epg: { type: 'string', description: 'XMLTV guide URL (optional)' },
      },
    },
  },
  {
    name: 'list_groups',
    description: 'Channel groups (categories) with counts.',
    inputSchema: { type: 'object', properties: { source: sourceArg, playlist: playlistArg } },
  },
  {
    name: 'list_channels',
    description: 'Channels, optionally filtered by group or a search (name or number).',
    inputSchema: {
      type: 'object',
      properties: {
        source: sourceArg,
        playlist: playlistArg,
        group: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number', default: 50 },
      },
    },
  },
  {
    name: 'whats_on',
    description: 'What is on now and next, from the guide, for matching channels.',
    inputSchema: {
      type: 'object',
      properties: {
        source: sourceArg,
        playlist: playlistArg,
        query: { type: 'string' },
        group: { type: 'string' },
        limit: { type: 'number', default: 25 },
      },
    },
  },
  {
    name: 'channel_guide',
    description: "One channel's programmes for the next N hours (negative start for catch-up).",
    inputSchema: {
      type: 'object',
      required: ['channel'],
      properties: {
        source: sourceArg,
        playlist: playlistArg,
        channel: { type: 'string' },
        hours: { type: 'number', default: 12 },
        fromHours: { type: 'number', default: 0 },
      },
    },
  },
  {
    name: 'stream_url',
    description: 'The playable URL for a channel, or for a past programme when the channel has catch-up.',
    inputSchema: {
      type: 'object',
      required: ['channel'],
      properties: {
        source: sourceArg,
        playlist: playlistArg,
        channel: { type: 'string' },
        at: { type: 'string', description: 'ISO time inside a past programme, for catch-up' },
      },
    },
  },
];

const fmt = (t) => new Date(t).toISOString().replace(/:\d\d\.\d{3}Z$/, 'Z');
const brief = (c) => ({
  id: c.id,
  name: c.name,
  group: c.group,
  ...(c.chno != null ? { number: c.chno } : {}),
  ...(c.catchup ? { catchup: true } : {}),
});
const prog = (p) =>
  p && { title: p.title, start: fmt(p.start), stop: fmt(p.stop), ...(p.desc ? { desc: p.desc } : {}) };

// On a public server there is no saved config to read: every call names its
// own source, which is loaded and kept briefly in memory.
const loaded = new Map();
async function playlistOf(a, ctx) {
  if (a.source) {
    const key = JSON.stringify(a.source);
    const hit = loaded.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
    const data = { source: a.source, ...(await loadSource(a.source, { fetch: ctx.fetch })) };
    loaded.set(key, { at: Date.now(), data });
    while (loaded.size > 32) loaded.delete(loaded.keys().next().value);
    return data;
  }
  if (ctx.public) throw new Error('this server keeps no playlists; pass source');
  return channelsFor(a.playlist);
}

async function pickOne(a, ctx, q) {
  const pl = await playlistOf(a, ctx);
  const hits = findChannels(pl.channels, q);
  if (!hits.length) throw new Error(`no channel matches "${q}"`);
  return { pl, ch: hits[0] };
}

export async function callTool(name, a = {}, ctx = {}) {
  const guide = (url) => loadGuide(url, { fetch: ctx.fetch });
  switch (name) {
    case 'list_playlists': {
      if (ctx.public) return [];
      const cfg = await readConfig();
      return Object.entries(cfg.playlists).map(([n, s]) => ({ name: n, type: s.type, current: n === cfg.current }));
    }
    case 'add_playlist': {
      if (ctx.public) throw new Error('this server keeps no playlists; run hdtilt locally to save one');
      const src = a.url
        ? { type: 'm3u', url: a.url }
        : a.server && a.username && a.password
          ? { type: 'xtream', server: a.server, username: a.username, password: a.password }
          : null;
      if (!src) throw new Error('give url, or server + username + password');
      if (a.epg) src.epg = a.epg;
      await addPlaylist(a.name, src);
      const pl = await channelsFor(a.name, { refresh: true });
      return { saved: a.name, channels: pl.channels.length, groups: groupsOf(pl.channels).length };
    }
    case 'list_groups':
      return groupsOf((await playlistOf(a, ctx)).channels);
    case 'list_channels': {
      let list = (await playlistOf(a, ctx)).channels;
      if (a.group) list = list.filter((c) => c.group.toLowerCase() === String(a.group).toLowerCase());
      list = findChannels(list, a.query);
      return { total: list.length, channels: list.slice(0, a.limit || 50).map(brief) };
    }
    case 'whats_on': {
      const pl = await playlistOf(a, ctx);
      if (!pl.epgUrl) throw new Error('this playlist has no guide; add one with epg');
      let list = pl.channels.filter((c) => c.kind === 'live');
      if (a.group) list = list.filter((c) => c.group.toLowerCase() === String(a.group).toLowerCase());
      list = findChannels(list, a.query).slice(0, a.limit || 25);
      const nn = nowNextFor(await guide(pl.epgUrl), list);
      return list.map((c) => ({ ...brief(c), now: prog(nn[c.id]?.now), next: prog(nn[c.id]?.next) }));
    }
    case 'channel_guide': {
      const { pl, ch } = await pickOne(a, ctx, a.channel);
      if (!pl.epgUrl) throw new Error('this playlist has no guide');
      const from = Date.now() + (a.fromHours || 0) * 3600_000;
      const g = guideFor(await guide(pl.epgUrl), [ch], { from, to: from + (a.hours || 12) * 3600_000 });
      return { channel: brief(ch), programmes: (g[ch.id] || []).map(prog) };
    }
    case 'stream_url': {
      const { pl, ch } = await pickOne(a, ctx, a.channel);
      if (!a.at) return { channel: brief(ch), url: ch.url };
      const at = Date.parse(a.at);
      if (!pl.epgUrl) throw new Error('catch-up needs a guide');
      const g = guideFor(await guide(pl.epgUrl), [ch], { from: at, to: at + 1 });
      const p = g[ch.id]?.[0];
      if (!p) throw new Error('no programme at that time');
      const url = catchupUrl(ch, pl.source, p.start, p.stop, pl.account?.timeZone);
      if (!url) throw new Error('that channel has no catch-up');
      return { channel: brief(ch), programme: prog(p), url };
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

/** Answer one JSON-RPC message; null for a notification. */
export async function handleRpc(msg, ctx = {}) {
  const { id, method, params } = msg || {};
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  if (id === undefined || id === null) return null;
  try {
    if (method === 'initialize') {
      return ok({
        protocolVersion: params?.protocolVersion || PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'hdtilt', version: VERSION },
        instructions:
          'hdtilt is an IPTV player. Playlists are saved locally; use list_playlists first, then whats_on or list_channels, then stream_url to get something playable.',
      });
    }
    if (method === 'ping') return ok({});
    if (method === 'tools/list') {
      const hidden = ctx.public ? new Set(['add_playlist', 'list_playlists']) : new Set();
      return ok({ tools: TOOLS.filter((t) => !hidden.has(t.name)) });
    }
    if (method === 'tools/call') {
      try {
        const out = await callTool(params?.name, params?.arguments || {}, ctx);
        return ok({
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: Array.isArray(out) ? { items: out } : out,
        });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: String(e.message || e) }], isError: true });
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `no method ${method}` } };
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } };
  }
}

/** stdio transport: newline-delimited JSON. */
export function serveStdio() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`,
        );
        continue;
      }
      const res = await handleRpc(msg);
      if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
    }
  });
}
