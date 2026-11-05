# hdtilt for Fire TV

A small native Android app (`com.hdtilt.tv`) that puts https://hdtilt.com on a Fire TV.
No dependencies beyond the Android SDK.

- **WebView** on hdtilt.com. The web app already drives itself with a remote (arrows, OK,
  Back, focus ring, big page buttons): the Fire TV user agent turns its TV mode on, so keys
  go straight to the page.
- **Typing**: OK on a text field opens a native text box when the page has not raised the
  keyboard itself (the reliable way to get the Fire TV keyboard and its microphone); the text
  goes back into the field as typed input.
- **Media keys** play/pause, fast-forward 30 s and rewind 15 s on the page's video.
- **Back** walks WebView history (every hdtilt view has an address), then exits. Full-screen
  video and an offline screen are native. Cookies are flushed on pause so sign-in sticks.
- Leanback launcher + banner, touchscreen not required, so the Appstore lists it for Fire TV.

Same shell as podcasters (profullstack/p0dcasters `firetv/`) and pit.world.

## Build

Needs only Docker. The SDK caches in `~/scratch/android-sdk`.

```sh
# release key (once, ever): vault profullstack/hdtilt-firetv--signing
logicsrc teams pull profullstack hdtilt-firetv signing --env keys/release.env
sed -n 's/^PIT_TV_KEYSTORE_B64=//p' keys/release.env | tr -d '"' | base64 -d > keys/release.jks

docker run --rm -e OWNER=$(id -u):$(id -g) -e GRADLE_USER_HOME=/gh \
  -v ~/scratch/gradle-home:/gh -v ~/scratch/android-sdk:/sdk -v "$PWD/keys:/keys:ro" \
  -v "$PWD/appstores/firetv:/w" -w /w gradle:8.7-jdk17 sh build.sh
# -> firetv/dist/hdtilt-firetv.apk (lint + signed release)
```

Without `/keys` the APK is built unsigned. Bump `versionCode`/`versionName` in
`app/build.gradle` for every Appstore upload. `new-key.sh` minted the key
(cert SHA-256 3f5e83d8…97eb); never run it again or installed copies cannot update.

## Test on an Android TV emulator

```sh
docker run --rm --device /dev/kvm -e OWNER=$(id -u):$(id -g) -v ~/scratch/android-sdk:/sdk \
  -v "$PWD/appstores/firetv:/w" -w /w gradle:8.7-jdk17 bash emulator-test.sh
```

Boots API 30 Android TV (the base of Fire OS 8), installs the APK, drives it with key
events and writes 1920x1080 screenshots to `store/shots/`.

## Appstore

Listing copy and the art map are in `store/listing.md`; `store/render.sh` regenerates the
icons/banner from `store/src/*.svg`.
