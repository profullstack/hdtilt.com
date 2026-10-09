#!/usr/bin/env node
// hdtilt: an open-source IPTV player. One binary for every surface:
// CLI commands, the terminal guide (tui), MCP on stdio (mcp), and the
// web/API/MCP server (serve).

import { parseArgs } from 'node:util';
import { addPlaylist, channelsFor, findChannels, readConfig, removePlaylist, writeConfig } from '../src/core/config.js';
import { guideFor, loadGuide, nowNextFor } from '../src/core/guide.js';
import { catchupUrl, groupsOf } from '../src/core/sources.js';
import { VERSION } from '../src/version.js';

const HELP = `hdtilt ${VERSION} — open-source IPTV player (M3U, Xtream Codes, XMLTV)

Playlists
  hdtilt add <name> <m3u-url> [--epg <xmltv-url>]
  hdtilt add <name> --xtream <server> --user <u> --pass <p> [--epg <url>]
  hdtilt playlists                 list saved playlists
  hdtilt use <name>                make a playlist the default
  hdtilt remove <name>
  hdtilt refresh [name]            re-download channels

Watching
  hdtilt groups                    channel groups and counts
  hdtilt channels [query] [--group <g>]
  hdtilt now [query] [--group <g>] what is on now and next
  hdtilt guide <channel> [--hours 12] [--from -6]
  hdtilt url <channel> [--at <iso-time>]   stream URL (catch-up with --at)
  hdtilt play <channel> [--at <iso-time>] [--player mpv|vlc|ffplay]
  hdtilt fav <channel>             toggle a favorite

Account (sync playlists and favorites with hdtilt.com)
  hdtilt login [--manual]          sign in through the browser (OAuth 2.1 + PKCE)
  hdtilt whoami | sync | logout

Surfaces
  hdtilt tui                       terminal guide
  hdtilt serve [--port 8930] [--host 127.0.0.1] [--public]
                                   web app + API + MCP at /mcp
  hdtilt mcp                       MCP server on stdio

Common flags: -p/--playlist <name>, --json, -n/--limit <n>
Config: ~/.config/hdtilt/config.json (0600; holds provider passwords)`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    playlist: { type: 'string', short: 'p' },
    epg: { type: 'string' },
    xtream: { type: 'string' },
    user: { type: 'string' },
    pass: { type: 'string' },
    group: { type: 'string', short: 'g' },
    hours: { type: 'string' },
    from: { type: 'string' },
    at: { type: 'string' },
    player: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    public: { type: 'boolean' },
    manual: { type: 'boolean' },
    json: { type: 'boolean' },
    limit: { type: 'string', short: 'n' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});

const [cmd, ...args] = positionals;
const limit = Number(o.limit) || 50;
const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);
const out = (data, text) => console.log(o.json ? JSON.stringify(data, null, 2) : text());

async function pick(q) {
  if (!q) throw new Error('which channel? give a name, number or id');
  const pl = await channelsFor(o.playlist);
  const hits = findChannels(pl.channels, q);
  if (!hits.length) throw new Error(`no channel matches "${q}"`);
  return { pl, ch: hits[0] };
}

async function urlFor(pl, ch) {
  if (!o.at) return ch.url;
  if (!pl.epgUrl) throw new Error('catch-up needs a guide');
  const at = Date.parse(o.at);
  if (Number.isNaN(at)) throw new Error('--at must be a time, e.g. 2026-10-09T20:00');
  const p = guideFor(await loadGuide(pl.epgUrl), [ch], { from: at, to: at + 1 })[ch.id]?.[0];
  if (!p) throw new Error('no programme on that channel at that time');
  const u = catchupUrl(ch, pl.source, p.start, p.stop, pl.account?.timeZone);
  if (!u) throw new Error(`${ch.name} has no catch-up`);
  return u;
}

const commands = {
  async add() {
    const [name, url] = args;
    if (!name) throw new Error('usage: hdtilt add <name> <m3u-url> | --xtream <server> --user u --pass p');
    const source = o.xtream
      ? { type: 'xtream', server: o.xtream, username: o.user, password: o.pass }
      : url
        ? { type: 'm3u', url }
        : null;
    if (!source || (source.type === 'xtream' && !(o.user && o.pass)))
      throw new Error('need an M3U URL, or --xtream with --user and --pass');
    if (o.epg) source.epg = o.epg;
    await addPlaylist(name, source);
    const pl = await channelsFor(name, { refresh: true });
    console.log(
      `Saved ${name}: ${pl.channels.length} channels in ${groupsOf(pl.channels).length} groups${pl.epgUrl ? ', guide found' : ', no guide (add one with --epg)'}`,
    );
    await (await import('../src/cli/sync.js')).pushQuietly();
  },
  async playlists() {
    const cfg = await readConfig();
    const rows = Object.entries(cfg.playlists).map(([name, s]) => ({
      name,
      type: s.type,
      current: name === cfg.current,
    }));
    out(rows, () =>
      rows.length
        ? rows.map((r) => `${r.current ? '*' : ' '} ${r.name}  (${r.type})`).join('\n')
        : 'No playlists. hdtilt add <name> <m3u-url>',
    );
  },
  async use() {
    const cfg = await readConfig();
    if (!cfg.playlists[args[0]]) throw new Error(`no playlist named ${args[0]}`);
    cfg.current = args[0];
    await writeConfig(cfg);
    console.log(`Default playlist: ${args[0]}`);
  },
  async remove() {
    const cfg = await readConfig();
    // Remembered so a sync does not bring it back from another device.
    const id = cfg.libraryIds?.[args[0]];
    await removePlaylist(args[0]);
    if (id) {
      const after = await readConfig();
      after.deletedIds = [...new Set([...(after.deletedIds || []), id])];
      delete after.libraryIds?.[args[0]];
      await writeConfig(after);
    }
    console.log(`Removed ${args[0]}`);
    await (await import('../src/cli/sync.js')).pushQuietly();
  },
  async refresh() {
    const pl = await channelsFor(args[0] || o.playlist, { refresh: true });
    console.log(`${pl.name}: ${pl.channels.length} channels`);
  },
  async groups() {
    const g = groupsOf((await channelsFor(o.playlist)).channels);
    out(g, () => g.map((x) => `${String(x.count).padStart(6)}  ${x.name}`).join('\n'));
  },
  async channels() {
    let list = (await channelsFor(o.playlist)).channels;
    if (o.group) list = list.filter((c) => c.group.toLowerCase() === o.group.toLowerCase());
    list = findChannels(list, args.join(' '));
    const shown = list.slice(0, limit);
    out(
      shown,
      () =>
        shown
          .map(
            (c) =>
              `${c.chno != null ? String(c.chno).padStart(5) : '     '}  ${c.name}  [${c.group}]${c.catchup ? '  ⟲' : ''}`,
          )
          .join('\n') + (list.length > shown.length ? `\n… ${list.length - shown.length} more (-n to show more)` : ''),
    );
  },
  async now() {
    const pl = await channelsFor(o.playlist);
    if (!pl.epgUrl) throw new Error('this playlist has no guide; re-add it with --epg <xmltv-url>');
    let list = pl.channels.filter((c) => c.kind === 'live');
    if (o.group) list = list.filter((c) => c.group.toLowerCase() === o.group.toLowerCase());
    list = findChannels(list, args.join(' ')).slice(0, limit);
    const nn = nowNextFor(await loadGuide(pl.epgUrl), list);
    const rows = list.map((c) => ({ channel: c.name, now: nn[c.id]?.now || null, next: nn[c.id]?.next || null }));
    out(rows, () =>
      rows
        .map(
          (r) =>
            `${r.channel.slice(0, 28).padEnd(28)}  ${r.now ? `${hhmm(r.now.start)} ${r.now.title}` : '—'}${r.next ? `   → ${hhmm(r.next.start)} ${r.next.title}` : ''}`,
        )
        .join('\n'),
    );
  },
  async guide() {
    const { pl, ch } = await pick(args.join(' '));
    if (!pl.epgUrl) throw new Error('this playlist has no guide');
    const from = Date.now() + (Number(o.from) || 0) * 3600_000;
    const to = from + (Number(o.hours) || 12) * 3600_000;
    const list = guideFor(await loadGuide(pl.epgUrl), [ch], { from, to })[ch.id] || [];
    out(
      { channel: ch, programmes: list },
      () =>
        `${ch.name}\n` +
        (list.length
          ? list
              .map(
                (p) =>
                  `  ${new Date(p.start).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}  ${p.title}`,
              )
              .join('\n')
          : '  no guide data'),
    );
  },
  async url() {
    const { pl, ch } = await pick(args.join(' '));
    console.log(await urlFor(pl, ch));
  },
  async play() {
    const { pl, ch } = await pick(args.join(' '));
    const { play } = await import('../src/cli/player.js');
    const { player } = play(await urlFor(pl, ch), ch.name, { prefer: o.player, wait: true });
    console.error(`${ch.name} → ${player}`);
  },
  async fav() {
    const { pl, ch } = await pick(args.join(' '));
    const cfg = await readConfig();
    const s = new Set(cfg.favorites[pl.name] || []);
    s.has(ch.id) ? s.delete(ch.id) : s.add(ch.id);
    cfg.favorites[pl.name] = [...s];
    await writeConfig(cfg);
    console.log(`${s.has(ch.id) ? '★ added' : 'removed'} ${ch.name}`);
    await (await import('../src/cli/sync.js')).pushQuietly();
  },
  async login() {
    const { signIn, sync } = await import('../src/cli/sync.js');
    const me = await signIn({ manual: o.manual });
    console.log(`Signed in as ${me.username || me.email}`);
    const r = await sync();
    console.log(`Synced ${r.playlists} playlist(s)${r.added ? `, ${r.added} new on this machine` : ''}`);
  },
  async logout() {
    const { signOut } = await import('../src/cli/sync.js');
    await signOut();
    console.log('Signed out');
  },
  async whoami() {
    const { whoami, issuer } = await import('../src/cli/sync.js');
    const me = await whoami();
    out(me, () => `${me.username || ''} <${me.email}> on ${issuer()}`);
  },
  async sync() {
    const { sync } = await import('../src/cli/sync.js');
    const r = await sync();
    console.log(`Synced ${r.playlists} playlist(s)${r.added ? `, ${r.added} new on this machine` : ''}`);
  },
  async tui() {
    const { runTui } = await import('../src/cli/tui.js');
    await runTui({ playlist: o.playlist });
  },
  async serve() {
    const { startServer } = await import('../src/server/server.js');
    const isPublic = Boolean(o.public);
    const port = Number(o.port) || Number(process.env.PORT) || 8930;
    const host = o.host || process.env.HOST || '127.0.0.1';
    await startServer({ port, host, public: isPublic });
    console.log(`hdtilt on http://${host}:${port}  (API /api, MCP /mcp${isPublic ? ', public mode' : ''})`);
  },
  async mcp() {
    const { serveStdio } = await import('../src/server/mcp.js');
    serveStdio();
  },
};

if (o.version) console.log(VERSION);
else if (o.help || !cmd || cmd === 'help') console.log(HELP);
else if (!commands[cmd]) {
  console.error(`unknown command: ${cmd}\n\n${HELP}`);
  process.exit(2);
} else {
  commands[cmd]().catch((e) => {
    console.error(`hdtilt: ${e.message || e}`);
    process.exit(1);
  });
}
