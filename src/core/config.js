// Local state for the CLI, TUI, MCP and desktop: ~/.config/hdtilt/config.json.
// Provider passwords live here, so the file is written 0600.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadSource } from './sources.js';

export const configDir = () =>
  process.env.HDTILT_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'hdtilt');
const cacheDir = () =>
  process.env.HDTILT_CACHE || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'hdtilt');
const configFile = () => join(configDir(), 'config.json');

const CHANNEL_TTL_MS = 12 * 60 * 60 * 1000;

/** @returns {Promise<{ playlists: Record<string, import('./sources.js').Source>, current?: string, favorites: Record<string, string[]>, recent: string[] }>} */
export async function readConfig() {
  try {
    const c = JSON.parse(await readFile(configFile(), 'utf8'));
    return { playlists: {}, favorites: {}, recent: [], ...c };
  } catch {
    return { playlists: {}, favorites: {}, recent: [] };
  }
}

export async function writeConfig(cfg) {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  const tmp = `${configFile()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, configFile());
}

export async function addPlaylist(name, source) {
  const cfg = await readConfig();
  cfg.playlists[name] = source;
  cfg.current ??= name;
  await writeConfig(cfg);
  return cfg;
}

export async function removePlaylist(name) {
  const cfg = await readConfig();
  if (!cfg.playlists[name]) throw new Error(`no playlist named ${name}`);
  delete cfg.playlists[name];
  delete cfg.favorites[name];
  if (cfg.current === name) cfg.current = Object.keys(cfg.playlists)[0];
  await writeConfig(cfg);
}

/** Pick a playlist by name, else the current one, else the only one. */
export async function resolvePlaylist(name) {
  const cfg = await readConfig();
  const names = Object.keys(cfg.playlists);
  const pick = name || cfg.current || names[0];
  if (!pick || !cfg.playlists[pick]) {
    throw new Error(
      names.length
        ? `no playlist named ${name}; have: ${names.join(', ')}`
        : 'no playlists yet; add one with `hdtilt add <name> <m3u-url>`',
    );
  }
  return { name: pick, source: cfg.playlists[pick], cfg };
}

/** Channels for a playlist, cached on disk for 12 hours. */
export async function channelsFor(name, { refresh = false } = {}) {
  const { name: pick, source } = await resolvePlaylist(name);
  const file = join(cacheDir(), `${pick.replace(/[^a-z0-9_-]/gi, '_')}.json`);
  if (!refresh) {
    try {
      const c = JSON.parse(await readFile(file, 'utf8'));
      if (Date.now() - c.at < CHANNEL_TTL_MS) return { name: pick, source, ...c.data };
    } catch {}
  }
  const data = await loadSource(source);
  await mkdir(cacheDir(), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ at: Date.now(), data }), { mode: 0o600 });
  return { name: pick, source, ...data };
}

/** Find channels by number, exact id, or name substring. */
export function findChannels(channels, query) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return channels;
  if (/^\d+$/.test(q)) {
    const n = Number(q);
    const byNo = channels.filter((c) => c.chno === n);
    if (byNo.length) return byNo;
  }
  const exact = channels.filter((c) => c.id.toLowerCase() === q || c.name.toLowerCase() === q);
  if (exact.length) return exact;
  return channels.filter((c) => c.name.toLowerCase().includes(q));
}
