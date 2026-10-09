// A fake provider: an M3U, a gzipped XMLTV guide, an Xtream panel, an HLS
// playlist and a "transport stream", all on 127.0.0.1.
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

const pad = (n) => String(n).padStart(2, '0');
export const xmltvTime = (t) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00 +0000`;
};

export async function fakeProvider() {
  const now = Date.now();
  const hour = Math.floor(now / 3600_000) * 3600_000;
  let base = '';
  const guide = () => `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="test">
  <channel id="news.test"><display-name>News One</display-name><icon src="${base}/logo.png"/></channel>
  <channel id="film.test"><display-name lang="en">Film &amp; Co HD</display-name></channel>
  <programme start="${xmltvTime(hour - 3600_000)}" stop="${xmltvTime(hour)}" channel="news.test"><title>Earlier News</title></programme>
  <programme start="${xmltvTime(hour)}" stop="${xmltvTime(hour + 3600_000)}" channel="news.test"><title lang="en">The Hour</title><desc>Headlines &amp; weather.</desc><category>News</category></programme>
  <programme start="${xmltvTime(hour + 3600_000)}" stop="${xmltvTime(hour + 7200_000)}" channel="news.test"><title>Later</title></programme>
  <programme start="${xmltvTime(hour)}" stop="${xmltvTime(hour + 7200_000)}" channel="film.test"><title><![CDATA[A <Film>]]></title></programme>
  <programme start="20000101000000 +0000" stop="20000101010000 +0000" channel="film.test"><title>Ancient</title></programme>
</tv>`;
  const m3u = () => `#EXTM3U url-tvg="${base}/guide.xml.gz"
#EXTINF:-1 tvg-id="news.test" tvg-logo="${base}/logo.png" tvg-chno="101" group-title="News" catchup="default" catchup-days="2",News One
${base}/live/news.ts
#EXTINF:-1 group-title="Movies, Classics",Film & Co
${base}/hls/film.m3u8
#EXTINF:-1 group-title="Movies, Classics",Film & Co
${base}/hls/film2.m3u8
`;
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/list.m3u') return res.end(m3u());
    if (u.pathname === '/guide.xml.gz') {
      res.setHeader('content-type', 'application/gzip');
      return res.end(gzipSync(guide()));
    }
    if (u.pathname === '/logo.png') {
      res.setHeader('content-type', 'image/png');
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
    if (u.pathname === '/hls/film.m3u8') {
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      return res.end(
        '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\nseg1.ts\n#EXTINF:4,\nhttp://cdn.invalid/abs.ts\n',
      );
    }
    if (u.pathname.startsWith('/live/')) {
      res.setHeader('content-type', 'video/mp2t');
      return res.end(Buffer.alloc(188 * 4, 0x47));
    }
    if (u.pathname === '/player_api.php') {
      if (u.searchParams.get('password') !== 'pw') return res.end(JSON.stringify({ user_info: { auth: 0 } }));
      const a = u.searchParams.get('action');
      res.setHeader('content-type', 'application/json');
      if (!a)
        return res.end(
          JSON.stringify({
            user_info: {
              auth: 1,
              status: 'Active',
              exp_date: '1900000000',
              max_connections: '2',
              active_cons: '0',
              allowed_output_formats: ['m3u8', 'ts'],
            },
            server_info: { timezone: 'UTC' },
          }),
        );
      if (a === 'get_live_categories') return res.end(JSON.stringify([{ category_id: '7', category_name: 'Sports' }]));
      if (a === 'get_live_streams')
        return res.end(
          JSON.stringify([
            {
              num: 1,
              name: 'Sport 1',
              stream_id: 55,
              stream_icon: '',
              epg_channel_id: 'sport1.test',
              category_id: '7',
              tv_archive: 1,
              tv_archive_duration: 3,
            },
          ]),
        );
      if (a === 'get_short_epg')
        return res.end(
          JSON.stringify({
            epg_listings: [
              {
                title: btoa('Match'),
                description: btoa('Live'),
                start_timestamp: String((now / 1000) | 0),
                stop_timestamp: String(((now / 1000) | 0) + 3600),
              },
            ],
          }),
        );
    }
    res.statusCode = 404;
    res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return { base, server, hour, close: () => server.close() };
}
