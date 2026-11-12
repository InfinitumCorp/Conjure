#!/usr/bin/env bash
# Builds android/build/conjure.apk without Gradle. Set CONJURE_URL to choose the server the app opens.
# Builds without Gradle: aapt2 -> javac -> d8 -> zipalign -> apksigner.
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

# Amplitude Android SDK and its runtime dependencies, pinned by SHA-256 (see scripts/fetch-deps.sh).
bash scripts/fetch-deps.sh
DEPS=.deps
SEP=":"; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) SEP=";";; esac
DEP_JARS="$(ls "$DEPS"/jars/*.jar)"
DEP_CP="$(printf '%s' "$DEP_JARS" | tr '\n' "$SEP")"
LIB_RES=()
for r in "$DEPS"/res/*/; do
  n="$(basename "$r")"
  "$BT/aapt2$EXE" compile --dir "$r" -o "build/lib-$n.zip"
  LIB_RES+=("build/lib-$n.zip")
done

RES=res
if [ -n "${CONJURE_URL:-}" ]; then
  case "$CONJURE_URL" in http://*|https://*) ;; *) echo "CONJURE_URL must start with http:// or https://"; exit 1;; esac
  url="${CONJURE_URL%/}/"
  cp -r res build/res-src && RES=build/res-src
  # Plain URL characters only: nothing that needs XML or sed escaping.
  if ! printf '%s' "$url" | grep -Eq '^https?://[A-Za-z0-9._~:/?=%-]+$'; then echo "CONJURE_URL has unsupported characters"; exit 1; fi
  sed -i "s|<string name=\"server_url\"[^>]*>[^<]*</string>|<string name=\"server_url\" translatable=\"false\">$url</string>|" "$RES/values/config.xml"
  echo "server:      $url"
fi
"$BT/aapt2$EXE" compile --dir "$RES" -o build/res.zip
"$BT/aapt2$EXE" link -I "$JAR" --manifest AndroidManifest.xml -o build/unsigned.apk \
  --java build/gen --extra-packages "$(cat "$DEPS/packages.txt")" \
  "${LIB_RES[@]}" build/res.zip --auto-add-overlay

javac --release 11 -nowarn -cp "$JAR$SEP$DEP_CP" -d build/classes \
  $(find src build/gen -name '*.java')

"$BT/d8$BAT" --release --min-api 24 --lib "$JAR" --output build/dex \
  $(find build/classes -name '*.class') $DEP_JARS

cp build/dex/classes*.dex build/
(cd build && jar uf unsigned.apk classes*.dex 2>/dev/null || zip -q unsigned.apk classes*.dex)
# ServiceLoader files from the dependencies (kotlinx-coroutines' Main dispatcher).
(cd "$DEPS/services" && jar uf ../../build/unsigned.apk META-INF 2>/dev/null || zip -qr ../../build/unsigned.apk META-INF)

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
