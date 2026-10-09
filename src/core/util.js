/** FNV-1a, base 36. Stable ids for channels a list gives no id. */
export function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** base64url without Buffer, so the browser can build proxy paths too. */
export function b64urlEncode(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s) {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** `/p/<b64>/<name.ext>`: the player picks its engine from the path's extension. */
export function proxyPath(url, kindHint) {
  let name = 'stream';
  try {
    name = new URL(url).pathname.split('/').pop() || 'stream';
  } catch {}
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
    name = `${name}.${kindHint === 'hls' ? 'm3u8' : kindHint === 'mp4' ? 'mp4' : 'ts'}`;
  }
  return `/p/${b64urlEncode(url)}/${encodeURIComponent(name)}`;
}
