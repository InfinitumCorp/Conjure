#!/usr/bin/env bash
# Builds android/build/conjure.apk without Gradle: aapt2 -> javac -> d8 -> zipalign -> apksigner.
# Needs: Android SDK (ANDROID_HOME or the default Windows location), a JDK with javac,
# and a debug keystore (~/.android/debug.keystore; created with keytool if missing).
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$LOCALAPPDATA/Android/Sdk}}"
SDK="${SDK//\\//}"
BT="$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)"
PLATFORM="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)"
JAR="$PLATFORM/android.jar"
EXE=""; BAT=""
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXE=".exe"; BAT=".bat";; esac
echo "build-tools: $BT"
echo "platform:    $PLATFORM"

rm -rf build && mkdir -p build/res build/classes build/dex

"$BT/aapt2$EXE" compile --dir res -o build/res.zip
"$BT/aapt2$EXE" link -I "$JAR" --manifest AndroidManifest.xml -o build/unsigned.apk \
  --java build/gen build/res.zip --auto-add-overlay

javac --release 11 -nowarn -cp "$JAR" -d build/classes \
  $(find src build/gen -name '*.java')

"$BT/d8$BAT" --release --min-api 24 --lib "$JAR" --output build/dex \
  $(find build/classes -name '*.class')

cp build/dex/classes.dex build/classes.dex
(cd build && jar uf unsigned.apk classes.dex 2>/dev/null || zip -q unsigned.apk classes.dex)

"$BT/zipalign$EXE" -f -p 4 build/unsigned.apk build/aligned.apk

KS="${CONJURE_KEYSTORE:-$HOME/.android/debug.keystore}"
if [ ! -f "$KS" ]; then
  mkdir -p "$(dirname "$KS")"
  keytool -genkeypair -keystore "$KS" -storepass android -alias androiddebugkey -keypass android \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
fi
"$BT/apksigner$BAT" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --out build/conjure.apk build/aligned.apk
"$BT/apksigner$BAT" verify build/conjure.apk
echo "✓ $(pwd)/build/conjure.apk ($(wc -c < build/conjure.apk) bytes)"
