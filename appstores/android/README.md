# Google Play (hdtilt.com)

A WebView shell for https://hdtilt.com. Package `com.hdtilt.app`, minSdk 24, targetSdk 35.

## Build

```sh
docker run --rm -e OWNER=$(id -u):$(id -g) \
  -v "$PWD/android-sdk:/sdk" -v "$PWD/keys:/keys" \
  -v "$PWD/appstores/android:/w" -w /w gradle:8.7-jdk17 sh build.sh
```

`dist/hdtilt.aab` is what Play takes; `dist/hdtilt.apk` is for sideloading and testing.
Art: `docker run --rm -v "$PWD/appstores/android:/w" -w /w alpine:3.20 sh store/render.sh`.

## Signing

The upload key is in vault `profullstack/hdtilt-android--signing`
(`ANDROID_KEYSTORE_B64`, `ANDROID_STORE_PASSWORD`, `ANDROID_KEY_ALIAS`).

This is the **upload** key, not the app signing key. Once enrolled in Play App
Signing, Google holds the signing key and re-signs every upload, so a lost upload
key can be reset by support; a lost Play-managed signing key cannot. `new-key.sh`
refuses to mint a second one.

## What it adds over the website

Play rejects a bare web wrapper. This one is a launcher entry plus: `hdtilt.com` links
opening in the app (`autoVerify` App Links), the system Back button walking the
page's own history, `<input type=file>` working (a WebView does nothing on file
inputs without `onShowFileChooser`), `getUserMedia` bridged to Android's own
permission prompt, full-screen video, and an offline screen instead of Chrome's.

## Before the first release

- Play Console account: **anthony@profullstack.com**.
- Play takes an **.aab**, never an APK, and raises its `targetSdk` floor every
  August — check it rather than trusting the 35 here.
- `applicationId` can never change after publishing.
- The Data safety form and content rating questionnaire are required, and ask the
  same facts as Amazon's listing in a different shape.
- A new personal Play account needs 12 testers on a closed test for 14 days before
  production opens. An organisation account needs D-U-N-S verification instead.

## Listing

Copy and art live in `store/` — see `store/listing.md`.

## The WebView floor, and how it was found

The app renders correctly on a WebView reporting **83.0.4103.106** (an API 30
emulator), which is the oldest engine this has been tested against. Getting there
took two fixes, and the second is the instructive one:

1. The web bundle is built by esbuild against `chrome70`, not Bun. Bun's bundler has
   no browser version knob and emits `??=` in its own generated helpers, so the
   script failed to parse below Chromium 85 and the page was blank.
2. **Lowering syntax was not enough.** A bundler never polyfills *methods*, and the
   account screen called `String.replaceAll` (Chromium 85), so the WebView threw on
   the first screen and the page was still blank. `web/build.js` now fails the build
   when the output contains a method newer than the floor.

Play devices update WebView through the Play Store, so none of this is visible on a
current phone. It matters for `../firetv`, where the engine is frozen — and because
the Fire TV app loads the live site, fixing the site fixed that app too, with no new
APK needed.
