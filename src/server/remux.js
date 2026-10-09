// Transport stream -> HLS, for browsers with no Media Source Extensions.
//
// iPhone Safari has no MediaSource, so mpegts.js cannot run there; the only
// live video it plays is HLS. ffmpeg repackages the stream (-c copy: no
// transcode, so it costs a copy, not a CPU) into a short rolling playlist on
// disk. It reads through this server's own /p/ proxy, so the SSRF guard sees
// every hop exactly as it does for any other stream.
//
// One session per stream URL, shared by everyone watching it; sessions with no
// request for IDLE_MS are killed and their directory removed.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IDLE_MS = 30_000;
const START_TIMEOUT_MS = 20_000;

let ffmpegOk = null;
export function hasFfmpeg(bin = process.env.HDTILT_FFMPEG || 'ffmpeg') {
  ffmpegOk ??= spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0;
  return ffmpegOk;
}

/**
 * @param {{ inputFor: (url: string) => string, maxSessions?: number, root?: string, bin?: string }} opts
 *   inputFor turns an upstream URL into the address ffmpeg reads (our proxy).
 */
export function createRemuxer({ inputFor, maxSessions = 20, root, bin = process.env.HDTILT_FFMPEG || 'ffmpeg' }) {
  const base = root || join(process.env.HDTILT_CACHE || tmpdir(), 'hdtilt-hls');
  const sessions = new Map(); // key -> { dir, proc, last, url, ready, ended }

  const keyOf = (url) => createHash('sha256').update(url).digest('hex').slice(0, 24);

  function stop(key) {
    const s = sessions.get(key);
    if (!s) return;
    sessions.delete(key);
    s.proc.kill('SIGKILL');
    rm(s.dir, { recursive: true, force: true }).catch(() => {});
  }

  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [key, s] of sessions) if (now - s.last > IDLE_MS || s.ended) stop(key);
  }, 5_000);
  reaper.unref?.();

  async function start(url) {
    const key = keyOf(url);
    const have = sessions.get(key);
    if (have && !have.ended) {
      have.last = Date.now();
      return key;
    }
    if (sessions.size >= maxSessions)
      throw Object.assign(new Error('too many converted streams right now'), { status: 503 });
    const dir = join(base, key);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const proc = spawn(
      bin,
      [
        '-nostdin',
        '-loglevel',
        'error',
        '-protocol_whitelist',
        'http,tcp',
        '-fflags',
        '+genpts',
        // Real time: a catch-up recording (or any file) arrives faster than it
        // plays, and the rolling playlist would delete segments before Safari
        // asked for them. A live channel is real time already.
        '-re',
        '-i',
        inputFor(url),
        '-map',
        '0:v:0?',
        '-map',
        '0:a:0?',
        '-c',
        'copy',
        '-f',
        'hls',
        '-hls_time',
        '4',
        '-hls_list_size',
        '6',
        '-hls_flags',
        'delete_segments+omit_endlist+independent_segments',
        '-hls_segment_filename',
        join(dir, 'seg%05d.ts'),
        join(dir, 'index.m3u8'),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const s = { dir, proc, last: Date.now(), url, ended: false, error: '' };
    proc.stderr.on('data', (d) => (s.error = (s.error + d).slice(-500)));
    proc.on('exit', () => (s.ended = true));
    sessions.set(key, s);
    return key;
  }

  /** The playlist for a session, waiting for ffmpeg to write the first one. */
  async function playlist(key) {
    const s = sessions.get(key);
    if (!s) return null;
    s.last = Date.now();
    const file = join(s.dir, 'index.m3u8');
    const until = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      try {
        const text = await readFile(file, 'utf8');
        if (text.includes('#EXTINF')) return text;
      } catch {}
      if (s.ended)
        throw Object.assign(new Error(`could not convert this stream${s.error ? `: ${s.error.trim()}` : ''}`), {
          status: 502,
        });
      if (Date.now() > until) throw Object.assign(new Error('the stream did not start in time'), { status: 504 });
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async function segment(key, name) {
    const s = sessions.get(key);
    if (!s || !/^seg\d+\.ts$/.test(name)) return null;
    s.last = Date.now();
    const file = join(s.dir, name);
    try {
      await stat(file);
      return file;
    } catch {
      return null;
    }
  }

  return {
    start,
    playlist,
    segment,
    stop,
    keyOf,
    has: (key) => sessions.has(key) && !sessions.get(key).ended,
    get size() {
      return sessions.size;
    },
    close() {
      clearInterval(reaper);
      for (const key of [...sessions.keys()]) stop(key);
    },
  };
}
