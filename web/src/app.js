// hdtilt web: a TV screen. The picture is always there; everything else is an
// overlay that a remote, a keyboard, a mouse or a finger can drive.

import { attachSource, isTvBrowser } from '@profullstack/player';
import { indexAt, nowNext, progress } from '../../src/core/epg.js';
import { catchupUrl, groupsOf } from '../../src/core/sources.js';
import { proxyPath } from '../../src/core/util.js';
import * as account from './account.js';
import * as api from './data.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const isTv = isTvBrowser(navigator.userAgent);

const FAV = '★ Favorites';
const RECENT = '↺ Recent';
const ALL = 'All channels';
const CH_TTL = 12 * 3600_000;

const S = {
  playlists: [], // [{ id, name, source }]
  pl: null, // current playlist
  data: null, // { channels, epgUrl, source, account }
  live: [],
  byId: new Map(),
  groups: [],
  favs: new Set(),
  recent: [],
  group: ALL,
  view: [], // channels in the open group
  focus: 0, // index in view
  groupFocus: 0,
  pane: 'channels', // or 'groups'
  mode: 'tv', // tv | list | guide | sheet
  playing: null,
  previous: null,
  query: '',
  epg: new Map(), // channel id -> programmes
  epgAsked: new Set(),
  attached: null,
  catchup: null, // { programme } when playing an archive
};

/* ---------------------------------------------------------------- boot */

async function boot() {
  if ('serviceWorker' in navigator && location.protocol === 'https:')
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  tick();
  setInterval(tick, 15_000);
  await api.health();
  S.playlists = await store.get('playlists', []);
  // A desktop or self-hosted install can see what `hdtilt add` saved.
  const saved = await api.savedPlaylists();
  for (const s of saved) {
    if (!S.playlists.some((p) => p.source.type === 'saved' && p.source.name === s.name)) {
      S.playlists.push({ id: `saved:${s.name}`, name: s.name, source: { type: 'saved', name: s.name } });
    }
  }
  account.attachSync(collectLibrary, mergeLibrary);
  account.onChange(updateNavAccount);
  updateNavAccount();
  // A new device that is signed in starts with the account's playlists.
  if (!S.playlists.length && account.current()) await account.syncNow().catch(() => {});
  const cur = store.prefs.read('current', null);
  const pl = S.playlists.find((p) => p.id === cur) || S.playlists[0];
  if (account.current()) account.syncNow().catch(() => {});
  // A deep link to a channel plays that one rather than the last one watched.
  const linked = /^\/watch\/([^/]+)/.exec(location.pathname)?.[1];
  if (pl) await usePlaylist(pl, { channelId: linked ? decodeURIComponent(linked) : null });
  if (await handleRoute()) return;
  if (!pl && !/^\/(account|settings)/.test(location.pathname)) return go('/settings/add', { replace: true });
  render(location.pathname + location.search);
}

async function usePlaylist(pl, { refresh = false, channelId = null } = {}) {
  S.pl = pl;
  store.prefs.write('current', pl.id);
  stageMsg(`Loading ${esc(pl.name)}…`);
  const cached = await store.get(`ch:${pl.id}`);
  if (cached && !refresh) {
    setData(cached.data);
    if (Date.now() - cached.at > CH_TTL) loadFresh(pl).catch(() => {});
  } else {
    try {
      await loadFresh(pl);
    } catch (e) {
      stageMsg(`<strong>Could not load ${esc(pl.name)}</strong>${esc(e.message)}`);
      return openSettings();
    }
  }
  S.favs = new Set(await store.get(`fav:${pl.id}`, []));
  S.recent = await store.get(`recent:${pl.id}`, []);
  buildGroups();
  const last = S.byId.get(channelId) || S.byId.get(store.prefs.read(`last:${pl.id}`, null)) || S.live[0];
  if (last) play(last);
  else stageMsg('<strong>No live channels in this playlist</strong>');
}

async function loadFresh(pl) {
  const data = await api.load(pl.source);
  const keep = {
    channels: data.channels,
    epgUrl: data.epgUrl,
    source: data.source || pl.source,
    account: data.account || null,
  };
  await store.set(`ch:${pl.id}`, { at: Date.now(), data: keep });
  if (S.pl?.id === pl.id) {
    setData(keep);
    buildGroups();
  }
  return keep;
}

function setData(data) {
  S.data = data;
  const live = data.channels.filter((c) => c.kind === 'live');
  S.live = live.length ? live : data.channels;
  S.byId = new Map(S.live.map((c) => [c.id, c]));
  S.epg.clear();
  S.epgAsked.clear();
}

function buildGroups() {
  const names = groupsOf(S.live).map((g) => ({ name: g.name, count: g.count }));
  S.groups = [
    { name: FAV, count: S.favs.size },
    { name: RECENT, count: S.recent.length },
    { name: ALL, count: S.live.length },
    ...names,
  ];
  if (!S.groups.some((g) => g.name === S.group)) S.group = ALL;
  setView();
  // The list may have been opened while channels were still loading.
  if (S.mode === 'list') {
    renderGroups();
    renderHead();
    renderChannels(true);
  }
}

/** The channels of the current group, before any filter. */
function groupList() {
  if (S.group === FAV) return S.live.filter((c) => S.favs.has(c.id));
  if (S.group === RECENT) return S.recent.map((id) => S.byId.get(id)).filter(Boolean);
  if (S.group === ALL) return S.live;
  return S.live.filter((c) => c.group === S.group);
}

/** Name contains it, or it is the channel number. */
function filterChannels(list, query) {
  if (!query) return list;
  const q = query.toLowerCase();
  const n = /^\d+$/.test(q) ? Number(q) : null;
  return list.filter((c) => c.name.toLowerCase().includes(q) || (n != null && c.chno === n));
}

function setView() {
  const list = filterChannels(groupList(), S.query);
  S.view = list;
  S.focus = Math.max(
    0,
    list.findIndex((c) => c.id === S.playing?.id),
  );
}

/* -------------------------------------------------------------- playback */

async function play(ch, { viaProxy = false, url = null, programme = null } = {}) {
  if (!ch) return;
  if (S.playing && S.playing.id !== ch.id) S.previous = S.playing;
  S.playing = ch;
  S.catchup = programme ? { programme } : null;
  store.prefs.write(`last:${S.pl.id}`, ch.id);
  if (S.mode === 'tv' && /^\/(watch\/|$)/.test(location.pathname)) history.replaceState(history.state, '', watchPath());
  S.recent = [ch.id, ...S.recent.filter((id) => id !== ch.id)].slice(0, 40);
  store.set(`recent:${S.pl.id}`, S.recent);
  account.changed();
  showBanner();
  stageMsg('');
  S.attached?.destroy();
  S.attached = null;
  const video = $('video');
  video.removeAttribute('src');
  const target = api.playable(iosUrl(url || ch.url), { viaProxy });
  const mine = {};
  S.current = mine;
  let failed = false;
  const onError = (msg) => {
    if (S.current !== mine || failed) return;
    failed = true;
    // Direct playback fails on CORS long before it fails on anything else.
    if (!target.proxied && !viaProxy) return play(ch, { viaProxy: true, url, programme });
    stageMsg(`<strong>Can't play ${esc(ch.name)}</strong>${esc(msg)}`);
  };
  try {
    const att = await attachSource(video, {
      src: target.src,
      kind: target.kind,
      live: !programme,
      isTv,
      onError,
      onNotice: (m) => S.current === mine && m && stageMsg(esc(m)),
      unplayableAdvice: 'Try it in VLC or mpv: copy the stream URL from Settings.',
    });
    if (S.current !== mine) return att.destroy();
    S.attached = att;
    // A direct stream that never starts is almost always CORS refusing it
    // quietly (mpegts.js reports that as "reconnecting", not as an error).
    if (!target.proxied) {
      setTimeout(() => {
        if (S.current === mine && !failed && video.readyState < 2) onError('no picture yet');
      }, 9000);
    }
    video.play().catch(() => {
      // Autoplay with sound refused: start muted and say so.
      video.muted = true;
      video.play().catch(() => {});
      stageMsg('Muted by the browser — press M or tap to unmute');
    });
  } catch (e) {
    onError(e.message || String(e));
  }
  if (S.mode === 'list') renderChannels();
}

/**
 * An Xtream line that also serves HLS gives Safari on iPhone the .m3u8 of the
 * same channel, so nothing has to be converted on the server.
 */
function iosUrl(url) {
  const formats = S.data?.account?.formats || [];
  if (api.canMse() || !formats.includes('m3u8')) return url;
  return url.replace(/(\/live\/[^/]+\/[^/]+\/\d+)\.ts(\?|$)/, '$1.m3u8$2');
}

function zap(step) {
  const list = S.view.length && S.view.includes(S.playing) ? S.view : S.live;
  const i = list.indexOf(S.playing);
  const next = list[(i + step + list.length) % list.length];
  play(next);
}

function stageMsg(html) {
  const m = $('stage-msg');
  m.innerHTML = html;
  m.hidden = !html;
}

$('video').addEventListener('playing', () => stageMsg(''));

/* ------------------------------------------------------------------ guide data */

const GUIDE_BACK = 6 * 3600_000;
const GUIDE_AHEAD = 18 * 3600_000;

async function ensureEpg(channels) {
  if (!S.data?.epgUrl) return;
  const want = channels.filter((c) => !S.epgAsked.has(c.id)).slice(0, 400);
  if (!want.length) return;
  for (const c of want) S.epgAsked.add(c.id);
  try {
    const now = Date.now();
    const got = await api.guide(S.data.epgUrl, want, now - GUIDE_BACK, now + GUIDE_AHEAD);
    for (const [id, list] of Object.entries(got)) S.epg.set(id, list);
    if (S.mode === 'list') renderChannels();
    if (S.mode === 'guide') renderGuide();
    if (!$('banner').hidden) showBanner(false);
  } catch {
    for (const c of want) S.epgAsked.delete(c.id);
  }
}

// Programmes roll over; ask again every half hour.
setInterval(() => S.epgAsked.clear(), 30 * 60_000);

const nn = (ch) => nowNext(S.epg.get(ch.id), Date.now());

/* --------------------------------------------------------------- banner */

let bannerTimer = 0;
function showBanner(autohide = true) {
  const ch = S.playing;
  if (!ch) return;
  ensureEpg([ch]);
  const b = $('banner');
  const { now, next } = S.catchup ? { now: S.catchup.programme, next: null } : nn(ch);
  $('banner-info').innerHTML = `
    ${logo(ch, 'logo')}
    <div>
      <div><span class="no">${ch.chno ?? ''}</span> <span class="name">${esc(ch.name)}</span></div>
      ${now ? `<div class="now">${esc(now.title)} <span class="times">${hhmm(now.start)} – ${hhmm(now.stop)}</span></div>` : `<div class="now times">${S.data?.epgUrl ? 'No programme information' : esc(ch.group)}</div>`}
      ${now && !S.catchup ? `<div class="bar"><i style="width:${(progress(now) * 100).toFixed(1)}%"></i></div>` : ''}
      ${next ? `<div class="next">Next: ${hhmm(next.start)} ${esc(next.title)}</div>` : ''}
    </div>
    <div class="tags">${S.catchup ? '<span class="tag">CATCH-UP</span>' : '<span class="tag live">LIVE</span>'}<button type="button" class="fav-btn banner-fav${S.favs.has(ch.id) ? ' on' : ''}" aria-pressed="${S.favs.has(ch.id)}">${S.favs.has(ch.id) ? '★ Favorite' : '☆ Favorite'}</button></div>`;
  b.hidden = false;
  updateControls();
  document.body.classList.add('chrome-on');
  clearTimeout(bannerTimer);
  if (autohide) bannerTimer = setTimeout(hideChrome, 5000);
}

$('banner').addEventListener('click', (e) => {
  if (!e.target.closest('.fav-btn')) return;
  e.stopPropagation();
  toggleFav(S.playing);
  showBanner();
});

/* ------------------------------------------------------------- controls */

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
  muted:
    '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z"/></svg>',
  pip: '<svg viewBox="0 0 24 24"><path d="M19 7h-8v6h8V7zm2-4H3a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H3V5h18v14z"/></svg>',
  fs: '<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
  unfs: '<svg viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>',
};
const clock = (t) => {
  if (!Number.isFinite(t)) return '0:00';
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(Math.floor(t % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const ctl = (name) => $('controls').querySelector(`[data-c="${name}"]`);

function updateControls() {
  const v = $('video');
  const play = ctl('play');
  play.innerHTML = v.paused ? ICON.play : ICON.pause;
  play.setAttribute('aria-label', v.paused ? 'Play' : 'Pause');
  const silent = v.muted || v.volume === 0;
  ctl('mute').innerHTML = silent ? ICON.muted : ICON.vol;
  ctl('mute').setAttribute('aria-label', silent ? 'Unmute' : 'Mute');
  $('vol').value = String(silent ? 0 : v.volume);
  ctl('pip').innerHTML = ICON.pip;
  ctl('pip').hidden = !document.pictureInPictureEnabled;
  ctl('fs').innerHTML = document.fullscreenElement ? ICON.unfs : ICON.fs;
  ctl('fs').hidden = !document.fullscreenEnabled;
  // A catch-up programme has an end, so it can be scrubbed; live TV cannot.
  const seekable = Boolean(S.catchup) && Number.isFinite(v.duration) && v.duration > 0;
  $('seekwrap').hidden = !seekable;
  if (seekable && !seeking) {
    $('seek').max = String(v.duration);
    $('seek').value = String(v.currentTime);
    $('t-cur').textContent = clock(v.currentTime);
    $('t-dur').textContent = clock(v.duration);
  }
}

function togglePlay() {
  const v = $('video');
  if (v.paused) v.play().catch(() => {});
  else v.pause();
}

function setVolume(x) {
  const v = $('video');
  v.volume = Math.min(1, Math.max(0, x));
  v.muted = v.volume === 0;
}

/** Keep the controls up while someone is using them. */
function holdChrome() {
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(hideChrome, 5000);
}

let seeking = false;
$('controls').addEventListener('click', (e) => {
  e.stopPropagation();
  const b = e.target.closest('[data-c]');
  holdChrome();
  if (!b) return;
  const v = $('video');
  const c = b.dataset.c;
  if (c === 'play') togglePlay();
  if (c === 'mute') {
    if (v.muted || v.volume === 0) {
      v.muted = false;
      if (v.volume === 0) v.volume = 0.5;
    } else v.muted = true;
  }
  if (c === 'fs') toggleFullscreen();
  if (c === 'pip') {
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    else v.requestPictureInPicture?.().catch(() => {});
  }
});
$('vol').addEventListener('input', (e) => {
  holdChrome();
  setVolume(Number(e.target.value));
});
$('seek').addEventListener('input', (e) => {
  seeking = true;
  holdChrome();
  $('t-cur').textContent = clock(Number(e.target.value));
});
$('seek').addEventListener('change', (e) => {
  $('video').currentTime = Number(e.target.value);
  seeking = false;
});
for (const ev of ['play', 'pause', 'volumechange', 'durationchange', 'timeupdate'])
  $('video').addEventListener(ev, () => !$('banner').hidden && updateControls());
document.addEventListener('fullscreenchange', () => !$('banner').hidden && updateControls());

// The volume is yours, across channels and visits.
$('video').addEventListener('volumechange', () => {
  const v = $('video');
  store.prefs.write('volume', { level: v.volume, muted: v.muted });
});
{
  const saved = store.prefs.read('volume', null);
  if (saved) {
    $('video').volume = Math.min(1, Math.max(0, Number(saved.level) || 0));
    $('video').muted = Boolean(saved.muted);
  }
}

function hideChrome() {
  $('banner').hidden = true;
  navPinned = false;
  if (S.mode === 'tv') navFocus = -1;
  syncNav();
  document.body.classList.remove('chrome-on');
}

function logo(ch, cls) {
  // "Channel 10" -> C10, "BBC One HD" -> BO: a number is worth more than a letter.
  const words = ch.name
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .split(/\s+/)
    .filter(Boolean);
  const initials = esc(
    words
      .slice(0, 2)
      .map((w) => (/^\d+$/.test(w) ? w.slice(0, 3) : w[0]))
      .join('')
      .toUpperCase(),
  );
  if (!ch.logo) return `<span class="${cls}"><b>${initials}</b></span>`;
  const src = location.protocol === 'https:' && ch.logo.startsWith('http:') ? proxyPath(ch.logo) : ch.logo;
  return `<span class="${cls}"><img loading="lazy" alt="" src="${esc(src)}" onerror="this.replaceWith(Object.assign(document.createElement('b'),{textContent:'${initials}'}))"></span>`;
}

/* ----------------------------------------------------------- channel list */

const rowPx = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row')) || 64;

function openList({ groups = false, search = false } = {}) {
  closeAll();
  hideChrome();
  S.mode = 'list';
  syncNav();
  $('list').hidden = false;
  S.pane = groups ? 'groups' : 'channels';
  $('list').classList.toggle('groups-open', groups);
  S.groupFocus = Math.max(
    0,
    S.groups.findIndex((g) => g.name === S.group),
  );
  setView();
  renderGroups();
  renderHead(search);
  renderChannels(true);
}

function renderGroups() {
  const nav = $('groups');
  nav.innerHTML = '';
  S.groups.forEach((g, i) => {
    const b = el(
      'button',
      `${g.name === S.group ? 'cur' : ''} ${S.pane === 'groups' && i === S.groupFocus ? 'focus' : ''}`,
      `<span>${esc(g.name)}</span><span class="n">${g.count}</span>`,
    );
    b.onclick = () => pickGroup(i);
    nav.append(b);
  });
  nav.querySelector('.focus')?.scrollIntoView({ block: 'nearest' });
}

function pickGroup(i) {
  S.group = S.groups[i].name;
  history.replaceState(history.state, '', listPath());
  S.groupFocus = i;
  S.query = '';
  setView();
  S.focus = Math.max(0, S.view.indexOf(S.playing));
  S.pane = 'channels';
  $('list').classList.remove('groups-open');
  renderGroups();
  renderHead();
  renderChannels(true);
}

function renderHead(focusFilter = false) {
  const h = $('list-head');
  h.innerHTML = `<button type="button" class="close-btn" id="list-close" aria-label="Close, back to the picture">✕</button><h2>${esc(S.group)}</h2>
    <input id="q" class="filter" type="search" placeholder="Filter by name or number" value="${esc(S.query)}" autocomplete="off" spellcheck="false" aria-label="Filter channels">
    <span class="hint" id="list-count"></span>`;
  updateCount();
  $('list-close').onclick = () => closeToPicture();
  const q = $('q');
  q.oninput = () => {
    S.query = q.value.trim();
    history.replaceState(history.state, '', listPath());
    setView();
    S.focus = 0;
    updateCount();
    renderChannels(true);
  };
  if (focusFilter) q.focus();
}

function updateCount() {
  const c = $('list-count');
  if (c) c.textContent = `${S.view.length} · ☆ or F favorites · ◀ groups`;
}

function renderChannels(scrollToFocus = false) {
  const box = $('channels');
  const rp = rowPx();
  if (!S.view.length) {
    box.innerHTML = `<div class="empty">${S.group === FAV && !S.query ? 'No favorites yet. Tap ☆ on any channel, or press F while it is selected or playing.' : S.query ? `No channel here matches "${esc(S.query)}".` : 'Nothing here.'}</div>`;
    return;
  }
  let spacer = box.querySelector('.spacer');
  if (!spacer) {
    box.innerHTML = '';
    spacer = el('div', 'spacer');
    box.append(spacer);
  }
  spacer.style.height = `${S.view.length * rp + 8}px`;
  if (scrollToFocus) {
    const top = S.focus * rp;
    if (top < box.scrollTop || top + rp > box.scrollTop + box.clientHeight)
      box.scrollTop = top - box.clientHeight / 2 + rp / 2;
  }
  const first = Math.max(0, Math.floor(box.scrollTop / rp) - 4);
  const last = Math.min(S.view.length, Math.ceil((box.scrollTop + box.clientHeight) / rp) + 4);
  const rows = [];
  const visible = [];
  for (let i = first; i < last; i++) {
    const c = S.view[i];
    visible.push(c);
    const { now } = nn(c);
    const cls = `row${i === S.focus && S.pane === 'channels' ? ' focus' : ''}${c.id === S.playing?.id ? ' playing' : ''}`;
    rows.push(`<div class="${cls}" data-i="${i}" style="top:${i * rp + 4}px" role="option">
      <span class="no">${c.chno ?? i + 1}</span>${logo(c, 'logo')}
      <span class="meta"><div class="nm">${esc(c.name)}</div>
      <div class="pg">${now ? `${esc(now.title)}` : S.data?.epgUrl ? '&nbsp;' : esc(c.group)}</div>
      ${now ? `<div class="bar"><i style="width:${(progress(now) * 100).toFixed(1)}%"></i></div>` : ''}</span>
      <button type="button" class="fav-btn${S.favs.has(c.id) ? ' on' : ''}" data-fav="${i}" tabindex="-1" aria-pressed="${S.favs.has(c.id)}" aria-label="${S.favs.has(c.id) ? 'Remove from' : 'Add to'} favorites">${S.favs.has(c.id) ? '★' : '☆'}</button></div>`);
  }
  for (const r of box.querySelectorAll('.row')) r.remove();
  spacer.insertAdjacentHTML('afterend', rows.join(''));
  ensureEpg(visible);
}

$('channels').addEventListener('scroll', () => S.mode === 'list' && renderChannels());
$('channels').addEventListener('click', (e) => {
  const star = e.target.closest('.fav-btn');
  if (star) {
    e.stopPropagation();
    return toggleFav(S.view[Number(star.dataset.fav)]);
  }
  const r = e.target.closest('.row');
  if (!r) return;
  const i = Number(r.dataset.i);
  S.focus = i;
  S.pane = 'channels';
  const ch = S.view[i];
  if (ch.id === S.playing?.id && !S.catchup) back();
  else play(ch);
});
let pressTimer = 0;
$('channels').addEventListener('pointerdown', (e) => {
  const r = e.target.closest('.row');
  if (!r) return;
  pressTimer = setTimeout(() => toggleFav(S.view[Number(r.dataset.i)]), 650);
});
for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'scroll'])
  $('channels').addEventListener(ev, () => clearTimeout(pressTimer), true);

function moveFocus(step) {
  if (S.pane === 'groups') {
    S.groupFocus = Math.min(S.groups.length - 1, Math.max(0, S.groupFocus + step));
    return renderGroups();
  }
  if (!S.view.length) return;
  S.focus = (S.focus + step + S.view.length) % S.view.length;
  renderChannels(true);
}

async function toggleFav(ch) {
  if (!ch) return;
  S.favs.has(ch.id) ? S.favs.delete(ch.id) : S.favs.add(ch.id);
  await store.set(`fav:${S.pl.id}`, [...S.favs]);
  account.changed();
  S.groups[0].count = S.favs.size;
  if (S.mode === 'list') {
    if (S.group === FAV) setView();
    renderGroups();
    updateCount();
    renderChannels();
  } else showBanner();
}

/* ---------------------------------------------------------------- TV guide */

const G = { row: 0, top: 0, start: 0, focusT: 0, q: '', list: [] };
const SLOT = 30 * 60_000;

function openGuide() {
  closeAll();
  hideChrome();
  S.mode = 'guide';
  syncNav();
  $('guide').hidden = false;
  G.list = filterChannels(groupList(), G.q);
  G.row = Math.max(0, G.list.indexOf(S.playing));
  G.top = 0;
  $('gq').value = G.q;
  G.start = Math.floor((Date.now() - SLOT / 2) / SLOT) * SLOT;
  G.focusT = Date.now();
  // The picture keeps playing, in the preview corner.
  $('guide-info').append($('video'));
  renderGuide();
}

function guideDims() {
  const grid = $('guide-grid');
  const chW =
    $('guide-grid').querySelector('.g-ch')?.offsetWidth ||
    (innerWidth < 700 ? 120 : parseFloat(getComputedStyle(document.documentElement).fontSize) * 15);
  const rowH = parseFloat(getComputedStyle(document.documentElement).fontSize) * 3.6;
  const span = (innerWidth < 700 ? 2 : 3) * 3600_000;
  return { grid, chW, rowH, span, pxPerMs: (grid.clientWidth - chW) / span };
}

function focusedProgramme() {
  const ch = G.list[G.row];
  const list = S.epg.get(ch?.id) || [];
  const i = indexAt(list, G.focusT);
  return { ch, list, i, p: list[i] || null };
}

function renderGuide() {
  const { grid, chW, rowH, span, pxPerMs } = guideDims();
  const end = G.start + span;
  const visRows = Math.ceil((grid.clientHeight - 40) / rowH);
  if (G.row < G.top) G.top = G.row;
  if (G.row >= G.top + visRows - 1) G.top = G.row - visRows + 2;
  G.top = Math.max(0, G.top);
  const chans = G.list.slice(G.top, G.top + visRows + 1);
  ensureEpg(chans);

  let times = '';
  for (let t = G.start; t < end; t += SLOT)
    times += `<span style="left:${(t - G.start) * pxPerMs}px">${hhmm(t)}</span>`;
  const nowX = chW + (Date.now() - G.start) * pxPerMs;
  let rows = '';
  chans.forEach((c, k) => {
    const r = G.top + k;
    const list = S.epg.get(c.id) || [];
    let cells = '';
    const inWin = list.filter((p) => p.stop > G.start && p.start < end);
    for (const p of inWin) {
      const x0 = Math.max(p.start, G.start);
      const x1 = Math.min(p.stop, end);
      const on = p.start <= Date.now() && Date.now() < p.stop;
      const focus = r === G.row && p.start <= G.focusT && G.focusT < p.stop;
      cells += `<div class="g-p${p.stop <= Date.now() ? ' past' : ''}${on ? ' on' : ''}${focus ? ' focus' : ''}" data-r="${r}" data-t="${p.start}" style="left:${chW + (x0 - G.start) * pxPerMs + 2}px;width:${Math.max(4, (x1 - x0) * pxPerMs - 4)}px">${esc(p.title)}</div>`;
    }
    if (!inWin.length) {
      cells = `<div class="g-p nodata${r === G.row ? ' focus' : ''}" data-r="${r}" style="left:${chW + 2}px;width:${span * pxPerMs - 4}px">${S.data?.epgUrl ? (S.epgAsked.has(c.id) ? 'No information' : 'Loading…') : esc(c.name)}</div>`;
    }
    rows += `<div class="g-row" style="top:${k * rowH}px"><div class="g-ch" data-r="${r}"><span class="no">${c.chno ?? r + 1}</span>${logo(c, 'logo')}<span class="nm">${esc(c.name)}</span></div>${cells}</div>`;
  });
  if (!G.list.length) {
    grid.innerHTML = `<div class="empty">No channel here matches "${esc(G.q)}".</div>`;
    return renderGuideInfo();
  }
  grid.innerHTML = `<div class="g-times">${times}</div>${nowX > chW ? `<div class="g-now" style="left:${nowX}px"></div>` : ''}<div class="g-rows">${rows}</div>`;
  grid.querySelector('.g-times').style.left = `${chW}px`;
  renderGuideInfo();
}

function renderGuideInfo() {
  const { ch, p } = focusedProgramme();
  const info = $('guide-info');
  let text = info.querySelector('.gi-text');
  if (!text) {
    text = el('div', 'gi-text');
    info.prepend(text);
  }
  if (!info.querySelector('.preview')) {
    const pv = el('div', 'preview');
    pv.append($('video'));
    info.append(pv);
  }
  if (!ch) return (text.innerHTML = '');
  const can = p && p.stop <= Date.now() && ch.catchup;
  text.innerHTML = `<div class="times">${esc(ch.name)}${ch.catchup ? ' · catch-up' : ''}</div>
    <h2>${esc(p?.title || ch.name)}</h2>
    ${p ? `<div class="times">${new Date(p.start).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} · ${hhmm(p.start)} – ${hhmm(p.stop)}${p.category ? ` · ${esc(p.category)}` : ''}${can ? ' · OK to watch from the start' : ''}</div>` : ''}
    ${p?.desc ? `<p>${esc(p.desc)}</p>` : ''}`;
}

$('guide-close').addEventListener('click', () => closeToPicture());

$('gq').addEventListener('input', () => {
  G.q = $('gq').value.trim();
  G.list = filterChannels(groupList(), G.q);
  G.row = 0;
  G.top = 0;
  history.replaceState(history.state, '', G.q ? `/guide?q=${encodeURIComponent(G.q)}` : '/guide');
  renderGuide();
});

function guideMove(dr, dt) {
  const { span } = guideDims();
  if (dr) G.row = Math.min(G.list.length - 1, Math.max(0, G.row + dr));
  if (dt) {
    const { list, i } = focusedProgramme();
    const p = list[i];
    if (dt > 0) G.focusT = p ? p.stop + 1 : G.focusT + SLOT;
    else G.focusT = p && list[i - 1] ? list[i - 1].start + 1 : G.focusT - SLOT;
    G.focusT = Math.max(Date.now() - GUIDE_BACK, G.focusT);
    if (G.focusT >= G.start + span - SLOT / 2) G.start += SLOT * Math.ceil((G.focusT - (G.start + span) + SLOT) / SLOT);
    if (G.focusT < G.start) G.start = Math.floor(G.focusT / SLOT) * SLOT;
  }
  renderGuide();
}

function guideOk() {
  const { ch, p } = focusedProgramme();
  if (!ch) return;
  if (p && p.stop <= Date.now() && ch.catchup) {
    const url = catchupUrl(ch, S.data.source, p.start, p.stop, S.data.account?.timeZone);
    if (url) return play(ch, { url, programme: p });
  }
  if (p && p.start > Date.now()) return; // the future cannot be watched yet
  if (ch.id === S.playing?.id && !S.catchup) return back();
  play(ch);
}

$('guide-grid').addEventListener('click', (e) => {
  const cell = e.target.closest('[data-r]');
  if (!cell) return;
  const r = Number(cell.dataset.r);
  const t = Number(cell.dataset.t);
  const same = r === G.row && (!t || (G.focusT >= t && focusedProgramme().p?.start === t));
  G.row = r;
  if (t) G.focusT = t + 1;
  if (same) guideOk();
  else renderGuide();
});
$('guide-grid').addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) guideMove(0, e.deltaX > 0 ? 1 : -1);
    else guideMove(e.deltaY > 0 ? 1 : -1, 0);
  },
  { passive: false },
);

/* ------------------------------------------------------- setup + settings */

function openSetup(first = true) {
  closeAll();
  S.mode = 'sheet';
  $('sheet').dataset.screen = 'settings';
  syncNav();
  const sheet = $('sheet');
  sheet.hidden = false;
  sheet.innerHTML = `<div class="card">
    <h1><img src="/icon.svg" alt="">hdtilt</h1>
    <p class="sub">${first ? 'Add your playlist to start watching. hdtilt is a player: it comes with no channels.' : 'Add a playlist'}</p>
    <div class="tabs" role="tablist"><button class="on" data-tab="m3u">M3U playlist</button><button data-tab="xtream">Xtream Codes</button><button data-tab="file">File</button></div>
    <form id="addf">
      <label for="f-name">Name</label><input class="field" id="f-name" placeholder="My TV" value="${S.playlists.length ? '' : 'My TV'}">
      <div data-pane="m3u"><label for="f-url">Playlist URL</label><input class="field" id="f-url" inputmode="url" placeholder="https://provider.example/playlist.m3u"></div>
      <div data-pane="xtream" hidden>
        <label for="f-server">Server</label><input class="field" id="f-server" inputmode="url" placeholder="http://provider.example:8080">
        <label for="f-user">Username</label><input class="field" id="f-user" autocomplete="username">
        <label for="f-pass">Password</label><input class="field" id="f-pass" type="password" autocomplete="current-password">
      </div>
      <div data-pane="file" hidden><label for="f-file">M3U file</label><input class="field" id="f-file" type="file" accept=".m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain"></div>
      <label for="f-epg">TV guide URL (XMLTV, optional)</label><input class="field" id="f-epg" inputmode="url" placeholder="Read from the playlist when it names one">
      <div class="err" id="f-err"></div>
      <div class="actions"><button class="btn primary" type="submit">Add playlist</button>${first ? '' : '<button class="btn" type="button" id="f-cancel">Cancel</button>'}</div>
    </form>
    <p class="note">${api.serverInfo.public ? 'Your playlist and login are kept in this browser only. Streams this page cannot reach directly pass through hdtilt.com. Prefer nothing in between? Get the <a href="https://github.com/profullstack/hdtilt.com#install" target="_blank" rel="noopener">desktop app or CLI</a>.' : 'Running locally: nothing leaves this machine.'} Open source: <a href="https://github.com/profullstack/hdtilt.com" target="_blank" rel="noopener">github.com/profullstack/hdtilt.com</a></p>
  </div>`;
  let tab = 'm3u';
  sheet.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => {
      tab = b.dataset.tab;
      for (const x of sheet.querySelectorAll('[data-tab]')) x.classList.toggle('on', x === b);
      for (const p of sheet.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== tab;
    };
  });
  $('f-cancel')?.addEventListener('click', () => back());
  $('addf').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('f-err');
    err.textContent = '';
    const name = $('f-name').value.trim() || 'My TV';
    const epg = $('f-epg').value.trim();
    let source;
    if (tab === 'm3u') source = { type: 'm3u', url: $('f-url').value.trim() };
    else if (tab === 'xtream')
      source = {
        type: 'xtream',
        server: $('f-server').value.trim(),
        username: $('f-user').value.trim(),
        password: $('f-pass').value,
      };
    else {
      const file = $('f-file').files[0];
      if (!file) return (err.textContent = 'Choose a file');
      source = { type: 'text', text: await file.text() };
    }
    if (source.type === 'm3u' && !/^https?:\/\//i.test(source.url))
      return (err.textContent = 'Paste the full playlist URL, starting with http');
    if (source.type === 'xtream' && !(source.server && source.username && source.password))
      return (err.textContent = 'Server, username and password are all needed');
    if (epg) source.epg = epg;
    const btn = e.submitter || sheet.querySelector('.primary');
    btn.disabled = true;
    btn.textContent = 'Loading channels…';
    try {
      const pl = { id: `p${Date.now().toString(36)}`, name, source };
      if (source.type === 'text') await loadLocalFile(pl);
      else await loadFresh(pl);
      S.playlists.push(pl);
      account.changed();
      await store.set(
        'playlists',
        S.playlists.filter((p) => p.source.type !== 'saved'),
      );
      await usePlaylist(pl);
      go(watchPath(), { replace: true });
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = 'Add playlist';
    }
  };
  setTimeout(() => $('f-url')?.focus(), 50);
}

/** A file is parsed in the browser; it never needs the server. */
async function loadLocalFile(pl) {
  const { channelsFromM3u } = await import('../../src/core/sources.js');
  const { channels, epgUrl } = await channelsFromM3u(pl.source.text);
  if (!channels.length) throw new Error('no channels found in that file');
  const data = { channels, epgUrl: pl.source.epg || epgUrl, source: pl.source, account: null };
  await store.set(`ch:${pl.id}`, { at: Date.now() + 1e12, data });
}

function openSettings() {
  closeAll();
  S.mode = 'sheet';
  $('sheet').dataset.screen = 'settings';
  syncNav();
  const sheet = $('sheet');
  sheet.hidden = false;
  const rows = S.playlists
    .map(
      (
        p,
      ) => `<div class="pl${p.id === S.pl?.id ? ' cur' : ''}" data-id="${esc(p.id)}"><span class="nm">${esc(p.name)}</span><span class="ty">${p.source.type === 'saved' ? 'this computer' : esc(p.source.type)}</span>
      ${p.id === S.pl?.id ? '' : '<button class="btn" data-a="use">Watch</button>'}<button class="btn" data-a="refresh">Refresh</button>${p.source.type === 'saved' ? '' : '<button class="btn" data-a="remove">Remove</button>'}</div>`,
    )
    .join('');
  const acct = S.data?.account;
  sheet.innerHTML = `<div class="card">
    <h1><img src="/icon.svg" alt="">Settings</h1>
    <h2>Playlists</h2>${rows || '<p class="sub">None yet.</p>'}
    <div class="actions"><button class="btn primary" id="s-add">Add playlist</button><button class="btn" id="s-close">Close</button></div>
    ${acct ? `<h2>Account</h2><p class="sub">${esc(acct.status || '')}${acct.expiresAt ? ` · expires ${new Date(acct.expiresAt).toLocaleDateString()}` : ''}${acct.maxConnections ? ` · ${acct.activeConnections}/${acct.maxConnections} connections` : ''}</p>` : ''}
    ${S.playing ? `<h2>Now playing</h2><p class="sub">${esc(S.playing.name)} · <button class="btn" id="s-copy">Copy stream URL</button></p>` : ''}
    <h2>Remote and keyboard</h2>
    <p class="sub">↑ ↓ change channel · OK channel list · Space play/pause · + − volume · ◀ groups · G guide · ☆ or F favorite · 0–9 channel number · ⌫ last channel · / filter (list or guide) · M mute · Esc back</p>
    <p class="note">hdtilt ${esc(api.serverInfo.version)} · open source, MIT · <a href="https://github.com/profullstack/hdtilt.com" target="_blank" rel="noopener">source</a> · CLI, TUI, MCP and API included</p>
  </div>`;
  $('s-add').onclick = () => go('/settings/add');
  $('s-close').onclick = () => back();
  $('s-copy')?.addEventListener('click', () => navigator.clipboard?.writeText(S.playing.url));
  sheet.querySelectorAll('.pl .btn').forEach((b) => {
    b.onclick = async () => {
      const pl = S.playlists.find((p) => p.id === b.closest('.pl').dataset.id);
      if (b.dataset.a === 'use') {
        await usePlaylist(pl);
        go(watchPath(), { replace: true });
      } else if (b.dataset.a === 'refresh') {
        b.textContent = '…';
        try {
          if (pl.source.type === 'text') throw new Error('re-add a file to refresh it');
          await loadFresh(pl);
          b.textContent = 'Done';
        } catch (e) {
          b.textContent = 'Failed';
          b.title = e.message;
        }
      } else if (b.dataset.a === 'remove' && confirm(`Remove ${pl.name}?`)) {
        S.playlists = S.playlists.filter((p) => p !== pl);
        store.prefs.write('deletedPlaylists', [...new Set([...store.prefs.read('deletedPlaylists', []), pl.id])]);
        account.changed();
        await store.set(
          'playlists',
          S.playlists.filter((p) => p.source.type !== 'saved'),
        );
        for (const k of ['ch', 'fav', 'recent']) await store.del(`${k}:${pl.id}`);
        if (S.pl?.id === pl.id) {
          S.attached?.destroy();
          S.pl = null;
          S.playing = null;
          if (S.playlists[0]) return usePlaylist(S.playlists[0]);
          return openSetup();
        }
        openSettings();
      }
    };
  });
}

/* ------------------------------------------------------------- account */

function sheet(screen, html) {
  closeAll();
  S.mode = 'sheet';
  const sh = $('sheet');
  sh.dataset.screen = screen;
  sh.hidden = false;
  sh.innerHTML = `<div class="card">${html}</div>`;
  syncNav();
  setTimeout(() => sh.querySelector('input')?.focus(), 50);
  return sh;
}

const busy = async (btn, label, fn) => {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
};

/** Sign in, create an account, or (signed in) the account itself. `after` runs after sign-in. */
function openAccount({ tab = 'in', after = null, note = '' } = {}) {
  const u = account.current();
  if (u) {
    const sh = sheet(
      'account',
      `<h1><img src="/icon.svg" alt="">${esc(u.username || 'Account')}</h1>
      <p class="sub">${esc(u.email)}</p>
      <p class="sub">Your playlists, favorites and recent channels follow you to every device you sign in on, including <code>hdtilt tui</code> after <code>hdtilt login</code>.</p>
      <div class="actions"><button class="btn primary" id="a-sync">Sync now</button><button class="btn" id="a-out">Sign out</button><button class="btn" id="a-close">Close</button></div>
      <div class="err" id="a-err"></div>`,
    );
    sh.querySelector('#a-sync').onclick = (e) =>
      busy(e.target, 'Syncing…', () => account.syncNow())
        .then(() => toast('Synced'))
        .catch((x) => ($('a-err').textContent = x.message));
    sh.querySelector('#a-out').onclick = async () => {
      await account.signOut();
      toast('Signed out');
      go(watchPath(), { replace: true });
    };
    sh.querySelector('#a-close').onclick = () => back();
    return;
  }
  const sh = sheet(
    'account',
    `<h1><img src="/icon.svg" alt="">${tab === 'up' ? 'Create account' : 'Sign in'}</h1>
    <p class="sub">${note || 'An account keeps your playlists and favorites on every screen you watch on.'}</p>
    <div class="tabs"><button class="${tab === 'in' ? 'on' : ''}" data-tab="in">Sign in</button><button class="${tab === 'up' ? 'on' : ''}" data-tab="up">Create account</button></div>
    <form id="af">
      ${
        tab === 'up'
          ? `<label for="a-user">Username</label><input class="field" id="a-user" autocomplete="username" autocapitalize="none" spellcheck="false" required>
             <label for="a-mail">Email</label><input class="field" id="a-mail" type="email" autocomplete="email" required>
             <label for="a-pass">Password (8 or more characters)</label><input class="field" id="a-pass" type="password" autocomplete="new-password" minlength="8" required>`
          : `<label for="a-login">Username or email</label><input class="field" id="a-login" autocomplete="username" autocapitalize="none" spellcheck="false" required>
             <label for="a-pass">Password</label><input class="field" id="a-pass" type="password" autocomplete="current-password" required>`
      }
      <div class="err" id="a-err"></div>
      <div class="actions"><button class="btn primary" type="submit">${tab === 'up' ? 'Create account' : 'Sign in'}</button><button class="btn" type="button" id="a-cancel">Cancel</button></div>
    </form>
    ${tab === 'in' ? '<p class="note"><button class="linkbtn" id="a-forgot">Forgot your password?</button></p>' : '<p class="note">We email you a link to confirm the address before you can sign in.</p>'}`,
  );
  for (const b of sh.querySelectorAll('[data-tab]'))
    b.onclick = () => {
      history.replaceState(history.state, '', b.dataset.tab === 'up' ? '/account/signup' : '/account');
      openAccount({ tab: b.dataset.tab, after, note });
    };
  sh.querySelector('#a-cancel').onclick = () => back();
  sh.querySelector('#a-forgot')?.addEventListener('click', () => go('/account/forgot'));
  sh.querySelector('#af').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('a-err');
    err.textContent = '';
    const btn = e.submitter || sh.querySelector('.primary');
    try {
      if (tab === 'up') {
        const email = $('a-mail').value.trim();
        await busy(btn, 'Creating…', () => account.register($('a-user').value.trim(), email, $('a-pass').value));
        return openCheckEmail(email);
      }
      await busy(btn, 'Signing in…', () => account.signIn($('a-login').value.trim(), $('a-pass').value));
      toast(`Signed in as ${account.current().username || account.current().email}`);
      await account.syncNow().catch(() => {});
      if (after) return after();
      if (!S.pl && S.playlists[0]) await usePlaylist(S.playlists[0]);
      go(S.pl ? watchPath() : '/settings/add', { replace: true });
    } catch (x) {
      err.innerHTML = esc(x.message);
      if (x.code === 'unverified') {
        const login = $('a-login').value.trim();
        if (login.includes('@')) {
          err.insertAdjacentHTML('beforeend', ' <button class="linkbtn" id="a-resend">Send the link again</button>');
          $('a-resend').onclick = () => account.resend(login).then(() => toast('Sent. Check your inbox.'));
        }
      }
    }
  };
}

function openCheckEmail(email) {
  const sh = sheet(
    'account',
    `<h1><img src="/icon.svg" alt="">Check your email</h1>
    <p class="sub">We sent a link to <strong>${esc(email)}</strong>. Open it to confirm the address and you're signed in. It works for 24 hours.</p>
    <div class="actions"><button class="btn primary" id="c-in">I've confirmed it: sign in</button><button class="btn" id="c-again">Send it again</button></div>`,
  );
  sh.querySelector('#c-in').onclick = () => openAccount({ tab: 'in' });
  sh.querySelector('#c-again').onclick = (e) =>
    busy(e.target, 'Sending…', () => account.resend(email)).then(() => toast('Sent again'));
}

function openForgot() {
  const sh = sheet(
    'account',
    `<h1><img src="/icon.svg" alt="">Forgot password</h1>
    <p class="sub">Enter your account's email and we'll send a link to choose a new password.</p>
    <form id="ff"><label for="f-mail">Email</label><input class="field" id="f-mail" type="email" autocomplete="email" required>
    <div class="err" id="f-err"></div>
    <div class="actions"><button class="btn primary" type="submit">Send link</button><button class="btn" type="button" id="f-back">Back</button></div></form>`,
  );
  sh.querySelector('#f-back').onclick = () => back();
  sh.querySelector('#ff').onsubmit = async (e) => {
    e.preventDefault();
    await busy(e.submitter, 'Sending…', () => account.forgot($('f-mail').value.trim())).catch(() => {});
    sheet(
      'account',
      `<h1><img src="/icon.svg" alt="">Check your email</h1><p class="sub">If that address has an hdtilt account, a reset link is on its way.</p><div class="actions"><button class="btn primary" id="f-ok">OK</button></div>`,
    ).querySelector('#f-ok').onclick = () => openAccount();
  };
}

function openReset(token) {
  const sh = sheet(
    'account',
    `<h1><img src="/icon.svg" alt="">Choose a new password</h1>
    <form id="rf"><label for="r-pass">New password (8 or more characters)</label><input class="field" id="r-pass" type="password" autocomplete="new-password" minlength="8" required>
    <div class="err" id="r-err"></div>
    <div class="actions"><button class="btn primary" type="submit">Save password</button></div></form>`,
  );
  sh.querySelector('#rf').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await busy(e.submitter, 'Saving…', () => account.reset(token, $('r-pass').value));
      openAccount({ note: 'Password changed. Sign in with the new one.' });
    } catch (x) {
      $('r-err').textContent = x.message;
    }
  };
}

/** The consent screen the CLI and TUI open: "let hdtilt CLI use your account?" */
async function openConsent(query) {
  if (!account.current()) {
    return openAccount({
      note: 'Sign in to connect the hdtilt CLI and TUI to your account.',
      after: () => openConsent(query),
    });
  }
  let info;
  try {
    info = await account.authorize(query);
  } catch (x) {
    return sheet('account', `<h1>Can't connect</h1><p class="sub">${esc(x.message)}</p>`);
  }
  const u = account.current();
  const sh = sheet(
    'account',
    `<h1><img src="/icon.svg" alt="">Connect ${esc(info.clientName)}?</h1>
    <p class="sub">It will be able to read and change your hdtilt playlists and favorites as <strong>${esc(u.username || u.email)}</strong>. You can sign it out any time with <code>hdtilt logout</code>.</p>
    <div class="actions"><button class="btn primary" id="o-yes">Allow</button><button class="btn" id="o-no">Deny</button></div>`,
  );
  const go = (decision) => account.authorize(query, decision).then((r) => location.assign(r.redirect));
  sh.querySelector('#o-yes').onclick = () => go('approve');
  sh.querySelector('#o-no').onclick = () => go('deny');
}

/** Pages reached from outside: email links, and the OAuth hops. True when one was handled. */
async function handleRoute() {
  const { pathname, search } = location;
  const q = Object.fromEntries(new URLSearchParams(search));
  const home = () => history.replaceState({ depth: 0 }, '', '/account');
  if (pathname === '/verify' && q.token) {
    home();
    try {
      const u = await account.verify(q.token);
      await account.syncNow().catch(() => {});
      if (!S.pl && S.playlists[0]) await usePlaylist(S.playlists[0]);
      history.replaceState({ depth: 0 }, '', '/account');
      const sh = sheet(
        'account',
        `<h1><img src="/icon.svg" alt="">Email confirmed ✓</h1>
        <p class="sub">You're signed in as <strong>${esc(u.username || u.email)}</strong>. Your playlists and favorites will now follow you to every screen you sign in on.</p>
        <div class="actions"><button class="btn primary" id="v-go">${S.pl ? 'Start watching' : 'Add your playlist'}</button></div>`,
      );
      sh.querySelector('#v-go').onclick = () => go(S.pl ? watchPath() : '/settings/add', { replace: true });
    } catch (x) {
      history.replaceState({ depth: 0 }, '', '/account');
      openAccount({ note: esc(x.message) });
    }
    return true;
  }
  if (pathname === '/reset' && q.token) {
    home();
    openReset(q.token);
    return true;
  }
  if (pathname === '/oauth/authorize') {
    home();
    await openConsent(q);
    return true;
  }
  if (pathname === '/oauth/cli') {
    home();
    sheet(
      'account',
      q.code
        ? `<h1><img src="/icon.svg" alt="">Paste this into your terminal</h1><p class="sub">hdtilt is waiting for this code to finish signing in.</p><div class="code">${esc(q.code)}</div>`
        : `<h1>Sign-in cancelled</h1><p class="sub">${esc(q.error || 'Nothing to paste.')}</p>`,
    );
    return true;
  }
  return false;
}

/** Everything that syncs, gathered from this device. */
async function collectLibrary() {
  const playlists = S.playlists.filter((p) => p.source.type !== 'saved' && p.source.type !== 'text');
  const favorites = {};
  const recent = {};
  for (const p of playlists) {
    favorites[p.id] = p.id === S.pl?.id ? [...S.favs] : await store.get(`fav:${p.id}`, []);
    recent[p.id] = p.id === S.pl?.id ? S.recent : await store.get(`recent:${p.id}`, []);
  }
  return {
    playlists: playlists.map(({ id, name, source }) => ({ id, name, source })),
    favorites,
    recent,
    deleted: store.prefs.read('deletedPlaylists', []),
  };
}

/** Fold the account's copy into this device. */
async function mergeLibrary(remote) {
  const merged = account.mergeLibraries(await collectLibrary(), remote);
  store.prefs.write('deletedPlaylists', merged.deleted);
  const local = S.playlists.filter((p) => p.source.type === 'saved' || p.source.type === 'text');
  S.playlists = [...merged.playlists, ...local];
  await store.set(
    'playlists',
    S.playlists.filter((p) => p.source.type !== 'saved'),
  );
  for (const [id, list] of Object.entries(merged.favorites)) await store.set(`fav:${id}`, list);
  for (const [id, list] of Object.entries(merged.recent)) await store.set(`recent:${id}`, list);
  if (S.pl) {
    S.favs = new Set(merged.favorites[S.pl.id] || [...S.favs]);
    S.recent = merged.recent[S.pl.id] || S.recent;
    buildGroups();
  }
}

/* ---------------------------------------------------------------- routes */
// Every view has an address. Going somewhere pushes one, Back (browser or
// remote) pops one, and an address opened cold renders that view.
//
//   /  /watch/:channel        the picture
//   /channels[/:group][?q=]   channel list, filtered  /favorites  /recent  (/search redirects)
//   /guide                    TV guide
//   /settings  /settings/add  playlists
//   /account  /account/signup  /account/forgot
//   /verify  /reset  /oauth/authorize  /oauth/cli   (reached from outside)

let depth = history.state?.depth || 0;

const watchPath = () => (S.playing ? `/watch/${encodeURIComponent(S.playing.id)}` : '/');
function listPath() {
  const q = S.query ? `?q=${encodeURIComponent(S.query)}` : '';
  if (S.group === FAV) return `/favorites${q}`;
  if (S.group === RECENT) return `/recent${q}`;
  if (S.group === ALL) return `/channels${q}`;
  return `/channels/${encodeURIComponent(S.group)}${q}`;
}

/** The list opens where the playing channel is: the last group if it has it, else everything. */
function listPathForPlaying() {
  const has =
    S.group === FAV ? S.favs.has(S.playing?.id) : S.group === RECENT || S.group === ALL || S.group === S.playing?.group;
  if (!has) S.group = ALL;
  S.query = '';
  return listPath();
}

function push(path) {
  if (location.pathname + location.search === path) return;
  // fromTv: this view was opened over the picture, so stepping back from it IS closing.
  history.pushState({ depth: ++depth, fromTv: S.mode === 'tv' }, '', path);
}

/** ✕: back to the picture, whatever view chain led here. */
function closeToPicture() {
  if (history.state?.fromTv && (history.state?.depth || 0) > 0) return history.back();
  go(S.pl ? watchPath() : '/settings/add');
}

function go(path, { replace = false } = {}) {
  if (replace) history.replaceState({ depth }, '', path);
  else push(path);
  render(path);
}

/** Back one view; from a page opened cold, back to the picture rather than off the site. */
function back() {
  if ((history.state?.depth || 0) > 0) history.back();
  else go(S.pl ? watchPath() : '/settings/add', { replace: true });
}
const goBack = back;

addEventListener('popstate', (e) => {
  depth = e.state?.depth || 0;
  render(location.pathname + location.search);
});

function render(full) {
  const u = new URL(full, location.origin);
  const [view, arg] = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const needsPlaylist = ['watch', 'channels', 'favorites', 'recent', 'search', 'guide', undefined].includes(view);
  if (needsPlaylist && !S.pl) return go('/settings/add', { replace: true });
  switch (view) {
    case undefined:
    case 'watch':
      closeAll();
      if (S.playing) history.replaceState(history.state, '', watchPath());
      return;
    case 'channels':
      S.group = arg && S.live.some((c) => c.group === arg) ? arg : ALL;
      S.query = u.searchParams.get('q') || '';
      return openList();
    case 'favorites':
      S.group = FAV;
      S.query = u.searchParams.get('q') || '';
      return openList();
    case 'recent':
      S.group = RECENT;
      S.query = u.searchParams.get('q') || '';
      return openList();
    case 'search': {
      // Search became the filter on Live TV; old links still land there.
      const q = u.searchParams.get('q');
      return go(q ? `/channels?q=${encodeURIComponent(q)}` : '/channels', { replace: true });
    }
    case 'guide':
      G.q = u.searchParams.get('q') || '';
      return openGuide();
    case 'settings':
      return arg === 'add' ? openSetup(!S.playlists.length) : openSettings();
    case 'account':
      if (arg === 'signup') return openAccount({ tab: 'up' });
      if (arg === 'forgot') return openForgot();
      return openAccount();
    default:
      return go(S.pl ? watchPath() : '/', { replace: true });
  }
}

/* --------------------------------------------------------------- chrome */

function closeAll() {
  if (S.mode === 'guide') document.getElementById('app').prepend($('video'));
  $('list').hidden = true;
  $('guide').hidden = true;
  $('guide-info').innerHTML = '';
  $('sheet').hidden = true;
  S.mode = 'tv';
  navFocus = -1;
  syncNav();
}

/* ------------------------------------------------------------ global nav */

let navPinned = false; // shown over the picture until the chrome hides
let navFocus = -1; // index of the remote-focused nav button, -1 for none
const navButtons = () => [...$('nav').querySelectorAll('.nav-items button:not([hidden])')];

/** Which nav entry the screen in front of you is. */
function navCurrent() {
  if (S.mode === 'guide') return 'guide';
  if (S.mode === 'sheet') return $('sheet').dataset.screen || '';
  if (S.mode === 'list') return S.group === FAV ? 'favs' : S.group === RECENT ? 'recent' : 'live';
  return 'live';
}

function syncNav() {
  // Over any other view, the channel banner is clutter.
  if (S.mode !== 'tv') $('banner').hidden = true;
  const on = S.mode !== 'tv' || navPinned || navFocus >= 0;
  $('nav').hidden = !on;
  document.body.classList.toggle('nav-on', on);
  const cur = navCurrent();
  navButtons().forEach((b, i) => {
    b.classList.toggle('active', b.dataset.act === cur);
    b.classList.toggle('focus', i === navFocus);
  });
  navButtons()[navFocus]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function showNav() {
  if (!S.pl && S.mode === 'tv') return;
  navPinned = true;
  syncNav();
  if (S.mode === 'tv') showBanner();
}

/** Hand the remote to the nav, on the entry for the current screen. */
function focusNav() {
  const i = navButtons().findIndex((b) => b.dataset.act === navCurrent());
  navFocus = Math.max(0, i);
  clearTimeout(bannerTimer);
  syncNav();
}

function navAct(act) {
  navFocus = -1;
  const to = {
    // Live TV is always every channel; the groups are one press away inside it.
    live: S.mode === 'list' && S.group === ALL && !S.query ? null : '/channels',
    guide: '/guide',
    favs: '/favorites',
    recent: '/recent',
    account: '/account',
    settings: '/settings',
  }[act];
  if (to) go(to);
  else syncNav();
}

$('nav').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) navAct(b.dataset.act);
});

function updateNavAccount() {
  const b = $('nav-account');
  b.hidden = !api.serverInfo.accounts;
  const u = account.current();
  b.textContent = u ? `● ${u.username || u.email}` : 'Sign in';
  syncNav();
}

let toastTimer = 0;
function toast(text) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = el('div', 'toast');
    $('app').append(t);
  }
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

let lastTap = 0;
$('video').addEventListener('click', () => {
  if (S.mode !== 'tv') return back();
  const now = Date.now();
  if ($('video').muted) $('video').muted = false;
  if (now - lastTap < 300) toggleFullscreen();
  lastTap = now;
  $('nav').hidden ? showNav() : hideChrome();
});
let moveTimer = 0;
// A real mouse only: a tap on a phone also fires a synthetic mousemove, which
// showed the nav a moment before the tap's click hid it again.
addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || S.mode !== 'tv' || isTv) return;
  if ($('nav').hidden) showNav();
  clearTimeout(moveTimer);
  moveTimer = setTimeout(hideChrome, 3500);
});

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

function tick() {
  $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (S.mode === 'list') renderChannels();
  if (S.mode === 'guide') renderGuide();
}

/* ------------------------------------------------------------------ keys */

// Remote controls send these on the platforms that do not map to Escape.
const BACK_CODES = new Set([461, 10009, 8]); // webOS, Tizen, Backspace
let digits = '';
let digitTimer = 0;

function numberKey(d) {
  digits = (digits + d).slice(-4);
  const box = $('numentry');
  box.textContent = digits;
  box.hidden = false;
  clearTimeout(digitTimer);
  digitTimer = setTimeout(() => {
    const n = Number(digits);
    digits = '';
    box.hidden = true;
    const ch = S.live.find((c) => c.chno === n) || S.live[n - 1];
    if (ch) play(ch);
  }, 1300);
}

addEventListener('keydown', (e) => {
  if (navFocus >= 0 && !(e.target instanceof HTMLInputElement)) {
    const n = navButtons().length;
    const k = e.key;
    if (k === 'ArrowRight') navFocus = (navFocus + 1) % n;
    else if (k === 'ArrowLeft') navFocus = (navFocus - 1 + n) % n;
    else if (k === 'Enter' || k === ' ') return e.preventDefault(), navAct(navButtons()[navFocus].dataset.act);
    else if (k === 'ArrowDown' || k === 'Escape' || k === 'GoBack' || BACK_CODES.has(e.keyCode)) {
      navFocus = -1;
      if (S.mode === 'tv') hideChrome();
    } else return;
    e.preventDefault();
    return syncNav();
  }
  if (S.mode === 'sheet') {
    if (e.key === 'ArrowUp' && !(e.target instanceof HTMLInputElement) && e.target.closest?.('.card') == null)
      return focusNav();
    if (e.key === 'Escape' || e.key === 'GoBack' || BACK_CODES.has(e.keyCode)) {
      if (!(e.target instanceof HTMLInputElement) || e.key === 'Escape') goBack();
    }
    return;
  }
  const typing = e.target instanceof HTMLInputElement;
  const k = e.key;
  const back = k === 'Escape' || k === 'GoBack' || k === 'BrowserBack' || (BACK_CODES.has(e.keyCode) && !typing);

  if (typing && e.target.id === 'gq') {
    if (k === 'ArrowDown' || k === 'Enter') {
      e.target.blur();
      e.preventDefault();
    } else if (back) {
      e.target.blur();
      if (G.q) {
        e.target.value = '';
        e.target.dispatchEvent(new Event('input'));
      }
      e.preventDefault();
    }
    return;
  }
  if (typing) {
    if (k === 'ArrowDown' || k === 'Enter') {
      e.target.blur();
      S.pane = 'channels';
      renderChannels(true);
      e.preventDefault();
    } else if (back) {
      // Esc in the filter clears it; a second Esc leaves the list.
      e.target.blur();
      if (S.query) {
        S.query = '';
        e.target.value = '';
        history.replaceState(history.state, '', listPath());
        setView();
        updateCount();
        renderChannels(true);
      }
    }
    return;
  }

  if (S.mode === 'tv') {
    if (k === 'ArrowUp' || k === 'ChannelUp' || k === 'PageUp') zap(-1);
    else if (k === 'ArrowDown' || k === 'ChannelDown' || k === 'PageDown') zap(1);
    else if (k === 'Enter') go(listPathForPlaying());
    else if (k === ' ' || k === 'k' || k === 'MediaPlayPause') {
      togglePlay();
      showBanner();
    } else if (k === 'MediaPlay')
      $('video')
        .play()
        .catch(() => {});
    else if (k === 'MediaPause') $('video').pause();
    else if (k === '+' || k === '=' || k === 'AudioVolumeUp') {
      setVolume($('video').volume + 0.1);
      showBanner();
    } else if (k === '-' || k === 'AudioVolumeDown') {
      setVolume($('video').volume - 0.1);
      showBanner();
    } else if (k === 'ArrowLeft') {
      push(listPathForPlaying());
      openList({ groups: true });
    } else if (k === 'ArrowRight' || k === 'i' || k === 'Info') showBanner();
    else if (k === 'g' || k === 'Guide' || k === 'ColorF2Yellow') go('/guide');
    else if (k === 'f' || k === 'ColorF1Green') toggleFav(S.playing);
    else if (k === '/') {
      go(listPathForPlaying());
      $('q')?.focus();
    } else if (k === 's' || k === 'Settings') go('/settings');
    else if (k === 'm' || k === 'AudioVolumeMute') {
      $('video').muted = !$('video').muted;
      showBanner();
    } else if (/^\d$/.test(k)) numberKey(k);
    else if (k === 'Backspace' || k === 'Last') play(S.previous);
    else if (back || k === 'ContextMenu' || k === 'Menu') {
      // Back over the picture is the menu: the nav, ready for the remote.
      showNav();
      focusNav();
    } else return;
    e.preventDefault();
    return;
  }

  if (S.mode === 'list') {
    const atTop = S.pane === 'groups' ? S.groupFocus === 0 : S.focus === 0 || !S.view.length;
    if (k === 'ArrowUp' && atTop) focusNav();
    else if (k === 'ArrowUp') moveFocus(-1);
    else if (k === 'ArrowDown') moveFocus(1);
    else if (k === 'PageUp' || k === 'ChannelUp') moveFocus(-8);
    else if (k === 'PageDown' || k === 'ChannelDown') moveFocus(8);
    else if (k === 'ArrowLeft') {
      S.pane = 'groups';
      $('list').classList.add('groups-open');
      renderGroups();
      renderChannels();
    } else if (k === 'ArrowRight') {
      if (S.pane === 'groups') pickGroup(S.groupFocus);
      else go('/guide');
    } else if (k === 'Enter' || k === ' ') {
      if (S.pane === 'groups') pickGroup(S.groupFocus);
      else {
        const ch = S.view[S.focus];
        if (ch?.id === S.playing?.id && !S.catchup) goBack();
        else play(ch);
      }
    } else if (k === 'f' || k === 'ColorF1Green') toggleFav(S.view[S.focus]);
    else if (k === 'g' || k === 'Guide') go('/guide');
    else if (k === '/') $('q')?.focus();
    else if (/^\d$/.test(k)) numberKey(k);
    else if (back) {
      if (S.pane === 'groups') {
        S.pane = 'channels';
        $('list').classList.remove('groups-open');
        renderGroups();
        renderChannels();
      } else goBack();
    } else return;
    e.preventDefault();
    return;
  }

  if (S.mode === 'guide') {
    if (k === 'ArrowUp' && G.row === 0) focusNav();
    else if (k === 'ArrowUp') guideMove(-1, 0);
    else if (k === 'ArrowDown') guideMove(1, 0);
    else if (k === 'PageUp' || k === 'ChannelUp') guideMove(-8, 0);
    else if (k === 'PageDown' || k === 'ChannelDown') guideMove(8, 0);
    else if (k === 'ArrowLeft') guideMove(0, -1);
    else if (k === 'ArrowRight') guideMove(0, 1);
    else if (k === 'Enter' || k === ' ') guideOk();
    else if (k === 'f') toggleFav(G.list[G.row]);
    else if (k === '/') $('gq').focus();
    else if (back || k === 'g') goBack();
    else return;
    e.preventDefault();
  }
});

addEventListener('resize', () => {
  if (S.mode === 'list') renderChannels();
  if (S.mode === 'guide') renderGuide();
});

// For tests and the curious: the whole app state, read-only by convention.
globalThis.hdtilt = S;
boot();
