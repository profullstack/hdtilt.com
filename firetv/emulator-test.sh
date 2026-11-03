#!/bin/bash
# Boots an Android TV emulator (API 30, the base of Fire OS 8), installs the APK,
# drives it with remote-control keys and saves 1920x1080 screenshots to store/shots.
# Runs inside gradle:8.7-jdk17 with --device /dev/kvm and the SDK cache at /sdk:
#   docker run --rm --device /dev/kvm -v ~/scratch/android-sdk:/sdk -v "$PWD/firetv:/w" -w /w \
#     gradle:8.7-jdk17 bash emulator-test.sh
set -euo pipefail
SDK=/sdk
export ANDROID_HOME=$SDK ANDROID_SDK_ROOT=$SDK ANDROID_AVD_HOME=/root/.android/avd
IMG="system-images;android-30;android-tv;x86"
PKG=com.hdtilt.tv

apt-get update -qq >/dev/null
apt-get install -y -qq libpulse0 libnss3 libxcomposite1 libxcursor1 libxi6 libxtst6 \
  libasound2 libgl1 libxkbfile1 libxdamage1 libxrandr2 libdrm2 libgbm1 >/dev/null 2>&1

SM="$SDK/cmdline-tools/latest/bin/sdkmanager --sdk_root=$SDK"
(yes || true) | $SM --licenses >/dev/null || true   # yes dies of SIGPIPE: not a failure
$SM "emulator" "platform-tools" "$IMG" >/dev/null

echo no | "$SDK/cmdline-tools/latest/bin/avdmanager" create avd -n tv -k "$IMG" -d tv_1080p --force >/dev/null
ADB="$SDK/platform-tools/adb"
"$SDK/emulator/emulator" -avd tv -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect \
  -no-snapshot -memory 2048 >/tmp/emu.log 2>&1 &

"$ADB" wait-for-device
for i in $(seq 1 120); do
  [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break
  sleep 2
done
echo "booted"

for i in $(seq 1 20); do "$ADB" install -r dist/hdtilt-firetv.apk && break; sleep 5; done
mkdir -p store/shots
shot() { "$ADB" exec-out screencap -p > "store/shots/$1.png"; echo "shot $1"; }
key() { "$ADB" shell input keyevent "$@"; sleep 1.5; }
focus() { "$ADB" shell dumpsys window 2>/dev/null | grep -m1 mCurrentFocus || true; }

# 1. Leanback launch: signed out, hdtilt.com opens its sign-up / sign-in sheet.
"$ADB" shell monkey -p $PKG -c android.intent.category.LEANBACK_LAUNCHER 1 >/dev/null
sleep 15
focus
shot 01-launch

# 2. The page moves focus with the arrows; OK on a field raises the native keyboard.
key KEYCODE_DPAD_DOWN
key KEYCODE_DPAD_CENTER
sleep 2
focus
shot 02-keyboard
"$ADB" shell input text "riotcoder"
key KEYCODE_ENTER
sleep 2
shot 03-typed

# 3. Back leaves the app (or steps back through the app's views first).
key KEYCODE_BACK
key KEYCODE_BACK
key KEYCODE_BACK
sleep 2
focus

"$ADB" logcat -d | grep -E "AndroidRuntime|FATAL|$PKG|chromium.*Uncaught" | tail -20 || true
[ -n "${OWNER:-}" ] && chown -R "$OWNER" store/shots
ls -l store/shots
