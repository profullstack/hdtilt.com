// Hand a stream to a desktop player. mpv first: it plays every IPTV format and
// takes a title; then VLC; then ffplay.

import { spawn, spawnSync } from 'node:child_process';

const CANDIDATES = [
  ['mpv', (url, title) => ['--force-window=immediate', `--force-media-title=${title}`, url]],
  ['vlc', (url, title) => ['--meta-title', title, url]],
  ['cvlc', (url) => [url]],
  ['ffplay', (url, title) => ['-window_title', title, '-autoexit', url]],
];

const has = (bin) =>
  spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }).status === 0;

export function findPlayer(prefer = process.env.HDTILT_PLAYER) {
  if (prefer) {
    const known = CANDIDATES.find(([b]) => b === prefer);
    return { bin: prefer, args: known ? known[1] : (url) => [url] };
  }
  for (const [bin, args] of CANDIDATES) if (has(bin)) return { bin, args };
  return null;
}

/** Start the player detached, so the CLI or TUI keeps the terminal. */
export function play(url, title = 'hdtilt', { prefer, wait = false } = {}) {
  const p = findPlayer(prefer);
  if (!p) throw new Error('no player found; install mpv (recommended) or VLC, or set HDTILT_PLAYER');
  const child = spawn(p.bin, p.args(url, title), {
    stdio: wait ? 'inherit' : 'ignore',
    detached: !wait,
  });
  if (!wait) child.unref();
  return { player: p.bin, child };
}
