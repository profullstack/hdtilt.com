// Subtitles on a film or an episode: the CC button opens a panel of what
// OpenSubtitles has in the chosen language, best match first, and the pick
// becomes a <track> on the video.
//
// The server converts and shifts the file (/subs/<id>.vtt?shift=), so this
// side never parses a cue. A converted film's clock starts where its ffmpeg
// session started (`offset`), so the cues are moved back by that much; after a
// seek past the converted part the track is fetched again with the new shift,
// from the server's disk cache, which costs no download.

import * as api from './data.js';
import * as store from './store.js';

// Common first, then alphabetical by name. OpenSubtitles codes (pt-BR is pt-br).
export const LANGS = [
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['pt-br', 'Portuguese (Brazil)'],
  ['pt-pt', 'Portuguese'],
  ['it', 'Italian'],
  ['ar', 'Arabic'],
  ['bg', 'Bulgarian'],
  ['zh-cn', 'Chinese (simplified)'],
  ['zh-tw', 'Chinese (traditional)'],
  ['hr', 'Croatian'],
  ['cs', 'Czech'],
  ['da', 'Danish'],
  ['nl', 'Dutch'],
  ['fi', 'Finnish'],
  ['el', 'Greek'],
  ['he', 'Hebrew'],
  ['hi', 'Hindi'],
  ['hu', 'Hungarian'],
  ['id', 'Indonesian'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['ms', 'Malay'],
  ['no', 'Norwegian'],
  ['fa', 'Persian'],
  ['pl', 'Polish'],
  ['ro', 'Romanian'],
  ['ru', 'Russian'],
  ['sr', 'Serbian'],
  ['sk', 'Slovak'],
  ['sl', 'Slovenian'],
  ['sv', 'Swedish'],
  ['th', 'Thai'],
  ['tr', 'Turkish'],
  ['uk', 'Ukrainian'],
  ['vi', 'Vietnamese'],
];

/** The language to look in first: the last one picked, else the browser's. */
export function defaultLang(nav = globalThis.navigator) {
  const saved = store.prefs.read('subLang', '');
  if (saved) return saved;
  const l = String(nav?.language || 'en').toLowerCase();
  if (l === 'pt-br' || l.startsWith('pt-br')) return 'pt-br';
  if (l.startsWith('pt')) return 'pt-pt';
  if (l.startsWith('zh')) return /tw|hk|hant/.test(l) ? 'zh-tw' : 'zh-cn';
  const two = l.slice(0, 2);
  return LANGS.some(([c]) => c === two) ? two : 'en';
}

/**
 * What to ask OpenSubtitles about the title playing. An episode is its show +
 * season + episode (the show's TMDB id when the panel gave one); a film is its
 * TMDB id, else its name and year. `url` lets the server hash the file.
 */
export function askFor(item, show, lang) {
  if (!item) return null;
  const ep = item.season != null && item.episode != null;
  const ask = { languages: lang, url: item.url };
  if (ep) {
    Object.assign(ask, {
      title: show?.name || item.show?.name || item.group || item.name,
      season: item.season,
      episode: item.episode,
    });
    const tmdb = show?.tmdbId || item.show?.tmdbId;
    if (tmdb) ask.tmdbId = tmdb;
  } else {
    Object.assign(ask, { title: item.name, year: item.year || undefined });
    if (item.tmdbId) ask.tmdbId = item.tmdbId;
  }
  return ask;
}

// What a title was watched with, so resuming it brings its subtitles back.
const PICKS = 'subsFor';
const picks = () => store.prefs.read(PICKS, {});
export function rememberPick(itemId, pick) {
  const all = picks();
  delete all[itemId];
  if (pick) all[itemId] = pick;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete all[k];
  store.prefs.write(PICKS, all);
}
export const pickFor = (itemId) => picks()[itemId] || null;

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const short = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

/**
 * @param {{ video: HTMLVideoElement, panel: HTMLElement, now: () => ({ item, show, offset } | null),
 *   onToggle?: (open: boolean) => void, toast?: (t: string) => void }} deps
 */
export function createSubs({ video, panel, now, onToggle = () => {}, toast = () => {} }) {
  const st = {
    itemId: null, // the title the state below belongs to
    pick: null, // { fileId, lang, label }
    delay: 0, // seconds, + = later
    lang: defaultLang(),
    results: null, // for st.itemId + st.lang
    resultsKey: '',
    loading: false,
    error: '',
    focus: 0,
    seq: 0,
  };

  const track = () => video.querySelector('track[data-subs]');

  // While the banner and controls are up they cover the bottom of the picture,
  // where cues go: move them up a few lines (cue.line works in every engine).
  const LIFT = -5;
  function lift() {
    const cues = track()?.track.cues;
    if (!cues) return;
    const up = document.body.classList.contains('chrome-on');
    for (const c of cues) c.line = up ? LIFT : 'auto';
  }
  new MutationObserver(lift).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  function removeTrack() {
    const t = track();
    if (t) {
      t.track.mode = 'disabled';
      t.remove();
    }
  }

  /** Put the picked subtitle on the video, shifted for the current offset and delay. */
  function apply() {
    removeTrack();
    const cur = now();
    if (!st.pick || !cur) return;
    const t = document.createElement('track');
    t.dataset.subs = '1';
    t.kind = 'subtitles';
    t.label = st.pick.label || st.pick.lang;
    t.srclang = st.pick.lang.slice(0, 2);
    t.src = api.subtitleUrl(st.pick.fileId, st.delay - (cur.offset || 0));
    t.default = true;
    t.addEventListener('error', () => {
      // The error body (quota, sign-in) is not readable from a <track>; ask again to say why.
      fetch(t.src, { credentials: 'same-origin' })
        .then(async (r) => !r.ok && toast(await r.text()))
        .catch(() => {});
    });
    video.appendChild(t);
    // Some engines leave a new track hidden even with default set.
    const show = () => {
      for (const tt of video.textTracks)
        tt.mode = tt === t.track ? 'showing' : tt.mode === 'showing' ? 'disabled' : tt.mode;
    };
    show();
    t.addEventListener(
      'load',
      () => {
        show();
        lift();
      },
      { once: true },
    );
  }

  /** A new title started, or the same one restarted at a new offset. */
  function attach() {
    const cur = now();
    if (!cur) return;
    if (cur.item.id !== st.itemId) {
      st.itemId = cur.item.id;
      st.results = null;
      st.resultsKey = '';
      st.error = '';
      const saved = pickFor(cur.item.id);
      st.pick = saved ? { fileId: saved.fileId, lang: saved.lang, label: saved.label } : null;
      st.delay = saved?.delay || 0;
    }
    apply();
    render();
  }

  /** Playing stopped being a film: nothing on the video. */
  function detach() {
    st.itemId = null;
    st.pick = null;
    removeTrack();
    close();
  }

  async function load() {
    const cur = now();
    if (!cur) return;
    const ask = askFor(cur.item, cur.show, st.lang);
    const key = `${cur.item.id}|${st.lang}`;
    if (st.resultsKey === key && st.results) return render();
    const mine = ++st.seq;
    st.loading = true;
    st.error = '';
    st.results = null;
    render();
    try {
      const r = await api.subtitles(ask);
      if (mine !== st.seq) return;
      st.results = r.items || [];
      st.resultsKey = key;
    } catch (e) {
      if (mine !== st.seq) return;
      st.error = e.message || String(e);
    }
    st.loading = false;
    render();
  }

  const isOpen = () => !panel.hidden;

  function open() {
    if (!now()) return;
    panel.hidden = false;
    st.focus = 0;
    onToggle(true);
    render();
    load();
    focusRow();
  }

  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    onToggle(false);
  }

  function choose(r) {
    const cur = now();
    if (!cur) return;
    if (!r) {
      st.pick = null;
      rememberPick(cur.item.id, null);
      apply();
      render();
      return toast('Subtitles off');
    }
    st.pick = { fileId: r.fileId, lang: r.language || st.lang, label: labelOf(r.language || st.lang) };
    st.delay = 0;
    rememberPick(cur.item.id, { ...st.pick, delay: 0 });
    apply();
    render();
    close();
  }

  function nudge(by) {
    const cur = now();
    st.delay = Math.round((st.delay + by) * 10) / 10;
    if (cur && st.pick) rememberPick(cur.item.id, { ...st.pick, delay: st.delay });
    apply();
    render();
  }

  const labelOf = (code) => LANGS.find(([c]) => c === code)?.[1] || code.toUpperCase();

  function render() {
    if (panel.hidden) return;
    const rows = st.results || [];
    const status = st.loading
      ? 'Looking…'
      : st.error
        ? esc(st.error)
        : st.results && !rows.length
          ? `None in ${esc(labelOf(st.lang))}. Try another language.`
          : '';
    panel.innerHTML = `
      <header><h3>Subtitles</h3><button type="button" class="close-btn" data-s="close" aria-label="Close subtitles">✕</button></header>
      <div class="subs-bar">
        <select data-s="lang" aria-label="Language">${LANGS.map(([c, n]) => `<option value="${c}"${c === st.lang ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>
        ${
          st.pick
            ? `<span class="subs-sync" title="Move the subtitles if they come too early or too late">
                <button type="button" data-s="earlier" aria-label="Subtitles earlier">−½s</button>
                <span>${st.delay > 0 ? '+' : ''}${st.delay.toFixed(1)}s</span>
                <button type="button" data-s="later" aria-label="Subtitles later">+½s</button></span>`
            : ''
        }
      </div>
      <div class="subs-list" role="listbox">
        <button type="button" class="subs-row${st.pick ? '' : ' cur'}" data-i="-1" role="option" aria-selected="${!st.pick}"><span class="subs-rel">Off</span></button>
        ${rows
          .map(
            (
              r,
              i,
            ) => `<button type="button" class="subs-row${st.pick?.fileId === r.fileId ? ' cur' : ''}" data-i="${i}" role="option" aria-selected="${st.pick?.fileId === r.fileId}">
              <span class="subs-rel">${esc(r.release || r.fileName || 'Untitled')}</span>
              <span class="subs-meta">${r.hashMatch ? '<b class="tag">THIS FILE</b>' : ''}${r.hearingImpaired ? '<b class="tag">CC</b>' : ''}${r.trusted ? '<b class="tag">TRUSTED</b>' : ''}${r.aiTranslated ? '<b class="tag">AI</b>' : ''}<span>⬇ ${short(r.downloads)}</span></span>
            </button>`,
          )
          .join('')}
      </div>
      ${status ? `<p class="subs-status">${status}</p>` : ''}
      <p class="subs-credit">From <a href="https://www.opensubtitles.com" target="_blank" rel="noopener">OpenSubtitles</a></p>`;
    focusRow(false);
  }

  const rowsEls = () => [...panel.querySelectorAll('.subs-row')];
  function focusRow(scroll = true) {
    const els = rowsEls();
    if (!els.length) return;
    st.focus = Math.max(0, Math.min(st.focus, els.length - 1));
    if (panel.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
    els[st.focus].focus({ preventScroll: !scroll });
    if (scroll) els[st.focus].scrollIntoView({ block: 'nearest' });
  }

  panel.addEventListener('click', (e) => {
    e.stopPropagation();
    const b = e.target.closest('[data-s], [data-i]');
    if (!b) return;
    if (b.dataset.s === 'close') return close();
    if (b.dataset.s === 'earlier') return nudge(-0.5);
    if (b.dataset.s === 'later') return nudge(0.5);
    if (b.dataset.i != null) {
      const i = Number(b.dataset.i);
      st.focus = i + 1;
      choose(i < 0 ? null : st.results?.[i]);
    }
  });
  panel.addEventListener('change', (e) => {
    if (e.target.dataset.s !== 'lang') return;
    st.lang = e.target.value;
    store.prefs.write('subLang', st.lang);
    load();
  });
  // Over the picture, a click outside the panel closes it.
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());

  /** Keys while the panel is open: Up/Down through the rows, OK picks, Back closes. True if used. */
  function key(e) {
    if (!isOpen()) return false;
    const k = e.key;
    if (e.target.tagName === 'SELECT') {
      if (k === 'Escape' || k === 'GoBack') {
        e.target.blur();
        focusRow();
        e.preventDefault();
        return true;
      }
      if (k === 'ArrowDown' && !e.altKey) {
        // Down on a closed select moves on to the list (a remote has no other way out).
        e.target.blur();
        st.focus = 0;
        focusRow();
        e.preventDefault();
        return true;
      }
      return true;
    }
    const n = rowsEls().length;
    if (k === 'ArrowDown') st.focus = Math.min(n - 1, st.focus + 1);
    else if (k === 'ArrowUp') {
      if (st.focus === 0) {
        panel.querySelector('select')?.focus();
        e.preventDefault();
        return true;
      }
      st.focus = Math.max(0, st.focus - 1);
    } else if (k === 'ArrowLeft' && st.pick) nudge(-0.5);
    else if (k === 'ArrowRight' && st.pick) nudge(0.5);
    else if (k === 'Enter' || k === ' ') {
      if (document.activeElement?.closest?.('[data-s]')) return false; // its own click
      const i = st.focus - 1;
      choose(i < 0 ? null : st.results?.[i]);
    } else if (k === 'Escape' || k === 'GoBack' || k === 'BrowserBack' || k === 'c') close();
    else return false;
    e.preventDefault();
    if (isOpen()) focusRow();
    return true;
  }

  return {
    attach,
    detach,
    open,
    close,
    toggle: () => (isOpen() ? close() : open()),
    isOpen,
    key,
    get on() {
      return Boolean(st.pick);
    },
  };
}
