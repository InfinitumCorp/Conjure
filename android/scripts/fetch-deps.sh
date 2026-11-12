#!/usr/bin/env bash
# Fetch the official Amplitude Android SDK (com.amplitude:analytics-android 1.37.1) and its
# runtime dependencies into android/.deps/, pinned by SHA-256. Nothing is unpacked unless its
# hash matches. The list is the SDK's resolved runtime closure (its POMs), using the -jvm /
# -android variants of Kotlin Multiplatform artifacts. Left out on purpose: annotation-only jars,
# kotlin-stdlib-jdk7/jdk8/common (kotlin-stdlib 1.9.25 already holds them) and profileinstaller
# (it only runs from a manifest entry this app does not have).
set -euo pipefail
cd "$(dirname "$0")/.."

C=https://repo1.maven.org/maven2
G=https://dl.google.com/dl/android/maven2
# sha256  repo  path
DEPS="
6479c5f75f48a6ea2818c9877e823b0246f819ebbdb0ec6e4ef5a32a3f0afc1c $C com/amplitude/analytics-android/1.37.1/analytics-android-1.37.1.aar
d6fe5ac484be00f1ef48e01a536ff4c946711a736a8112e559e6d8ce0380c529 $C com/amplitude/analytics-core/1.37.1/analytics-core-1.37.1.jar
1c7debd45524344399b6339f5139edca61bef5df5e74357fc66bc1abdd1caab8 $C com/amplitude/analytics-connector/1.0.0/analytics-connector-1.0.0.aar
f9cdcdbff1f5de85380ae526977e683726c2aa42db1ed6e6e50ae89e496e95fd $C org/jetbrains/kotlin/kotlin-stdlib/1.9.25/kotlin-stdlib-1.9.25.jar
f3d4f5de1c391bbcc20f3b3435ccbac013521e76b6902d7d59635ec15c1f797e $C org/jetbrains/kotlinx/kotlinx-coroutines-core-jvm/1.8.1/kotlinx-coroutines-core-jvm-1.8.1.jar
a134dacf4e6578b29b32e97aa50548d09cb45e3cb3551ce77ac27e55e265d8f5 $C org/jetbrains/kotlinx/kotlinx-coroutines-android/1.8.1/kotlinx-coroutines-android-1.8.1.jar
adb64a642b142157227b5f5cdb6d1e004d73216df32acba1c6836134835a4b1f $C org/jetbrains/kotlinx/atomicfu-jvm/0.17.0/atomicfu-jvm-0.17.0.jar
1afd155dc4c7997b8fcf9c96be0bd4358eace2b54897c1c9036ffdb7b0663d27 $C com/squareup/curtains/curtains/1.2.5/curtains-1.2.5.aar
e4ad7607e5c0477c6f890ef26a49cb8d1bb4dffb650bab4502afee64644e3069 $C com/google/guava/listenablefuture/1.0/listenablefuture-1.0.jar
6bf03d39dbe3744acce227d3b697374c3625aae1025fbec8ad9fd7bd58bce431 $G androidx/core/core/1.16.0/core-1.16.0.aar
1766dbd82f64a12dcd359ecb6f15f3cf35db4d66d22961a7c51b2ffc6468314c $G androidx/core/core-ktx/1.16.0/core-ktx-1.16.0.aar
dc1b678d58ebcf2bfa1587be68ff826694ce3d221251b9ef30d4d4b36297e6de $G androidx/core/core-viewtree/1.0.0/core-viewtree-1.0.0.aar
62e076a2de2d650a23bf79495419f8a4357ad8e9b28d801318d0fcdd6e35fa87 $G androidx/lifecycle/lifecycle-process/2.8.7/lifecycle-process-2.8.7.aar
b8eb997dd434d70eb97cbd6d1395b6337c6771717c7acd59f11c0853f3860284 $G androidx/lifecycle/lifecycle-runtime-android/2.8.7/lifecycle-runtime-android-2.8.7.aar
61c873a7327c946ec033c310bb98f3f92eeabcede0e1a5200ab8a1896483c7bf $G androidx/lifecycle/lifecycle-common-jvm/2.8.7/lifecycle-common-jvm-2.8.7.jar
e0a6329a371262fe4c450372b70fdaf33b769ef6917094723787cfce896b1dd3 $G androidx/startup/startup-runtime/1.1.1/startup-runtime-1.1.1.aar
65308a06b1c00ee186cb9e19321383f043b993813f1522c47f4a3e3303bdba41 $G androidx/arch/core/core-common/2.2.0/core-common-2.2.0.jar
a1be5e0caa2b07623862af6ae21b3ab0718123245184d0e30dea81b53f990a47 $G androidx/arch/core/core-runtime/2.2.0/core-runtime-2.2.0.aar
984ce9bd780055eafb8a105aca3f514686bf7b1b6272ec7c645a98ce40fc7db4 $G androidx/collection/collection-jvm/1.4.2/collection-jvm-1.4.2.jar
0ce067c514a0d1049d1bebdf709e344ed3266fe9744275682937cdcb13334e9e $G androidx/concurrent/concurrent-futures/1.1.0/concurrent-futures-1.1.0.jar
33193135a64fe21fa2c35eec6688f1a76e512606c0fc83dc1b689e37add7732a $G androidx/interpolator/interpolator/1.0.0/interpolator-1.0.0.aar
6faa90390d1fdbf0adb9a99bf99de67b94c6c6f35aea9510593a9d17973736a2 $G androidx/tracing/tracing/1.2.0/tracing-1.2.0.aar
57e8d93260d18d5b9007c9eed3c64ad159de90c8609ebfc74a347cbd514535a4 $G androidx/versionedparcelable/versionedparcelable/1.1.1/versionedparcelable-1.1.1.aar
"

D=.deps
STAMP="$D/stamp-1-amplitude-1.37.1"
[ -f "$STAMP" ] && exit 0
# Keep verified downloads in .deps/dl (each is re-checked); rebuild everything else.
mkdir -p "$D/dl" && find "$D" -mindepth 1 -maxdepth 1 ! -name dl -exec rm -rf {} +

fetch() { # url file sha256
  if [ -f "$2" ] && [ "$(sha256sum "$2" | cut -d' ' -f1)" = "$3" ]; then return 0; fi
  curl -sSfL --retry 3 -o "$2" "$1"
  local got; got="$(sha256sum "$2" | cut -d' ' -f1)"
  if [ "$got" != "$3" ]; then echo "SHA-256 mismatch for $1: got $got" >&2; rm -f "$2"; exit 1; fi
}
echo "$DEPS" | while read -r sha repo path; do
  [ -z "$sha" ] && continue
  fetch "$repo/$path" "$D/dl/$(basename "$path")" "$sha"
done
PY=python; command -v python >/dev/null 2>&1 || PY=python3
"$PY" scripts/extract-deps.py "$D"
touch "$STAMP"
echo "Fetched the Amplitude Android SDK 1.37.1 and its runtime dependencies into $D/"
