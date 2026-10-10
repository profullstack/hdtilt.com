# hdtilt

**An open-source IPTV player that works like TiviMate.** Bring your own M3U playlist or Xtream Codes login and get a channel list, a TV guide and catch-up. It runs in the browser (installable PWA), on the desktop, and in the terminal.

**[hdtilt.com](https://hdtilt.com)** · MIT licensed · no account, no tracking, no channels included

hdtilt is a player. It ships with no content. You add a playlist from a provider you already pay for, or from any source you have the right to watch.

## What it does

- **Playlists:** M3U / M3U8 URLs, local `.m3u` files, Xtream Codes (`player_api.php`) logins. An Xtream `get.php` link pasted as an M3U is detected and upgraded to the Xtream API.
- **TV guide:** XMLTV (plain or `.gz`), taken from the playlist's `url-tvg` or given by hand. Channels are matched by `tvg-id`, then by name. Shows what's on now and next, with progress bars and a full guide grid.
- **Catch-up:** Xtream timeshift, plus the M3U `catchup` / `catchup-source` / `tvg-rec` forms (`default`, `append`, `shift`, `flussonic`).
- **Playback** through [`@profullstack/player`](https://github.com/profullstack/player): HLS (hls.js), MPEG-TS (mpegts.js) and MP4. It restarts stalled live streams and explains codec failures.
- **One page per view:** `/watch/<channel>`, `/channels/<group>`, `/favorites`, `/recent`, `/guide` (lists take `?q=` to filter), `/settings`, `/account`. Each can be bookmarked or reloaded, and the browser's Back button (or a remote's) steps back through them.
- **A global nav** with Live TV (with a filter box), TV Guide, ★ Favorites, Recent, Account and Settings. It is always on screen outside the picture; over the picture, Back or Menu brings it up, focused for the remote.
- **iPhone and iPad Safari:** they have no Media Source Extensions, so they cannot play an MPEG-TS stream directly. hdtilt asks an Xtream line for its HLS version when it offers one, and otherwise the server repackages the stream as HLS (`ffmpeg -c copy`, no transcoding, shared by everyone watching that channel). Self-hosters need `ffmpeg` on the PATH, or `HDTILT_FFMPEG`.
- **Favorites:** tap ☆ on any channel row or on the channel banner, or press F. They sit under ★ Favorites in the nav and sync with your account.
- **The TiviMate basics:** ↑/↓ zaps channels, OK opens the list, ◀ opens groups, digits jump to a channel number, Back returns to the last channel. Favorites, recents and search are built in. Works with a mouse, touch, a keyboard or a TV remote (Fire TV, Android TV, webOS, Tizen keys).

## Accounts

On hdtilt.com an account comes first: sign up (username, email, password), confirm the email, then add your playlist. It keeps your playlists, favorites and recent channels the same on every screen you watch on. The desktop app and a self-hosted `hdtilt serve` need no account.

- **Username and password.** Sign in with either your username or your email. A TV has no mail client and no passkey, so a password is the way in on one.
- **The email is confirmed before the account can sign in.** The link signs you straight in, and "Forgot your password?" sends a reset link.
- **The CLI and TUI sign in with OAuth 2.1:** `hdtilt login` opens the browser (authorization code + PKCE, a loopback redirect), and `hdtilt login --manual` works over SSH by pasting a code. Tokens live in `~/.config/hdtilt/auth.json` (0600). `hdtilt sync` merges the account's playlists and favorites into the local config, and `hdtilt tui` syncs when it starts.
- Provider logins inside a synced library are encrypted at rest (AES-256-GCM).

## Every surface

| Surface | How |
| --- | --- |
| Web / PWA | [hdtilt.com](https://hdtilt.com), or `hdtilt serve` on your own box |
| Desktop | Electron app (Linux AppImage/deb, macOS dmg, Windows exe) from [Releases](https://github.com/profullstack/hdtilt.com/releases) |
| CLI | `hdtilt now`, `hdtilt play cnn`, `hdtilt guide 101` … |
| TUI | `hdtilt tui`: groups, channels and what's on; Enter plays in mpv or VLC |
| MCP | `hdtilt mcp` (stdio), or `POST /mcp` on any server |
| API | JSON under `/api`, plus the stream proxy at `/p/` |

## Install

```sh
npm i -g hdtilt        # or: bunx hdtilt
hdtilt add home http://provider.example/get.php?username=U&password=P&type=m3u_plus
hdtilt now             # what's on
hdtilt tui             # browse and play (needs mpv or VLC)
hdtilt serve           # the web app on http://127.0.0.1:8930
```

Xtream Codes:

```sh
hdtilt add home --xtream http://provider.example:8080 --user U --pass P
```

Playlists and logins live in `~/.config/hdtilt/config.json` (mode 0600). The desktop app and `hdtilt serve` read the same file, so a playlist added from the CLI shows up in the window.

## CLI

```
hdtilt add <name> <m3u-url> [--epg <xmltv-url>]
hdtilt add <name> --xtream <server> --user <u> --pass <p>
hdtilt playlists | use <name> | remove <name> | refresh [name]
hdtilt groups
hdtilt channels [query] [--group <g>] [--json]
hdtilt now [query] [--group <g>]
hdtilt guide <channel> [--hours 12] [--from -6]
hdtilt url <channel> [--at <iso-time>]      # --at = catch-up
hdtilt play <channel> [--player mpv|vlc|ffplay]
hdtilt fav <channel>
hdtilt login [--manual] | whoami | sync | logout
hdtilt tui | serve [--port] [--host] [--public] | mcp
```

A channel can be named by its number, its id, or part of its name.

## MCP

Add it to any MCP client:

```json
{ "mcpServers": { "hdtilt": { "command": "npx", "args": ["-y", "hdtilt", "mcp"] } } }
```

Tools: `list_playlists`, `add_playlist`, `list_groups`, `list_channels`, `whats_on`, `channel_guide`, `stream_url` (with catch-up). Over HTTP (`POST /mcp`), a public server keeps no playlists, so every call passes its own `source`.

## API

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/api/health` | `{ ok, version, public }` |
| POST | `/api/load` | `{ source }` → `{ channels, groups, epgUrl, account }` |
| POST | `/api/guide` | `{ url, channels:[{id,name,tvgId}], from?, to? }` → `{ programmes: { [channelId]: [...] } }` |
| POST | `/api/nownext` | `{ url, channels }` → `{ [channelId]: { now, next } }` |
| GET | `/api/playlists`, `/api/playlists/:name` | local installs only |
| POST | `/api/auth/register` `login` `verify` `resend` `forgot` `reset` `refresh` `logout` | accounts (20 tries a minute per address) |
| GET | `/api/me` | the signed-in account (`Authorization: Bearer`, a session or an OAuth token) |
| GET / PUT | `/api/library` | the synced library; PUT `{ data, baseVersion }`, 409 if another device wrote first |
| GET | `/.well-known/oauth-authorization-server` | OAuth 2.1 metadata; `/oauth/token`, `/oauth/revoke`; client `hdtilt-cli` |
| GET | `/hls/<base64url>/index.m3u8` | an MPEG-TS stream repackaged as HLS (for browsers without MSE) |
| GET | `/p/<base64url>/<name.ext>` | stream proxy; HLS playlists are rewritten so segments and keys come back through it |
| POST | `/mcp` | MCP JSON-RPC |

`source` is `{ "type": "m3u", "url": "…" }` or `{ "type": "xtream", "server": "…", "username": "…", "password": "…" }`, plus an optional `"epg"`.

## Privacy and the proxy

On hdtilt.com, playlists and logins are kept **in your browser** (IndexedDB) and sent to the server only to load the list. Nothing is stored there. Browsers can't play `http://` streams on an `https://` page, and most provider streams don't send CORS headers, so those streams pass through hdtilt.com's proxy. The public proxy only serves signed-in viewers (an HttpOnly media cookie set at sign-in, since a video element cannot send a token), refuses private and internal addresses, and limits each viewer to 3 concurrent streams.

If you'd rather nothing sat in between, use the desktop app or `hdtilt serve`. Both run the same server on your own machine, where the proxy can also reach tuners on your LAN.

## Self-hosting

```sh
git clone https://github.com/profullstack/hdtilt.com && cd hdtilt.com
bun install && bun run build
PORT=8930 node bin/hdtilt.js serve --host 0.0.0.0 --public   # --public for a shared server
```

Environment: `PORT`, `HOST`, `HDTILT_PUBLIC=1`, `HDTILT_JWT_SECRET` (turns accounts on), `DATABASE_URL` (Postgres for accounts; memory without it), `HDTILT_LIBRARY_KEY`, `RESEND_API_KEY`, `MAIL_FROM`, `SITE_URL`, `HDTILT_ISSUER` (the CLI's account server), `HDTILT_UA` (the user-agent sent to providers), `HDTILT_HOME` / `HDTILT_CACHE`, `HDTILT_PLAYER`.

## Development

```sh
bun install
bun test          # core, server, proxy, MCP and CLI against a fake provider
bun run lint
bun run dev       # build the web app and serve it
bun run desktop   # the Electron window
```

Layout: `src/core` (playlists, Xtream, XMLTV, guide, config; most of it also runs in the browser), `src/server` (HTTP + MCP), `src/cli` (TUI, player launcher), `web/` (the PWA), `desktop/` (Electron), `bin/hdtilt.js`.

## License

MIT © Profullstack, Inc.
