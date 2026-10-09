// HLS manifest rewriting for the stream proxy.
// Ported from tipoffwatch.com packages/playlists/src/hls.js (signing dropped:
// hdtilt proxies URLs the viewer supplied, behind the SSRF guard instead).

/** Attributes whose value is a url rather than a number or a name. */
const URI_ATTR = /URI="([^"]*)"/i;

/**
 * Rewrite every url in a playlist so the browser comes back to us for it.
 *
 * Three kinds of line carry one, and missing any of them breaks a real stream:
 *
 * - a bare line, which is a segment or a variant playlist
 * - `URI="…"` on EXT-X-KEY, which is the DECRYPTION KEY. Miss this and an
 *   encrypted stream fails in a way that looks like a codec bug.
 * - `URI="…"` on EXT-X-MAP (the init segment), EXT-X-MEDIA (alternate audio)
 *   and EXT-X-I-FRAME-STREAM-INF
 *
 * Relative urls are resolved against the playlist's own address first, because
 * that is what the browser would have done and our proxy is not at that address.
 */
export function rewritePlaylist(text, baseUrl, toProxy) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') {
      out.push(line);
      continue;
    }
    if (trimmed.startsWith('#')) {
      const m = URI_ATTR.exec(trimmed);
      if (m && /^#EXT-X-(KEY|MAP|MEDIA|I-FRAME-STREAM-INF|PART|PRELOAD-HINT|RENDITION-REPORT)/i.test(trimmed)) {
        let abs;
        try {
          abs = new URL(m[1], baseUrl).toString();
        } catch {
          out.push(line);
          continue;
        }
        out.push(trimmed.replace(URI_ATTR, `URI="${toProxy(abs)}"`));
        continue;
      }
      out.push(line);
      continue;
    }
    let abs;
    try {
      abs = new URL(trimmed, baseUrl).toString();
    } catch {
      out.push(line);
      continue;
    }
    out.push(toProxy(abs));
  }
  return out.join('\n');
}

/** Whether a response body should be treated as a playlist to rewrite. */
export function isPlaylist(contentType, url) {
  if (/mpegurl/i.test(contentType ?? '')) return true;
  return /\.m3u8(\?|$)/i.test(String(url ?? ''));
}
