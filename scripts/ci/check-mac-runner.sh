#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo '::error::Remember builds require an Apple Silicon Mac.'
  exit 1
fi
xcodebuild -version
sdk_version="$(xcrun --sdk macosx --show-sdk-version)"
if (( ${sdk_version%%.*} < 26 )); then
  echo '::error::Remember requires the macOS 26 SDK. Check xcode-select.'
  exit 1
fi
command -v gh >/dev/null

# Fail before installing dependencies or starting a signed release.
available_kb="$(df -Pk . | awk 'NR == 2 {print $4}')"
minimum_gb="${1:-15}"
if (( available_kb < minimum_gb * 1024 * 1024 )); then
  echo "::error::At least ${minimum_gb} GiB free is required; currently $((available_kb / 1024 / 1024)) GiB. Free build-cache space on the runner."
  exit 1
fi
echo "macOS SDK $sdk_version; $((available_kb / 1024 / 1024)) GiB available."
