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
//
// Films and episodes (vod) are the other job. Providers serve them as they
// were ripped: MKV, HEVC or H.264, with AC-3 / E-AC-3 / DTS audio, and asking
// for .ts or .mp4 instead is a 500. Browsers play none of that audio, so the
// video is copied and only the audio is converted (stereo AAC, cheap), into
// fMP4 HLS (HEVC in a .ts segment plays in neither hls.js nor Safari). Seeking
// past what has been converted starts a new session there (`at`), so a vod
// session is one url + one start, and its playlist keeps every segment.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IDLE_MS = 30_000;
const START_TIMEOUT_MS = 20_000;
const MAX_PROBES = 8;

let ffmpegOk = null;
export function hasFfmpeg(bin = process.env.HDTILT_FFMPEG || 'ffmpeg') {
  ffmpegOk ??= spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0;
  return ffmpegOk;
}

/** ffprobe beside the ffmpeg in use, unless HDTILT_FFPROBE says otherwise. */
const ffprobeOf = (bin) => process.env.HDTILT_FFPROBE || bin.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');

/** What a probe says about a file, in the terms the player cares about. */
export function probeSummary(json) {
  const streams = json?.streams || [];
  const video = streams.find((x) => x.codec_type === 'video');
  const audio = streams.find((x) => x.codec_type === 'audio');
  const duration = Number(json?.format?.duration);
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    video: video?.codec_name || null,
    audio: audio?.codec_name || null,
  };
}

/** ffmpeg's output arguments for a film or an episode (`info` from probeSummary). */
export function vodOutputArgs(info = {}) {
  return [
    '-map',
    '0:v:0?',
    '-map',
    '0:a:0?',
    '-c:v',
    'copy',
    // Safari only plays HEVC in fMP4 tagged hvc1; a copy keeps the hev1 tag.
    ...(info.video === 'hevc' ? ['-tag:v', 'hvc1'] : []),
    '-c:a',
    'aac',
    '-ac',
    '2',
    '-b:a',
    '160k',
    '-f',
    'hls',
    '-hls_time',
    '6',
    '-hls_list_size',
    '0',
    '-hls_playlist_type',
    'event',
    '-hls_segment_type',
    'fmp4',
    '-hls_flags',
    'independent_segments',
    '-hls_fmp4_init_filename',
    'init.mp4',
  ];
}

/**
 * @param {{ inputFor: (url: string) => string, maxSessions?: number, root?: string, bin?: string }} opts
 *   inputFor turns an upstream URL into the address ffmpeg reads (our proxy).
 */
export function createRemuxer({
  inputFor,
  headers = {},
  maxSessions = 20,
  root,
  bin = process.env.HDTILT_FFMPEG || 'ffmpeg',
}) {
  const base = root || join(process.env.HDTILT_CACHE || tmpdir(), 'hdtilt-hls');
  const sessions = new Map(); // key -> { dir, proc, last, url, ready, ended }

  const keyOf = (url, { vod = false, at = 0 } = {}) =>
    createHash('sha256')
      .update(vod ? `${url}\n${Math.floor(at)}` : url)
      .digest('hex')
      .slice(0, 24);
  const headerArgs = () =>
    Object.keys(headers).length
      ? [
          '-headers',
          Object.entries(headers)
            .map(([k, v]) => `${k}: ${v}\r\n`)
            .join(''),
        ]
      : [];

  // One probe per file, remembered for an hour: every seek would ask again.
  // A few at a time: each is a process and a connection to the provider.
  const probes = new Map(); // url -> { at, p }
  let probing = 0;
  function probe(url) {
    const have = probes.get(url);
    if (have && Date.now() - have.at < 3600_000) return have.p;
    if (probing >= MAX_PROBES)
      return Promise.reject(Object.assign(new Error('busy reading other files; try again'), { status: 503 }));
    probing++;
    const p = new Promise((resolve, reject) => {
      const proc = spawn(
        ffprobeOf(bin),
        [
          '-v',
          'error',
          '-protocol_whitelist',
          'http,tcp',
          ...headerArgs(),
          '-show_entries',
          'stream=codec_type,codec_name:format=duration',
          '-of',
          'json',
          inputFor(url),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      let err = '';
      const timer = setTimeout(() => proc.kill('SIGKILL'), START_TIMEOUT_MS);
      proc.stdout.on('data', (d) => (out += d));
      proc.stderr.on('data', (d) => (err = (err + d).slice(-500)));
      proc.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        const fail = () =>
          reject(Object.assign(new Error(`could not read this file${err ? `: ${err.trim()}` : ''}`), { status: 502 }));
        if (code !== 0) return fail();
        try {
          resolve(probeSummary(JSON.parse(out)));
        } catch {
          fail();
        }
      });
    });
    probes.set(url, { at: Date.now(), p });
    p.catch(() => probes.delete(url)).finally(() => probing--);
    if (probes.size > 500) probes.delete(probes.keys().next().value);
    return p;
  }

  function stop(key) {
    const s = sessions.get(key);
    if (!s) return;
    sessions.delete(key);
    s.proc.kill('SIGKILL');
    rm(s.dir, { recursive: true, force: true }).catch(() => {});
  }

  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [key, s] of sessions) if (now - s.last > IDLE_MS || (s.ended && !s.complete)) stop(key);
  }, 5_000);
  reaper.unref?.();

  // A film converted to the end is still being watched: its playlist is whole.
  const usable = (s) => s && (!s.ended || s.complete);

  /** opts.vod: a film or episode (see the top of this file); opts.at: where it starts, in seconds. */
  async function start(url, { vod = false, at = 0 } = {}) {
    at = vod ? Math.max(0, Math.floor(Number(at) || 0)) : 0;
    const key = keyOf(url, { vod, at });
    const have = sessions.get(key);
    if (usable(have)) {
      have.last = Date.now();
      return key;
    }
    if (sessions.size >= maxSessions)
      throw Object.assign(new Error('too many converted streams right now'), { status: 503 });
    const dir = join(base, key);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const info = vod ? await probe(url).catch(() => ({})) : null;
    const args = vod
      ? [
          '-nostdin',
          '-loglevel',
          'error',
          '-protocol_whitelist',
          'http,tcp',
          // A burst to start quickly, then real time: a film is fetched as it
          // is watched, not all at once onto this disk.
          '-readrate',
          '1',
          '-readrate_initial_burst',
          '30',
          ...(at ? ['-ss', String(at)] : []),
          ...headerArgs(),
          '-i',
          inputFor(url),
          ...vodOutputArgs(info),
          '-hls_segment_filename',
          join(dir, 'seg%05d.m4s'),
          join(dir, 'index.m3u8'),
        ]
      : [
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
          ...headerArgs(),
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
        ];
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const s = { dir, proc, last: Date.now(), url, vod, ended: false, complete: false, error: '' };
    proc.stderr.on('data', (d) => (s.error = (s.error + d).slice(-500)));
    proc.on('exit', (code) => {
      s.ended = true;
      s.complete = vod && code === 0;
    });
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
    if (!s || !/^(seg\d+\.(ts|m4s)|init\.mp4)$/.test(name)) return null;
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
    probe,
    playlist,
    segment,
    stop,
    keyOf,
    urlOf: (key) => sessions.get(key)?.url,
    has: (key) => usable(sessions.get(key)),
    get size() {
      return sessions.size;
    },
    close() {
      clearInterval(reaper);
      for (const key of [...sessions.keys()]) stop(key);
    },
  };
}
