#!/usr/bin/env bash
# Prepare one signed public artifact, then explicitly publish those verified bytes.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="janrtvld/remember"
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
APP_PATH="release/mac-arm64/Remember.app"
SENTRY_RELEASE="remember-desktop-$VERSION"
BUILD_SOURCE_MAP_PATHS=(out/main out/preload ../web/out)
SENTRY_SOURCE_MAP_PATHS=(".release-source-maps/$VERSION/out/main" ".release-source-maps/$VERSION/out/preload" ".release-source-maps/$VERSION/web")
SENTRY_UPLOAD_TIMEOUT_SECONDS=600
RELEASE_STARTED_AT=$SECONDS

run_phase() {
  local name="$1"
  shift
  local started_at=$SECONDS

  echo "::group::[release] $name"
  if "$@"; then
    echo "::endgroup::"
    echo "[release] $name completed in $((SECONDS - started_at))s"
    return 0
  else
    local status=$?
    echo "::endgroup::"
    echo "[release] $name failed after $((SECONDS - started_at))s" >&2
    return "$status"
  fi
}

retry() {
  local attempt=1
  local max_attempts=5
  local delay=3

  until "$@"; do
    if ((attempt >= max_attempts)); then
      return 1
    fi
    echo "[release] command failed; retrying in ${delay}s (attempt $((attempt + 1))/$max_attempts)" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

ensure_draft_release() {
  local attempt=1
  local max_attempts=5
  local delay=3
  local release_state

  while ((attempt <= max_attempts)); do
    if release_state="$(gh release view "$TAG" --repo "$REPO" --json isDraft --jq .isDraft 2>&1)"; then
      if [[ "$release_state" != "true" ]]; then
        echo "Refusing to replace published release $TAG." >&2
        return 1
      fi
      echo "[release] resuming draft release $TAG"
      return 0
    fi

    if [[ "$release_state" == "release not found" ]]; then
      echo "[release] creating draft release $TAG"
      if gh release create "$TAG" \
        --repo "$REPO" \
        --target "$SOURCE_COMMIT" \
        --title "Remember $VERSION" \
        --notes "$RELEASE_NOTES" \
        --draft; then
        return 0
      fi
    else
      echo "$release_state" >&2
    fi

    if ((attempt >= max_attempts)); then
      return 1
    fi
    echo "[release] release lookup/create failed; retrying in ${delay}s (attempt $((attempt + 1))/$max_attempts)" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

upload_sentry_source_maps() {
  local map_count
  map_count="$(find "${SENTRY_SOURCE_MAP_PATHS[@]}" -type f -name '*.map' | wc -l | tr -d ' ')"
  if [[ "$map_count" == "0" ]]; then
    echo "Sentry source-map upload expected generated maps, but none were found." >&2
    return 1
  fi

  if ! pnpm exec sentry-cli releases info \
    --org "$SENTRY_ORG" \
    --project "$SENTRY_PROJECT" \
    "$SENTRY_RELEASE" >/dev/null 2>&1; then
    pnpm exec sentry-cli releases new \
      --org "$SENTRY_ORG" \
      --project "$SENTRY_PROJECT" \
      "$SENTRY_RELEASE"
  fi

  node scripts/run-with-timeout.mjs "$SENTRY_UPLOAD_TIMEOUT_SECONDS" \
    pnpm exec sentry-cli sourcemaps upload \
    --org "$SENTRY_ORG" \
    --project "$SENTRY_PROJECT" \
    --release "$SENTRY_RELEASE" \
    --strict \
    --validate \
    --wait \
    "${SENTRY_SOURCE_MAP_PATHS[@]}"

}

verify_uploaded_assets() {
  local assets
  assets="$(retry gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name')"
  for required_asset in \
    Remember-arm64.dmg \
    Remember-arm64.dmg.blockmap \
    Remember-arm64.zip \
    Remember-arm64.zip.blockmap \
    latest-mac.yml \
    prepared-release.json; do
    if ! grep -Fxq "$required_asset" <<<"$assets"; then
      echo "Release is missing required asset $required_asset." >&2
      return 1
    fi
  done
}

publish_release() {
  retry gh release edit "$TAG" --repo "$REPO" --notes "$RELEASE_NOTES" --draft=false --prerelease=false --latest >/dev/null
}

verify_notarization_inputs() {
  # Match electron-builder's precedence; partial credentials must not fall through.
  if [[ -n "${APPLE_ID:-}" || -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
    : "${APPLE_ID:?APPLE_ID is required when using Apple ID notarization}"
    : "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD is required when using Apple ID notarization}"
  elif [[ -n "${APPLE_API_KEY:-}" || -n "${APPLE_API_KEY_ID:-}" || -n "${APPLE_API_ISSUER:-}" ]]; then
    : "${APPLE_API_KEY:?APPLE_API_KEY is required when using API-key notarization}"
    : "${APPLE_API_KEY_ID:?APPLE_API_KEY_ID is required when using API-key notarization}"
    : "${APPLE_API_ISSUER:?APPLE_API_ISSUER is required when using API-key notarization}"
    if [[ ! -f "$APPLE_API_KEY" || ! -r "$APPLE_API_KEY" ]]; then
      echo "APPLE_API_KEY must name a readable key file." >&2
      return 1
    fi
  elif [[ -z "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
    echo "Notarization requires Apple ID credentials, an App Store Connect API key, or APPLE_KEYCHAIN_PROFILE." >&2
    return 1
  fi
}

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Refusing to publish non-stable version $VERSION." >&2
  exit 1
fi

MODE="${1:---prepare}"
if [[ "$#" -gt 1 || ( "$MODE" != "--prepare" && "$MODE" != "--publish" ) ]]; then
  echo "Usage: release.sh [--prepare|--publish]" >&2
  exit 1
fi

: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required to verify the public signing identity}"
run_phase "Verify unified release version" node scripts/verify-release-version.cjs

if [[ "$MODE" == "--prepare" ]]; then
  run_phase "Verify notarization inputs" verify_notarization_inputs
  SOURCE_COMMIT="$(node scripts/prepare-release.cjs --source)"
  # Generated artifacts only; user profiles and rollback installations are outside this directory.
  rm -rf release
  run_phase "Generate third-party notices" node scripts/generate-third-party-notices.cjs
  run_phase "Build web" pnpm --filter @remember/web build
  run_phase "Build desktop" pnpm run build
  run_phase "Inject source-map debug IDs locally" pnpm exec sentry-cli sourcemaps inject "${BUILD_SOURCE_MAP_PATHS[@]}"
  run_phase "Keep source maps outside public artifacts" node scripts/release-source-maps.cjs
  run_phase "Package, sign, and notarize app" pnpm exec electron-builder --mac --arm64 --publish never --config electron-builder.yml
  run_phase "Verify public package and updater artifacts" node scripts/prepare-release.cjs --prepare "$SOURCE_COMMIT"
  echo "[release] prepared $TAG locally; no GitHub release was created or published"
  exit 0
fi

: "${SENTRY_AUTH_TOKEN:?SENTRY_AUTH_TOKEN is required to publish the prepared source maps}"
: "${SENTRY_ORG:?SENTRY_ORG is required to publish the prepared source maps}"
: "${SENTRY_PROJECT:?SENTRY_PROJECT is required to publish the prepared source maps}"
run_phase "Verify exact prepared release" node scripts/prepare-release.cjs --verify
SOURCE_COMMIT="$(node -p "require('./release/prepared-release.json').source.commit")"
RELEASE_NOTES="$(printf 'Remember %s\n\nSource commit: %s\n\nSee prepared-release.json for verified artifact hashes and signing provenance.' "$VERSION" "$SOURCE_COMMIT")"
run_phase "Create draft release" ensure_draft_release
run_phase "Upload prepared Sentry source maps" upload_sentry_source_maps
run_phase "Upload release assets" retry gh release upload "$TAG" \
  --repo "$REPO" \
  --clobber \
  release/Remember-arm64.dmg \
  release/Remember-arm64.dmg.blockmap \
  release/Remember-arm64.zip \
  release/Remember-arm64.zip.blockmap \
  release/latest-mac.yml \
  release/prepared-release.json
run_phase "Verify uploaded release assets" verify_uploaded_assets
run_phase "Publish release" publish_release
echo "[release] published $TAG as Latest in $((SECONDS - RELEASE_STARTED_AT))s"
