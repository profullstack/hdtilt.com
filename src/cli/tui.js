// The terminal guide: groups | channels with what is on | the programme.
// Enter plays in mpv/VLC. Same layout as the TV screen, minus the picture.

import { createApp } from '@profullstack/hqtui';
import { channelsFor, findChannels, readConfig, writeConfig } from '../core/config.js';
import { progress } from '../core/epg.js';
import { loadGuide, nowNextFor } from '../core/guide.js';
import { groupsOf } from '../core/sources.js';
import { play } from './player.js';
import { pushQuietly } from './sync.js';

const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);
const ALL = 'All channels';
const FAV = '★ Favorites';

export async function runTui({ playlist } = {}) {
  // Signed in with `hdtilt login`: take the account's playlists and favorites
  // first, but never let a slow network hold the guide back.
  await Promise.race([pushQuietly(), new Promise((r) => setTimeout(r, 4000))]);
  let pl = await channelsFor(playlist);
  const cfg = await readConfig();
  const favs = new Set(cfg.favorites[pl.name] || []);
  let guide = null;
  let nn = {};
  let status = pl.epgUrl ? 'Loading guide…' : 'No guide for this playlist';

  const live = () => pl.channels.filter((c) => c.kind === 'live');
  const groupNames = () => [FAV, ALL, ...groupsOf(live()).map((g) => g.name)];
  let groups = groupNames();
  let gi = favs.size ? 0 : 1;
  let ci = 0;
  let pane = 1; // 0 groups, 1 channels
  let query = '';
  let searching = false;

  const visible = () => {
    const g = groups[gi];
    let list = live();
    if (g === FAV) list = list.filter((c) => favs.has(c.id));
    else if (g !== ALL) list = list.filter((c) => c.group === g);
    return query ? findChannels(list, query) : list;
  };

  const refreshNowNext = () => {
    if (guide) nn = nowNextFor(guide, visible().slice(0, 2000));
  };

  if (pl.epgUrl) {
    loadGuide(pl.epgUrl)
      .then((g) => {
        guide = g;
        status = `Guide: ${g.count.toLocaleString()} programmes`;
        refreshNowNext();
        app.invalidate();
      })
      .catch((e) => {
        status = `Guide failed: ${e.message}`;
        app.invalidate();
      });
  }

  const app = await createApp({ quitKeys: ['ctrl+c'] });

  app.on('key', async (e) => {
    const list = visible();
    if (searching) {
      if (e.name === 'escape') {
        searching = false;
        query = '';
      } else if (e.name === 'enter') searching = false;
      else if (e.name === 'backspace') query = query.slice(0, -1);
      else if (e.key && e.key.length === 1) query += e.key;
      ci = 0;
      refreshNowNext();
      return;
    }
    switch (e.name) {
      case 'up':
        if (pane === 0) (gi = Math.max(0, gi - 1)), (ci = 0), refreshNowNext();
        else ci = Math.max(0, ci - 1);
        return;
      case 'down':
        if (pane === 0) (gi = Math.min(groups.length - 1, gi + 1)), (ci = 0), refreshNowNext();
        else ci = Math.min(list.length - 1, ci + 1);
        return;
      case 'pageup':
        ci = Math.max(0, ci - 20);
        return;
      case 'pagedown':
        ci = Math.min(list.length - 1, ci + 20);
        return;
      case 'left':
        pane = 0;
        return;
      case 'right':
        pane = 1;
        return;
      case 'enter': {
        if (pane === 0) {
          pane = 1;
          return;
        }
        const ch = list[ci];
        if (!ch) return;
        try {
          const { player } = play(ch.url, ch.name);
          status = `Playing ${ch.name} in ${player}`;
          const c = await readConfig();
          c.recent = [ch.id, ...(c.recent || []).filter((x) => x !== ch.id)].slice(0, 30);
          await writeConfig(c);
        } catch (err) {
          status = err.message;
        }
        app.invalidate();
        return;
      }
    }
    if (e.key === 'q') return app.quit();
    if (e.key === '/') {
      searching = true;
      query = '';
      return;
    }
    if (e.key === 'f') {
      const ch = list[ci];
      if (!ch) return;
      favs.has(ch.id) ? favs.delete(ch.id) : favs.add(ch.id);
      const c = await readConfig();
      c.favorites[pl.name] = [...favs];
      await writeConfig(c);
      pushQuietly();
      status = favs.has(ch.id) ? `★ ${ch.name}` : `Removed ${ch.name} from favorites`;
      app.invalidate();
      return;
    }
    if (e.key === 'r') {
      status = 'Refreshing playlist…';
      app.invalidate();
      pl = await channelsFor(pl.name, { refresh: true });
      groups = groupNames();
      status = `${pl.channels.length} channels`;
      refreshNowNext();
      app.invalidate();
    }
  });

  app.render(({ ui }) => {
    const list = visible();
    const sel = list[ci];
    const cur = sel && nn[sel.id];
    ui.column({}, (col) => {
      col.row({ size: '1fr' }, (row) => {
        row.panel({ title: 'Groups', width: 28, focused: pane === 0 }, (p) => {
          p.list({ items: groups, selected: gi, followSelection: true, scrollbar: true });
        });
        row.panel(
          {
            title: searching || query ? `Search: ${query}${searching ? '▏' : ''}` : groups[gi],
            subtitle: `${list.length}`,
            size: '1fr',
            focused: pane === 1,
          },
          (p) => {
            p.list({
              selected: ci,
              followSelection: true,
              scrollbar: true,
              items: list.map((c) => {
                const now = nn[c.id]?.now;
                const no = c.chno != null ? `${String(c.chno).padStart(4)}  ` : '';
                const star = favs.has(c.id) ? '★ ' : '';
                return { label: `${no}${star}${c.name}${now ? `  ·  ${now.title}` : ''}` };
              }),
            });
          },
        );
        row.panel({ title: sel ? sel.name : 'Programme', width: 44 }, (p) => {
          if (!sel) return p.text('No channels here.');
          if (cur?.now) {
            p.text(`${hhmm(cur.now.start)}–${hhmm(cur.now.stop)}  ${cur.now.title}`);
            p.progress({ value: progress(cur.now) });
            if (cur.now.desc) p.text(cur.now.desc, { wrap: true });
          } else p.text(guide ? 'No guide data for this channel.' : status);
          if (cur?.next) p.text(`\nNext  ${hhmm(cur.next.start)}  ${cur.next.title}`);
          p.text(`\n${sel.group}${sel.catchup ? '  ·  catch-up' : ''}`);
        });
      });
      col.statusBar({
        items: [
          { key: '↑↓', label: 'Move' },
          { key: '←→', label: 'Pane' },
          { key: 'Enter', label: 'Play' },
          { key: '/', label: 'Search' },
          { key: 'f', label: 'Favorite' },
          { key: 'r', label: 'Refresh' },
          { key: 'q', label: 'Quit' },
        ],
        right: [{ label: `${pl.name} · ${status}` }],
      });
    });
  });

  await app.start();
}
