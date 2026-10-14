// Movies & Shows: the catalogue a category at a time, search, shows, and the
// conversion that makes an MKV with Dolby audio play in a browser.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSource } from '../src/core/sources.js';
import { b64urlEncode } from '../src/core/util.js';
import { _indexes, browseVod, buildIndex, fold, searchIndex } from '../src/core/vod.js';
import * as xtream from '../src/core/xtream.js';
import { callTool, TOOLS } from '../src/server/mcp.js';
import { hasFfmpeg, probeSummary, vodOutputArgs } from '../src/server/remux.js';
import { startServer } from '../src/server/server.js';
import { fakeProvider } from './fixtures.js';

let P;
let local;
const scratch = process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, 'tmp') : tmpdir();
const login = () => ({ type: 'xtream', server: P.base, username: 'u', password: 'pw' });
const post = (path, body) =>
  fetch(`http://127.0.0.1:${local.address().port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  P = await fakeProvider();
  local = await startServer({ port: 0, public: false, accounts: null });
});
afterAll(() => {
  P.close();
  local.close();
});

describe('catalogue', () => {
  it('lists categories, then one category newest first', async () => {
    const c = await browseVod(login(), { kind: 'movie' });
    expect(c.categories).toEqual([
      { id: '1', name: 'Action' },
      { id: '2', name: 'Comedy' },
    ]);
    const r = await browseVod(login(), { kind: 'movie', category: '1' });
    expect(r.items.map((x) => x.name)).toEqual(['EN - Matrix Reloaded', 'EN - The Matrix (1999)']);
    expect(r.items[1]).toMatchObject({
      id: 'm101',
      year: 1999,
      rating: 8.7,
      kind: 'vod',
      url: `${P.base}/movie/u/pw/101.mkv`,
    });
  });

  it('treats a get.php M3U URL as the Xtream line it is', async () => {
    const r = await browseVod(
      { type: 'm3u', url: `${P.base}/get.php?username=u&password=pw&type=m3u_plus` },
      {
        kind: 'series',
      },
    );
    expect(r.categories).toEqual([{ id: '5', name: 'Drama' }]);
  });

  it('opens a show with its episodes in order, whichever shape the panel sends', async () => {
    const a = (await browseVod(login(), { seriesId: 9 })).show;
    expect(a).toMatchObject({ name: 'Breaking Bad', genre: 'Drama', year: 2008 });
    expect(a.episodes.map((e) => [e.season, e.episode])).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
    ]);
    expect(a.episodes[0]).toMatchObject({ id: 'e911', duration: 2900, url: `${P.base}/series/u/pw/911.mkv` });
    const b = (await browseVod(login(), { seriesId: 10 })).show;
    expect(b.episodes.map((e) => e.id)).toEqual(['e1011', 'e1021']);
  });

  it('says a plain M3U is browsed from its own entries', async () => {
    expect(await browseVod({ type: 'm3u', url: `${P.base}/vod.m3u` })).toEqual({ local: true });
    const data = await loadSource({ type: 'm3u', url: `${P.base}/vod.m3u` });
    expect(data.channels.map((c) => c.kind)).toEqual(['live', 'vod', 'series']);
  });

  it('titles an episode without its show and code', () => {
    expect(xtream.episodeTitle('EN - Lost In Space (2018) - S01E01 - Impact', 1)).toBe('Impact');
    expect(xtream.episodeTitle('S2E10: The End', 10)).toBe('The End');
    expect(xtream.episodeTitle('AR - Show - S01E01', 1)).toBe('AR - Show - S01E01');
    expect(xtream.episodeTitle('', 3)).toBe('Episode 3');
  });

  it('refuses a show the provider does not have', async () => {
    await expect(xtream.seriesInfo(login(), 404)).rejects.toThrow('nothing for that show');
  });
});

describe('search', () => {
  it('folds accents and case, and wants every word', () => {
    expect(fold('Café SOCIETY!')).toBe('cafe society');
    const ix = buildIndex(
      'movie',
      [
        { stream_id: 1, name: 'LAT - Matrix (1999)', category_id: '3', container_extension: 'mkv' },
        { stream_id: 2, name: 'Matrix Reloaded', category_id: '3', container_extension: 'mp4', rating: '7.04' },
        { stream_id: 3, name: 'The Animatrix', category_id: '4' },
      ],
      [{ id: '3', name: 'Sci-fi' }],
      { server: 'http://h', username: 'u', password: 'p' },
    );
    const r = searchIndex(ix, 'matrix');
    expect(r.total).toBe(3);
    // A title with "matrix" as a word beats one with it inside a word.
    expect(r.items.map((x) => x.name)).toEqual(['LAT - Matrix (1999)', 'Matrix Reloaded', 'The Animatrix']);
    expect(r.items[1]).toMatchObject({ id: 'm2', group: 'Sci-fi', rating: 7, url: 'http://h/movie/u/p/2.mp4' });
    expect(searchIndex(ix, 'matrix 1999').items.map((x) => x.id)).toEqual(['m1']);
    expect(searchIndex(ix, ' ').total).toBe(0);
  });

  it('searches a line through the server, remembering the index', async () => {
    _indexes.clear();
    const r = await (await post('/api/vod', { source: login(), kind: 'movie', q: 'cafe' })).json();
    expect(r.items.map((x) => x.name)).toEqual(['Café Society']);
    expect(_indexes.size).toBe(1);
    const s = await (await post('/api/vod', { source: login(), kind: 'series', q: 'saul' })).json();
    expect(s.items[0]).toMatchObject({ id: 's10', seriesId: 10, group: 'Drama', kind: 'series' });
  });

  it('needs a source', async () => {
    expect((await post('/api/vod', {})).status).toBe(400);
  });
});

describe('MCP', () => {
  it('lists, searches and opens shows on an Xtream line', async () => {
    const cats = await callTool('movies_shows', { source: login(), kind: 'series' });
    expect(cats.categories).toEqual([{ id: '5', name: 'Drama' }]);
    const found = await callTool('movies_shows', { source: login(), query: 'matrix', limit: 1 });
    expect(found.total).toBe(2);
    expect(found.items).toHaveLength(1);
    expect(found.items[0].url).toContain('/movie/u/pw/');
    const show = await callTool('movies_shows', { source: login(), seriesId: 9 });
    expect(show.episodes).toHaveLength(3);
  });
  it("browses a plain M3U's films by group", async () => {
    const source = { type: 'm3u', url: `${P.base}/vod.m3u` };
    expect((await callTool('movies_shows', { source })).categories).toEqual([{ name: 'Action', count: 1 }]);
    const r = await callTool('movies_shows', { source, kind: 'series', category: 'Drama' });
    expect(r.items[0]).toMatchObject({ name: 'Breaking Bad S01 E01', url: `${P.base}/series/u/pw/911.mkv` });
  });
  it('is listed', () => {
    expect(TOOLS.some((t) => t.name === 'movies_shows')).toBe(true);
  });
});

describe('conversion arguments', () => {
  it('copies the picture, converts the sound, and tags HEVC for Safari', () => {
    const h264 = vodOutputArgs({ video: 'h264' });
    expect(h264.join(' ')).toContain('-c:v copy');
    expect(h264.join(' ')).toContain('-c:a aac');
    expect(h264.join(' ')).toContain('-hls_segment_type fmp4');
    expect(h264).not.toContain('hvc1');
    expect(vodOutputArgs({ video: 'hevc' })).toContain('hvc1');
  });
  it('reads a probe', () => {
    expect(
      probeSummary({
        streams: [
          { codec_type: 'video', codec_name: 'hevc' },
          { codec_type: 'audio', codec_name: 'eac3' },
        ],
        format: { duration: '6470.72' },
      }),
    ).toEqual({ duration: 6470.72, video: 'hevc', audio: 'eac3' });
    expect(probeSummary({})).toEqual({ duration: null, video: null, audio: null });
  });
});

// The real thing: an MKV with AC-3 audio, which no browser plays, comes out as
// fMP4 HLS with AAC. Needs ffmpeg (CI installs it; locally set HDTILT_FFMPEG).
const ffmpeg = hasFfmpeg();
describe.skipIf(!ffmpeg)('films through ffmpeg', () => {
  let dir;
  let files;
  let srv;
  let base;
  let mkvUrl;

  beforeAll(async () => {
    dir = await mkdtemp(join(scratch, 'hdtilt-vod-'));
    const clip = join(dir, 'clip.mkv');
    const out = spawnSync(process.env.HDTILT_FFMPEG || 'ffmpeg', [
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
      '20',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-g',
      '25',
      '-c:a',
      'ac3',
      clip,
    ]);
    if (out.status !== 0) throw new Error(String(out.stderr));
    const bytes = await readFile(clip);
    // Ranges, like a real provider's file server: ffmpeg seeks with them.
    files = createServer((req, res) => {
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (!m) {
        res.writeHead(200, {
          'content-type': 'video/x-matroska',
          'content-length': bytes.length,
          'accept-ranges': 'bytes',
        });
        return res.end(bytes);
      }
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : bytes.length - 1;
      res.writeHead(206, {
        'content-type': 'video/x-matroska',
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${bytes.length}`,
        'accept-ranges': 'bytes',
      });
      res.end(bytes.subarray(start, end + 1));
    });
    await new Promise((r) => files.listen(0, '127.0.0.1', r));
    mkvUrl = `http://127.0.0.1:${files.address().port}/movie/u/p/7.mkv`;
    process.env.HDTILT_CACHE = dir;
    srv = await startServer({ port: 0, public: false, accounts: null });
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  afterAll(async () => {
    srv?.close();
    files?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('reads the length and codecs', async () => {
    const r = await (await fetch(`${base}/hls/${b64urlEncode(mkvUrl)}/info.json`)).json();
    expect(r).toMatchObject({ video: 'h264', audio: 'ac3' });
    expect(r.duration).toBeGreaterThan(19);
  });

  it('makes HLS that starts at the beginning, with AAC sound', async () => {
    const res = await fetch(`${base}/hls/${b64urlEncode(mkvUrl)}/index.m3u8?vod=1&t=0`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('#EXT-X-START:TIME-OFFSET=0');
    const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(text)?.[1];
    expect(init).toMatch(/^\/hls\/s\/[a-f0-9]{24}\/init\.mp4$/);
    const initBytes = Buffer.from(await (await fetch(`${base}${init}`)).arrayBuffer());
    expect(initBytes.includes('mp4a')).toBe(true);
    expect(initBytes.includes('avc1')).toBe(true);
    const seg = text.split('\n').find((l) => l.endsWith('.m4s'));
    const s = await fetch(`${base}${seg}`);
    expect(s.status).toBe(200);
    expect(s.headers.get('content-type')).toBe('video/mp4');
    expect((await s.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  it('starts somewhere else as its own session', async () => {
    const a = await (await fetch(`${base}/hls/${b64urlEncode(mkvUrl)}/index.m3u8?vod=1&t=0`)).text();
    const b = await (await fetch(`${base}/hls/${b64urlEncode(mkvUrl)}/index.m3u8?vod=1&t=12`)).text();
    const key = (t) => /\/hls\/s\/([a-f0-9]{24})\//.exec(t)?.[1];
    expect(key(a)).toBeTruthy();
    expect(key(b)).toBeTruthy();
    expect(key(a)).not.toBe(key(b));
  });
});
