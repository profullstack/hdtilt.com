// What is on, given a parsed guide. Pure functions over sorted programme lists.

/** Lowercased, accents and punctuation gone, "HD"/"FHD"/"4K" suffixes dropped. */
export function normName(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(uhd|fhd|hd|sd|4k|hevc|h265|\+1)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Decide which guide id each channel's programmes are filed under.
 *
 * `tvg-id` wins when the guide has it. Otherwise a channel is matched on its
 * display name, which is how most hand-made lists work, since they carry a
 * logo and a group but no id.
 *
 * @returns {Map<string, string>} channel id -> guide id
 */
export function matchChannels(channels, guideChannels) {
  const byName = new Map();
  for (const g of guideChannels.values()) {
    for (const n of g.names) {
      const k = normName(n);
      if (k && !byName.has(k)) byName.set(k, g.id);
    }
    const k = normName(g.id.replace(/\.[a-z]{2,3}$/i, ''));
    if (k && !byName.has(k)) byName.set(k, g.id);
  }
  const out = new Map();
  for (const c of channels) {
    if (c.tvgId && guideChannels.has(c.tvgId)) out.set(c.id, c.tvgId);
    else {
      const hit = byName.get(normName(c.name)) || (c.tvgId && byName.get(normName(c.tvgId)));
      if (hit) out.set(c.id, hit);
    }
  }
  return out;
}

/** Index of the programme on air at `t`, or -1. Binary search; lists are sorted. */
export function indexAt(list, t) {
  let lo = 0;
  let hi = (list?.length || 0) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = list[mid];
    if (t < p.start) hi = mid - 1;
    else if (t >= p.stop) lo = mid + 1;
    else return mid;
  }
  return -1;
}

export function nowNext(list, t = Date.now()) {
  if (!list?.length) return { now: null, next: null };
  const i = indexAt(list, t);
  if (i >= 0) return { now: list[i], next: list[i + 1] || null };
  const next = list.find((p) => p.start > t) || null;
  return { now: null, next };
}

/** Programmes overlapping [from, to). */
export function between(list, from, to) {
  if (!list?.length) return [];
  return list.filter((p) => p.stop > from && p.start < to);
}

/** 0..1 through the current programme. */
export const progress = (p, t = Date.now()) => (p ? Math.min(1, Math.max(0, (t - p.start) / (p.stop - p.start))) : 0);
