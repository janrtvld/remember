#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v xcrun >/dev/null 2>&1; then
  echo "xcrun not found — native helpers require macOS with Xcode command-line tools." >&2
  exit 1
fi

build_and_sign() {
  local output="$1"
  local identifier="$2"
  shift
  shift
  xcrun swiftc -O -target arm64-apple-macos14.4 "$@" -o "$output"
  codesign --force --identifier "$identifier" --sign - "$output"
  chmod +x "$output"
  echo "built $output"
}

build_and_sign "$DIR/music-classifier" "computer.remember.app.music-classifier" \
  -framework AVFoundation -framework SoundAnalysis -framework Foundation \
  "$DIR/music-classifier.swift"

build_and_sign "$DIR/media-playback" "computer.remember.app.media-playback" \
  -framework AppKit -framework Foundation \
  "$DIR/media-playback.swift"

build_and_sign "$DIR/app-icon" "computer.remember.app.app-icon" \
  -framework AppKit -framework Foundation \
  "$DIR/app-icon.swift"

build_and_sign "$DIR/app-list" "computer.remember.app.app-list" \
  -framework AppKit -framework Foundation \
  "$DIR/app-list.swift"

build_and_sign "$DIR/system-settings-window" "computer.remember.app.system-settings-window" \
  -framework AppKit -framework CoreGraphics -framework Foundation \
  "$DIR/system-settings-window.swift"

mkdir -p "$DIR/context-capture/target/release"
build_and_sign "$DIR/context-capture/target/release/remember-context-capture" "computer.remember.app.context-capture" \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics -framework Foundation \
  -Xlinker -sectcreate \
  -Xlinker __TEXT \
  -Xlinker __info_plist \
  -Xlinker "$DIR/context-capture-Info.plist" \
  "$DIR/context-capture.swift"

xcrun swiftc -O \
  -target arm64-apple-macos14.4 \
  -framework CoreAudio -framework Foundation \
  -Xlinker -sectcreate \
  -Xlinker __TEXT \
  -Xlinker __info_plist \
  -Xlinker "$DIR/system-audio-capture-Info.plist" \
  "$DIR/system-audio-capture.swift" \
  -o "$DIR/system-audio-capture"
codesign --force --identifier "computer.remember.app.system-audio-capture" --sign - "$DIR/system-audio-capture"
chmod +x "$DIR/system-audio-capture"
echo "built $DIR/system-audio-capture"

build_and_sign "$DIR/microphone-audio-capture" "computer.remember.app.microphone-audio-capture" \
  -framework AudioToolbox -framework AVFAudio -framework CoreAudio -framework Foundation \
  "$DIR/microphone-audio-capture.swift"

build_and_sign "$DIR/remember" "computer.remember.app.cli" \
  -framework Foundation -lsqlite3 \
  "$DIR/remember-cli.swift"
build_and_sign "$DIR/key-paste" "computer.remember.app.key-paste" \
  -framework CoreGraphics -framework ApplicationServices -framework Foundation \
  "$DIR/key-paste.swift"

xcrun clang -O2 -fobjc-arc -target arm64-apple-macos14.4 \
  -framework CoreAudio -framework Foundation \
  "$DIR/output-volume-control.m" -o "$DIR/output-volume-control"
codesign --force --identifier "computer.remember.app.output-volume-control" --sign - "$DIR/output-volume-control"
chmod +x "$DIR/output-volume-control"
