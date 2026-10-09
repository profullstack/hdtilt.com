import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { matchChannels, normName, nowNext } from '../src/core/epg.js';
import { guideFor, loadGuide } from '../src/core/guide.js';
import { rewritePlaylist } from '../src/core/hls.js';
import { catchupUrl, channelsFromM3u, groupsOf, loadSource, streamKind } from '../src/core/sources.js';
import { b64urlDecode, proxyPath } from '../src/core/util.js';
import { gunzipIfNeeded, parseXmltv, parseXmltvTime } from '../src/core/xmltv.js';
import * as xtream from '../src/core/xtream.js';
import { fakeProvider } from './fixtures.js';

let P;
beforeAll(async () => (P = await fakeProvider()));
afterAll(() => P.close());

describe('M3U', () => {
  it('loads channels with guide attributes and the guide URL', async () => {
    const { channels, epgUrl } = await loadSource({ type: 'm3u', url: `${P.base}/list.m3u` });
    expect(epgUrl).toBe(`${P.base}/guide.xml.gz`);
    expect(channels).toHaveLength(3);
    expect(channels[0]).toMatchObject({
      id: 'news.test',
      name: 'News One',
      group: 'News',
      chno: 101,
      tvgId: 'news.test',
      kind: 'live',
    });
    expect(channels[1].group).toBe('Movies, Classics');
    // Two identical entries still get distinct ids.
    expect(new Set(channels.map((c) => c.id)).size).toBe(3);
    expect(groupsOf(channels)).toEqual([
      { name: 'News', count: 1 },
      { name: 'Movies, Classics', count: 2 },
    ]);
  });

  it('parses a pasted file', async () => {
    const { channels } = await channelsFromM3u('#EXTM3U\n#EXTINF:-1,A\nhttp://h/a.ts\n');
    expect(channels[0].name).toBe('A');
  });

  it('says so when a playlist is empty', async () => {
    await expect(loadSource({ type: 'm3u', url: `${P.base}/missing` })).rejects.toThrow('404');
  });
});

describe('Xtream', () => {
  const login = () => ({ type: 'xtream', server: P.base, username: 'u', password: 'pw' });
  it('loads live channels as the same channel shape', async () => {
    const r = await loadSource(login());
    expect(r.account).toMatchObject({ status: 'Active', maxConnections: 2 });
    expect(r.epgUrl).toBe(`${P.base}/xmltv.php?username=u&password=pw`);
    expect(r.channels[0]).toMatchObject({
      id: 'x55',
      name: 'Sport 1',
      group: 'Sports',
      tvgId: 'sport1.test',
      streamId: 55,
      catchup: { type: 'xc', days: 3 },
    });
    expect(r.channels[0].url).toBe(`${P.base}/live/u/pw/55.ts`);
  });
  it('refuses a bad login in words', async () => {
    await expect(loadSource({ ...login(), password: 'no' })).rejects.toThrow('refused');
  });
  it('recognises an Xtream line pasted as an M3U URL', () => {
    expect(xtream.loginFromM3uUrl('http://h:8080/get.php?username=a&password=b&type=m3u_plus')).toEqual({
      server: 'http://h:8080',
      username: 'a',
      password: 'b',
    });
  });
  it('decodes the short EPG', async () => {
    const list = await xtream.shortEpg({ server: P.base, username: 'u', password: 'pw' }, 55);
    expect(list[0]).toMatchObject({ title: 'Match', desc: 'Live' });
  });
  it('builds a timeshift URL in the panel time zone', () => {
    const u = xtream.timeshiftUrl(
      { server: 'http://h', username: 'u', password: 'p' },
      9,
      Date.UTC(2026, 9, 9, 20, 5),
      60,
      'UTC',
    );
    expect(u).toBe('http://h/timeshift/u/p/60/2026-10-09:20-05/9.ts');
  });
});

describe('XMLTV', () => {
  it('reads offsets', () => {
    expect(parseXmltvTime('20261009210000 +0100')).toBe(Date.UTC(2026, 9, 9, 20));
    expect(parseXmltvTime('20261009210000')).toBe(Date.UTC(2026, 9, 9, 21));
  });
  it('streams a gzipped guide, splitting anywhere, inside a window', async () => {
    const res = await fetch(`${P.base}/guide.xml.gz`);
    const body = new Uint8Array(await res.arrayBuffer());
    async function* tiny() {
      for (let i = 0; i < body.length; i += 13) yield body.slice(i, i + 13);
    }
    const g = await parseXmltv(gunzipIfNeeded(tiny()), { from: Date.now() - 86400_000 });
    expect(g.channels.get('film.test').names).toEqual(['Film & Co HD']);
    expect(g.channels.get('news.test').icon).toBe(`${P.base}/logo.png`);
    const film = g.programmes.get('film.test');
    expect(film.map((p) => p.title)).toEqual(['A <Film>']); // "Ancient" is outside the window
    const news = g.programmes.get('news.test');
    expect(news[1]).toMatchObject({ title: 'The Hour', desc: 'Headlines & weather.', category: 'News' });
  });
});

describe('guide matching', () => {
  it('matches by tvg-id, else by name', async () => {
    const { channels } = await loadSource({ type: 'm3u', url: `${P.base}/list.m3u` });
    const g = await loadGuide(`${P.base}/guide.xml.gz`);
    const map = matchChannels(channels, g.channels);
    expect(map.get('news.test')).toBe('news.test');
    expect(map.get(channels[1].id)).toBe('film.test'); // "Film & Co" ~ "Film & Co HD"
    const got = guideFor(g, channels);
    expect(nowNext(got['news.test']).now.title).toBe('The Hour');
    expect(nowNext(got['news.test']).next.title).toBe('Later');
  });
  it('normalises names', () => {
    expect(normName('BBC One HD')).toBe(normName('bbc one'));
  });
});

describe('streams', () => {
  it('picks an engine from the path, extensionless live = mpegts', () => {
    expect(streamKind('http://h/a.m3u8?x=1')).toBe('hls');
    expect(streamKind('http://h/live/u/p/1')).toBe('mpegts');
    expect(streamKind('http://h/movie/1.mkv', 'vod')).toBe('mp4');
  });
  it('keeps the extension on a proxy path', () => {
    const p = proxyPath('http://h/live/u/p/1', 'mpegts');
    expect(p.endsWith('/1.ts')).toBe(true);
    expect(b64urlDecode(p.split('/')[2])).toBe('http://h/live/u/p/1');
  });
  it('rewrites every URL in an HLS playlist, keys included', () => {
    const out = rewritePlaylist(
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.bin"\nseg.ts\n',
      'http://h/a/b.m3u8',
      (u) => `P(${u})`,
    );
    expect(out).toContain('URI="P(http://h/a/k.bin)"');
    expect(out).toContain('P(http://h/a/seg.ts)');
  });
  it('builds catch-up URLs from a template and for Xtream', () => {
    const ch = { url: 'http://h/live/1.m3u8', catchup: { type: 'default', source: '?utc={utc}&lutc={lutc}' } };
    expect(catchupUrl(ch, { type: 'm3u', url: 'x' }, 1000_000, 2000_000)).toMatch(
      /^http:\/\/h\/live\/1\.m3u8\?utc=1000&lutc=\d+$/,
    );
    const xc = { url: 'http://h/live/u/p/5.ts', streamId: 5, catchup: { type: 'xc' } };
    expect(
      catchupUrl(
        xc,
        { type: 'xtream', server: 'http://h', username: 'u', password: 'p' },
        Date.UTC(2026, 0, 1, 10),
        Date.UTC(2026, 0, 1, 11),
        'UTC',
      ),
    ).toBe('http://h/timeshift/u/p/60/2026-01-01:10-00/5.ts');
    expect(catchupUrl({ url: 'x' }, {}, 0, 1)).toBeNull();
  });
});
