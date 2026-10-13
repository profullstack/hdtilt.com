#!/bin/sh
# Install hdtilt, the open-source IPTV player (npm: hdtilt).
#
#   curl -fsSL https://hdtilt.com/install.sh | sh
#
# Installs the `hdtilt` command (CLI, terminal guide, MCP and local web app)
# with bun if present, otherwise npm (Node >= 22.6). When the global npm
# prefix is not writable it installs into ~/.local instead of asking for sudo.
#
# On a Linux desktop session it also installs the desktop app (AppImage) into
# ~/.local, with a menu entry. Override with:
#
#   curl -fsSL https://hdtilt.com/install.sh | sh -s -- --cli-only
#   curl -fsSL https://hdtilt.com/install.sh | sh -s -- --desktop
#
# Re-running upgrades both. Nothing here needs root.
set -eu

PKG="hdtilt"
REPO="profullstack/hdtilt.com"

say() { printf '%s\n' "$*"; }
warn() { printf 'hdtilt install: %s\n' "$*" >&2; }
die() { printf 'hdtilt install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

desktop=auto
for arg in "$@"; do
  case "$arg" in
    --cli-only) desktop=no ;;
    --desktop) desktop=yes ;;
    -h|--help)
      say "Usage: install.sh [--cli-only | --desktop]"
      say "  --cli-only  skip the desktop app even in a desktop session"
      say "  --desktop   install the Linux desktop app (AppImage) even without a display"
      exit 0
      ;;
    *) die "unknown option: $arg (try --help)" ;;
  esac
done

fetch() { # url dest
  if have curl; then curl -fsSL "$1" -o "$2"
  elif have wget; then wget -qO "$2" "$1"
  else die "needs curl or wget"
  fi
}

# ---------------------------------------------------------------- CLI

say "Installing hdtilt (CLI, TUI, MCP and local web app)..."

if have bun; then
  # A fresh global dir has no package.json, and then `bun add -g` walks up
  # and adds hdtilt to the first package.json above it (~/package.json, say).
  global="${BUN_INSTALL:-$HOME/.bun}/install/global"
  mkdir -p "$global"
  [ -f "$global/package.json" ] || printf '{"dependencies":{}}\n' > "$global/package.json"
  bun add -g "$PKG"
  BIN_DIR="${BUN_INSTALL:-$HOME/.bun}/bin"
elif have npm && have node; then
  ver=$(node -p 'process.versions.node' 2>/dev/null || echo 0.0.0)
  major=${ver%%.*}
  rest=${ver#*.}
  minor=${rest%%.*}
  if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 6 ]; }; then
    die "Node >= 22.6 required (found v$ver). Upgrade Node or install bun: https://bun.sh"
  fi
  prefix=$(npm config get prefix)
  modules="$prefix/lib/node_modules"
  [ -d "$modules" ] || modules="$prefix/lib"
  if [ -w "$modules" ] && [ -w "$prefix/bin" ]; then
    npm install -g "$PKG"
    BIN_DIR="$prefix/bin"
  else
    BIN_DIR="$HOME/.local/bin"
    say "npm prefix $prefix is not writable; installing into $HOME/.local"
    npm install -g --prefix "$HOME/.local" "$PKG"
  fi
else
  die "needs bun (https://bun.sh) or Node >= 22.6 with npm (https://nodejs.org)"
fi

# The bin is a `#!/usr/bin/env node` script. With bun and no node on PATH,
# point a small shim at bun instead (hdtilt runs on both).
if [ -x "$BIN_DIR/hdtilt" ] && ! have node && have bun; then
  pkg_dir="${BUN_INSTALL:-$HOME/.bun}/install/global/node_modules/$PKG"
  if [ -f "$pkg_dir/bin/hdtilt.js" ]; then
    rm -f "$BIN_DIR/hdtilt"
    printf '#!/bin/sh\nexec bun "%s/bin/hdtilt.js" "$@"\n' "$pkg_dir" > "$BIN_DIR/hdtilt"
    chmod +x "$BIN_DIR/hdtilt"
  fi
fi

# ---------------------------------------------------------- desktop app

if [ "$desktop" = auto ]; then
  desktop=no
  if [ "$(uname -s)" = Linux ] && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ] || [ -n "${XDG_CURRENT_DESKTOP:-}" ]; }; then
    desktop=yes
  fi
fi

APP_DIR="$HOME/.local/share/hdtilt"
desktop_done=""
if [ "$desktop" = yes ]; then
  if [ "$(uname -s)" != Linux ]; then
    warn "the desktop app is installed by this script on Linux only; get it from https://github.com/$REPO/releases/latest"
  elif [ "$(uname -m)" != x86_64 ]; then
    warn "no AppImage for $(uname -m) yet; skipping the desktop app"
  else
    say ""
    say "Installing the hdtilt desktop app (AppImage)..."
    tag=""
    if have curl; then
      tag=$(curl -fsSI "https://github.com/$REPO/releases/latest" 2>/dev/null | tr -d '\r' | sed -n 's#^[Ll]ocation: .*/releases/tag/v##p')
    fi
    [ -n "$tag" ] || tag=$(npm view "$PKG" version 2>/dev/null || true)
    if [ -z "$tag" ]; then
      warn "could not find the latest release; skipping the desktop app"
    else
      mkdir -p "$APP_DIR" "$HOME/.local/bin" "$HOME/.local/share/applications" \
        "$HOME/.local/share/icons/hicolor/scalable/apps"
      tmp="$APP_DIR/.hdtilt.AppImage.part"
      if fetch "https://github.com/$REPO/releases/download/v$tag/hdtilt-$tag.AppImage" "$tmp"; then
        chmod +x "$tmp"
        mv -f "$tmp" "$APP_DIR/hdtilt.AppImage"
        fetch "https://hdtilt.com/icon.svg" "$HOME/.local/share/icons/hicolor/scalable/apps/hdtilt.svg" || true
        ln -sf "$APP_DIR/hdtilt.AppImage" "$HOME/.local/bin/hdtilt-desktop"
        cat > "$HOME/.local/share/applications/hdtilt.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=hdtilt
Comment=Open-source IPTV player with a TV guide
Exec=$APP_DIR/hdtilt.AppImage %U
Icon=hdtilt
Terminal=false
Categories=AudioVideo;Video;Player;TV;
EOF
        have update-desktop-database && update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
        desktop_done="$tag"
      else
        rm -f "$tmp"
        warn "could not download the AppImage for v$tag; skipping the desktop app"
      fi
    fi
  fi
fi

# ------------------------------------------------------------- summary

say ""
if have hdtilt; then
  say "$(hdtilt --version 2>/dev/null || echo hdtilt) installed."
else
  say "hdtilt installed to $BIN_DIR, which is not on your PATH. Add it:"
  say "  export PATH=\"$BIN_DIR:\$PATH\""
fi
if [ -n "$desktop_done" ]; then
  say "Desktop app v$desktop_done installed: $APP_DIR/hdtilt.AppImage (menu entry \"hdtilt\", or run hdtilt-desktop)."
  say "If it will not start, your system may need libfuse2 for AppImages."
fi
say ""
say "Next:"
say "  hdtilt add home 'http://provider.example/get.php?username=U&password=P&type=m3u_plus'"
say "  hdtilt now      # what is on"
say "  hdtilt tui      # browse and play (needs mpv or VLC)"
say "  hdtilt serve    # the web app on http://127.0.0.1:8930"
