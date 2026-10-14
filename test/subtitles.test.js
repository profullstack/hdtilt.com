import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanTitle,
  createSubtitles,
  credentialsFrom,
  moviehash,
  moviehashOf,
  rankResults,
  resultOf,
  searchParams,
  shiftVtt,
  toVtt,
} from '../src/core/subtitles.js';
import { startServer } from '../src/server/server.js';

let home;
beforeAll(async () => {
  home = await mkdtemp(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, 'tmp') : tmpdir(), 'subs-'));
});
afterAll(() => rm(home, { recursive: true, force: true }));

const SRT = `1
00:00:01,500 --> 00:00:03,000
{\\an8}Hello <font color="#fff">there</font>

2
00:01:00,000 --> 00:01:02,250
Second line
`;

describe('titles', () => {
  it('cleans provider names', () => {
    expect(cleanTitle('EN - The Matrix (1999) 4K')).toEqual({ title: 'The Matrix', year: 1999 });
    expect(cleanTitle('|EN| Dune: Part Two [2024] HEVC')).toEqual({ title: 'Dune: Part Two', year: 2024 });
    expect(cleanTitle('4K-NF - Glass Onion 2022')).toEqual({ title: 'Glass Onion', year: 2022 });
    expect(cleanTitle('[MULTI] Amélie')).toEqual({ title: 'Amélie', year: 0 });
    expect(cleanTitle('Heat')).toEqual({ title: 'Heat', year: 0 });
  });
  it('keeps a title that is all tags rather than empty it', () => {
    expect(cleanTitle('4K').title).toBe('4K');
  });
});

describe('search parameters', () => {
  it('sorts keys and lowercases values, with no defaults', () => {
    expect(searchParams({ title: 'EN - The Matrix (1999)', languages: 'FR,en' })).toBe(
      'languages=en%2Cfr&query=the+matrix&type=movie&year=1999',
    );
  });
  it('prefers a TMDB id to a title', () => {
    expect(searchParams({ title: 'Whatever', tmdbId: '0603', languages: 'en' })).toBe(
      'languages=en&tmdb_id=603&type=movie',
    );
  });
  it('asks for an episode by its show', () => {
    expect(searchParams({ title: 'Lost', tmdbId: 4607, season: 1, episode: 2 })).toBe(
      'episode_number=2&languages=en&parent_tmdb_id=4607&season_number=1&type=episode',
    );
    // Without an id: the show's name, and no year.
    expect(searchParams({ title: 'EN - Lost (2004)', season: 1, episode: 2 })).toBe(
      'episode_number=2&languages=en&query=lost&season_number=1&type=episode',
    );
  });
});

describe('results', () => {
  const row = (id, a) => ({ id: String(id), attributes: { files: [{ file_id: id, file_name: `f${id}.srt` }], ...a } });
  it('ranks this-file matches, then single files, trusted, human, downloads', () => {
    const list = [
      row(1, { download_count: 900 }),
      row(2, { download_count: 10, moviehash_match: true }),
      row(3, { download_count: 5000, nb_cd: 2 }),
      row(4, { download_count: 100, from_trusted: true }),
      row(5, { download_count: 99999, ai_translated: true }),
    ].map(resultOf);
    expect(rankResults(list).map((r) => r.fileId)).toEqual([2, 4, 1, 5, 3]);
  });
});

describe('asked by title', () => {
  const ep = (id, show, downloads) =>
    resultOf({
      id: String(id),
      attributes: {
        download_count: downloads,
        files: [{ file_id: id }],
        feature_details: { parent_title: show, season_number: 1, episode_number: 1 },
      },
    });
  it('puts the show asked for above a looser match (seen on the real API)', () => {
    const list = [ep(1, 'The Bad Guys: Breaking In', 9000), ep(2, 'Breaking Bad', 10)];
    expect(rankResults(list, { title: 'Breaking Bad' }).map((r) => r.fileId)).toEqual([2, 1]);
    // Asked by id, the order is OpenSubtitles' own signals.
    expect(rankResults(list).map((r) => r.fileId)).toEqual([1, 2]);
  });
  it('prefers the year asked for', () => {
    const film = (id, year) =>
      resultOf({ id: String(id), attributes: { files: [{ file_id: id }], feature_details: { title: 'Heat', year } } });
    expect(rankResults([film(1, 1986), film(2, 1995)], { title: 'Heat', year: 1995 })[0].fileId).toBe(2);
  });
});

describe('WebVTT', () => {
  it('turns SubRip into WebVTT', () => {
    const v = toVtt(`﻿${SRT.replace(/\n/g, '\r\n')}`);
    expect(v.startsWith('WEBVTT\n\n')).toBe(true);
    expect(v).toContain('00:00:01.500 --> 00:00:03.000');
    expect(v).toContain('Hello there');
    expect(v).not.toContain('{\\an8}');
  });
  it('leaves WebVTT alone', () => {
    expect(toVtt('WEBVTT\n\n00:00.000 --> 00:01.000\nx')).toBe('WEBVTT\n\n00:00.000 --> 00:01.000\nx');
  });
  it('shifts cues and drops the ones that end before zero', () => {
    const v = shiftVtt(toVtt(SRT), -30);
    expect(v).not.toContain('Hello');
    expect(v).toContain('00:00:30.000 --> 00:00:32.250');
    expect(shiftVtt(toVtt(SRT), 0.5)).toContain('00:00:02.000 --> 00:00:03.500');
  });
  it('keeps cue settings and short timestamps', () => {
    expect(shiftVtt('WEBVTT\n\n00:05.000 --> 00:06.000 line:10%\nx\n', 1)).toContain(
      '00:00:06.000 --> 00:00:07.000 line:10%',
    );
  });
});

describe('moviehash', () => {
  it('adds the size and the 64-bit words of both ends', () => {
    const head = new Uint8Array(65536);
    const tail = new Uint8Array(65536);
    head[0] = 1; // word 1
    tail[8] = 2; // word 2
    tail[65535] = 0x80; // the top byte of the last word: wraps past 2^64 with the rest
    const size = 2 ** 20;
    const want = (BigInt(size) + 1n + 2n + (0x80n << 56n)) & ((1n << 64n) - 1n);
    expect(moviehashOf(size, head, tail)).toBe(want.toString(16).padStart(16, '0'));
  });
  it('reads it with two range requests, and gives up without ranges', async () => {
    const size = 300_000;
    const file = new Uint8Array(size).map((_, i) => i % 251);
    const fakeFetch = async (_url, { headers }) => {
      const m = /bytes=(\d+)-(\d+)/.exec(headers.range);
      const [a, b] = [Number(m[1]), Number(m[2])];
      return new Response(file.slice(a, b + 1), {
        status: 206,
        headers: { 'content-range': `bytes ${a}-${b}/${size}` },
      });
    };
    expect(await moviehash('http://x/f.mkv', fakeFetch)).toBe(
      moviehashOf(size, file.slice(0, 65536), file.slice(size - 65536)),
    );
    expect(await moviehash('http://x/f.mkv', async () => new Response('whole', { status: 200 }))).toBeNull();
  });
});

describe('credentials', () => {
  it('reads the environment first, then the config', () => {
    expect(credentialsFrom({ OPENSUBTITLES_API_KEY: 'e' }, { opensubtitles: { apiKey: 'c', username: 'u' } })).toEqual({
      apiKey: 'e',
      username: 'u',
      password: '',
    });
  });
});

/** A stand-in for api.opensubtitles.com, recording what it was asked. */
function fakeOpenSubtitles() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({
      path: u.pathname,
      search: u.search,
      host: u.host,
      auth: h.authorization,
      key: h['api-key'],
      ua: h['user-agent'],
    });
    if (u.pathname.endsWith('/login'))
      return Response.json({ token: 'tok', base_url: 'vip-api.opensubtitles.com', user: {}, status: 200 });
    if (u.pathname.endsWith('/subtitles'))
      return Response.json({
        data: [
          { id: '1', attributes: { language: 'en', download_count: 5, files: [{ file_id: 11, file_name: 'a.srt' }] } },
          { id: '2', attributes: { language: 'en', download_count: 50, files: [{ file_id: 22, file_name: 'b.srt' }] } },
        ],
      });
    if (u.pathname.endsWith('/download')) {
      const { file_id } = JSON.parse(init.body);
      if (file_id === 99) return Response.json({ message: 'quota', reset_time: '3 hours' }, { status: 406 });
      return Response.json({ link: `https://dl.example/${file_id}.srt`, remaining: 19 });
    }
    if (u.host === 'dl.example') return new Response(SRT);
    return new Response('?', { status: 404 });
  };
  return { calls, fetchImpl };
}

describe('client', () => {
  it('searches, best first, and caches the search', async () => {
    const f = fakeOpenSubtitles();
    const s = createSubtitles({ apiKey: 'K', fetch: f.fetchImpl, cacheDir: join(home, 'c1') });
    const r = await s.search({ title: 'Heat', year: 1995 });
    expect(r.map((x) => x.fileId)).toEqual([22, 11]);
    await s.search({ title: 'Heat', year: 1995 });
    expect(f.calls.filter((c) => c.path.endsWith('/subtitles'))).toHaveLength(1);
    expect(f.calls[0].key).toBe('K');
    expect(f.calls[0].ua).toMatch(/^hdtilt v\d/);
  });
  it('downloads once per file: the second time is the disk cache', async () => {
    const f = fakeOpenSubtitles();
    const s = createSubtitles({ apiKey: 'K', fetch: f.fetchImpl, cacheDir: join(home, 'c2') });
    const a = await s.download(11);
    expect(a.fresh).toBe(true);
    expect(a.vtt.startsWith('WEBVTT')).toBe(true);
    const b = await s.download(11);
    expect(b.fresh).toBe(false);
    expect(f.calls.filter((c) => c.path.endsWith('/download'))).toHaveLength(1);
  });
  it('signs in when it has an account, and talks to the host it was given', async () => {
    const f = fakeOpenSubtitles();
    const s = createSubtitles({
      apiKey: 'K',
      username: 'u',
      password: 'p',
      fetch: f.fetchImpl,
      cacheDir: join(home, 'c3'),
    });
    await s.download(22);
    const dl = f.calls.find((c) => c.path.endsWith('/download'));
    expect(dl.auth).toBe('Bearer tok');
    expect(dl.host).toBe('vip-api.opensubtitles.com');
    expect(f.calls.filter((c) => c.path.endsWith('/login'))).toHaveLength(1);
  });
  it('says when the day is used up', async () => {
    const f = fakeOpenSubtitles();
    const s = createSubtitles({ apiKey: 'K', fetch: f.fetchImpl, cacheDir: join(home, 'c4') });
    await expect(s.download(99)).rejects.toThrow(/used up; more in 3 hours/);
  });
  it('is off without a key', async () => {
    const s = createSubtitles({ apiKey: '' });
    expect(s.enabled).toBe(false);
    await expect(s.search({ title: 'x' })).rejects.toThrow(/not set up/);
  });
});

describe('server', () => {
  let srv;
  let file;
  const at = (p) => `http://127.0.0.1:${srv.address().port}${p}`;
  beforeAll(async () => {
    // A provider's film that answers range requests, for the moviehash.
    const size = 200_000;
    const bytes = new Uint8Array(size).map((_, i) => (i * 7) % 256);
    file = createServer((req, res) => {
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!m) return res.writeHead(200).end(Buffer.from(bytes));
      const [a, b] = [Number(m[1]), Number(m[2])];
      res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': b - a + 1 });
      res.end(Buffer.from(bytes.slice(a, b + 1)));
    });
    await new Promise((r) => file.listen(0, '127.0.0.1', r));
    const f = fakeOpenSubtitles();
    const subtitles = createSubtitles({ apiKey: 'K', fetch: f.fetchImpl, cacheDir: join(home, 'srv') });
    srv = await startServer({ port: 0, public: false, accounts: null, remux: false, subtitles, subsPerDay: 1 });
    srv.calls = f.calls;
  });
  afterAll(() => {
    srv.close();
    file.close();
  });

  it('says it has subtitles', async () => {
    expect((await (await fetch(at('/api/health'))).json()).subtitles).toBe(true);
  });
  it('searches, with a moviehash of the file', async () => {
    const res = await fetch(at('/api/subtitles'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'EN - Heat (1995)', url: `http://127.0.0.1:${file.address().port}/movie/1.mkv` }),
    });
    const r = await res.json();
    expect(res.status).toBe(200);
    expect(r.items[0].fileId).toBe(22);
    expect(r.moviehash).toMatch(/^[0-9a-f]{16}$/);
    expect(srv.calls.find((c) => c.path.endsWith('/subtitles')).search).toContain(`moviehash=${r.moviehash}`);
  });
  it('serves a file as WebVTT, shifted, and caps new downloads per viewer', async () => {
    const res = await fetch(at('/subs/11.vtt?shift=-1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/vtt');
    expect(await res.text()).toContain('00:00:00.500 --> 00:00:02.000');
    // The same file again is free; a new one is over today's 1.
    expect((await fetch(at('/subs/11.vtt'))).status).toBe(200);
    expect((await fetch(at('/subs/22.vtt'))).status).toBe(429);
  });
  it('answers 501 where there is no key', async () => {
    const s2 = await startServer({ port: 0, public: false, accounts: null, remux: false, subtitles: null });
    const r = await fetch(`http://127.0.0.1:${s2.address().port}/api/subtitles`, {
      method: 'POST',
      body: JSON.stringify({ title: 'x' }),
    });
    expect(r.status).toBe(501);
    s2.close();
  });
});
