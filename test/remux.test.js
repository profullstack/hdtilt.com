// Transport stream -> HLS for Safari on iPhone, end to end through ffmpeg.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64urlEncode } from '../src/core/util.js';
import { hasFfmpeg } from '../src/server/remux.js';
import { startServer } from '../src/server/server.js';

const ffmpeg = hasFfmpeg();
let dir;
let provider;
let srv;
let base;
let tsUrl;

beforeAll(async () => {
  if (!ffmpeg) return;
  dir = await mkdtemp(
    join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, 'tmp') : tmpdir(), 'hdtilt-remux-'),
  );
  const clip = join(dir, 'clip.ts');
  spawnSync(process.env.HDTILT_FFMPEG || 'ffmpeg', [
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=25',
    '-f',
    'lavfi',
    '-i',
    'sine',
    '-t',
    '10',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    '25',
    '-c:a',
    'aac',
    '-f',
    'mpegts',
    clip,
  ]);
  const bytes = await readFile(clip);
  provider = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    res.end(bytes);
  });
  await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  tsUrl = `http://127.0.0.1:${provider.address().port}/live/u/p/1.ts`;
  process.env.HDTILT_CACHE = dir;
  srv = await startServer({ port: 0, public: false, accounts: null });
  base = `http://127.0.0.1:${srv.address().port}`;
});
afterAll(async () => {
  if (!ffmpeg) return;
  srv.close();
  provider.close();
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!ffmpeg)('HLS for browsers without MSE', () => {
  it('turns a transport stream into a playable HLS playlist', async () => {
    const res = await fetch(`${base}/hls/${b64urlEncode(tsUrl)}/index.m3u8`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    const text = await res.text();
    expect(text).toContain('#EXTINF');
    const seg = text.split('\n').find((l) => l.startsWith('/hls/s/'));
    expect(seg).toMatch(/^\/hls\/s\/[a-f0-9]{24}\/seg\d+\.ts$/);
    const s = await fetch(`${base}${seg}`);
    expect(s.status).toBe(200);
    const buf = new Uint8Array(await s.arrayBuffer());
    expect(buf.length).toBeGreaterThan(188 * 10);
    expect(buf[0]).toBe(0x47); // MPEG-TS sync byte
  }, 30_000);

  it('shares one conversion between viewers', async () => {
    const a = await (await fetch(`${base}/hls/${b64urlEncode(tsUrl)}/index.m3u8`)).text();
    const b = await (await fetch(`${base}/hls/${b64urlEncode(tsUrl)}/index.m3u8`)).text();
    const key = (t) => t.match(/\/hls\/s\/([a-f0-9]{24})\//)[1];
    expect(key(a)).toBe(key(b));
  }, 30_000);

  it('refuses a bad address and an unknown segment', async () => {
    expect((await fetch(`${base}/hls/!!/index.m3u8`)).status).toBe(404);
    expect((await fetch(`${base}/hls/s/${'0'.repeat(24)}/seg00001.ts`)).status).toBe(404);
  });
});
