// XMLTV guide parsing, streamed. No dependencies; runs in Node, Bun and the browser.
//
// Provider guides are routinely 50-300 MB of XML for a week of every channel
// they carry, so the file is never held: each chunk is scanned for complete
// <channel> and <programme> elements, which are pulled out and forgotten, and a
// programme outside the window the caller asked for is dropped on sight.

/**
 * @typedef {{ start: number, stop: number, title: string, desc?: string, category?: string, episode?: string }} Programme
 * @typedef {{ id: string, names: string[], icon?: string }} GuideChannel
 */

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3]) : undefined;
};

const text = (body, name) => {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(body);
  if (!m) return undefined;
  const raw = m[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1');
  return decodeEntities(raw).trim() || undefined;
};

/** `20261009213000 +0100` → epoch ms. A missing offset is UTC. */
export function parseXmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*([+-]\d{2}:?\d{2})?/.exec(String(s || '').trim());
  if (!m) return Number.NaN;
  const [, Y, Mo, D, h = '00', mi = '00', se = '00', off] = m;
  let t = Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +se);
  if (off) {
    const o = off.replace(':', '');
    const mins = (o[0] === '-' ? -1 : 1) * (Number(o.slice(1, 3)) * 60 + Number(o.slice(3, 5)));
    t -= mins * 60_000;
  }
  return t;
}

/**
 * Parse a guide.
 *
 * @param {AsyncIterable<Uint8Array|string>} chunks a fetch body, gzip already undone
 * @param {{ from?: number, to?: number, ids?: Set<string>|null, maxProgrammes?: number }} [opts]
 * @returns {Promise<{ channels: Map<string, GuideChannel>, programmes: Map<string, Programme[]>, count: number }>}
 */
export async function parseXmltv(chunks, opts = {}) {
  const from = opts.from ?? Number.NEGATIVE_INFINITY;
  const to = opts.to ?? Number.POSITIVE_INFINITY;
  const ids = opts.ids || null;
  const max = opts.maxProgrammes ?? 2_000_000;
  const channels = new Map();
  const programmes = new Map();
  let count = 0;
  let buf = '';
  const decoder = new TextDecoder('utf-8');

  const consume = (final) => {
    let pos = 0;
    for (;;) {
      const lt = buf.indexOf('<', pos);
      if (lt === -1) {
        pos = buf.length;
        break;
      }
      const isProg = buf.startsWith('<programme', lt);
      const isChan = !isProg && buf.startsWith('<channel', lt);
      if (!isProg && !isChan) {
        // Skip any other tag; it is either a wrapper or a child we already passed.
        const gt = buf.indexOf('>', lt);
        if (gt === -1) {
          pos = lt;
          break;
        }
        pos = gt + 1;
        continue;
      }
      const name = isProg ? 'programme' : 'channel';
      const gt = buf.indexOf('>', lt);
      if (gt === -1) {
        pos = lt;
        break;
      }
      const open = buf.slice(lt, gt + 1);
      let body = '';
      let end;
      if (open.endsWith('/>')) {
        end = gt + 1;
      } else {
        const close = buf.indexOf(`</${name}>`, gt);
        if (close === -1) {
          pos = lt;
          break;
        }
        body = buf.slice(gt + 1, close);
        end = close + name.length + 3;
      }
      pos = end;

      if (isChan) {
        const id = attr(open, 'id');
        if (!id) continue;
        const names = [...body.matchAll(/<display-name\b[^>]*>([\s\S]*?)<\/display-name>/gi)].map((m) =>
          decodeEntities(m[1]).trim(),
        );
        const iconTag = /<icon\b[^>]*>/i.exec(body)?.[0];
        const c = { id, names };
        const icon = iconTag && attr(iconTag, 'src');
        if (icon) c.icon = icon;
        channels.set(id, c);
        continue;
      }

      if (count >= max) continue;
      const ch = attr(open, 'channel');
      if (!ch || (ids && !ids.has(ch))) continue;
      const start = parseXmltvTime(attr(open, 'start'));
      const stop = parseXmltvTime(attr(open, 'stop')) || start + 30 * 60_000;
      if (!Number.isFinite(start) || stop < from || start > to) continue;
      const p = { start, stop, title: text(body, 'title') || 'Untitled' };
      const desc = text(body, 'desc');
      if (desc) p.desc = desc.length > 600 ? `${desc.slice(0, 597)}...` : desc;
      const cat = text(body, 'category');
      if (cat) p.category = cat;
      const ep = text(body, 'episode-num');
      if (ep) p.episode = ep;
      let list = programmes.get(ch);
      if (!list) programmes.set(ch, (list = []));
      list.push(p);
      count++;
    }
    buf = final ? '' : buf.slice(pos);
  };

  for await (const chunk of chunks) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    consume(false);
    // A single unclosed element larger than this is not a guide.
    if (buf.length > 8 * 1024 * 1024) throw new Error('XMLTV element too large');
  }
  buf += decoder.decode();
  consume(true);

  for (const list of programmes.values()) list.sort((a, b) => a.start - b.start);
  return { channels, programmes, count };
}

/** Bytes in, bytes out, with gzip undone when the stream starts with its magic. */
export async function* gunzipIfNeeded(chunks) {
  const it = chunks[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) return;
  const head = first.value;
  const gz = typeof head !== 'string' && head[0] === 0x1f && head[1] === 0x8b;
  async function* rest() {
    yield head;
    for (;;) {
      const n = await it.next();
      if (n.done) return;
      yield n.value;
    }
  }
  if (!gz) {
    yield* rest();
    return;
  }
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  (async () => {
    try {
      for await (const c of rest()) await writer.write(c);
      await writer.close();
    } catch (e) {
      writer.abort(e).catch(() => {});
    }
  })();
  const reader = ds.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}
