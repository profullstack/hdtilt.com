#!/bin/sh
# Renders the launcher icons, TV banner and Amazon Appstore art.
# Icons come from the site's own logo (store/src/logo.svg = web/public/icon.svg).
# Runs inside alpine (see firetv/README.md):
#   docker run --rm -e OWNER=$(id -u):$(id -g) -v "$PWD/firetv:/w" -w /w alpine:3.20 sh store/render.sh
set -eu
apk add --no-cache rsvg-convert imagemagick font-dejavu >/dev/null
R=app/src/main/res
O=store/out
L=store/src/logo-512.png
mkdir -p "$O" "$R/mipmap-xhdpi" "$R/mipmap-xxhdpi" "$R/drawable-xhdpi"
rsvg-convert -w 512 -h 512 store/src/logo.svg -o "$L"

magick "$L" -resize 96x96 "$R/mipmap-xhdpi/ic_launcher.png"
magick "$L" -resize 144x144 "$R/mipmap-xxhdpi/ic_launcher.png"
magick "$L" -resize 512x512 "$O/icon-512.png"
magick "$L" -resize 114x114 "$O/icon-114.png"

cd store/src
rsvg-convert -w 320 -h 180 banner.svg -o "../../$R/drawable-xhdpi/banner.png"
rsvg-convert -w 1280 -h 720 banner.svg -o ../out/firetv-icon-1280x720.png
rsvg-convert -w 1920 -h 1080 background.svg -o ../out/firetv-background-1920x1080.png
cd ../..
# Fire TV art may not carry transparency.
magick "$O/firetv-icon-1280x720.png" -background "#0b0f14" -alpha remove -alpha off "$O/firetv-icon-1280x720.png"
magick "$O/firetv-background-1920x1080.png" -background "#0b0f14" -alpha remove -alpha off "$O/firetv-background-1920x1080.png"

[ -n "${OWNER:-}" ] && chown -R "$OWNER" "$R" "$O"
ls -l "$O"
