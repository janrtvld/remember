# Native verification

Use `pnpm dev` for renderer development. Use the native QA runner when a change depends on Electron IPC, local persistence, agent access, capture, permissions, or packaged integration.

## Prerequisites

- An Apple Silicon Mac with Xcode 26 or newer and the macOS 26 SDK selected.
- The pinned Node.js and pnpm versions, with workspace dependencies installed.
- Local Parakeet model assets. By default the runner clones the installed Remember model directory into its isolated profile. Supply `--models /absolute/path/to/models` to use a different existing model directory.

The runner does not download models or change macOS permissions automatically. It owns a separate app copy, source snapshot, profile, and processes. Do not point it at an installed user's profile or reset system permissions to make a check pass.

## Choose the relevant scenario

Run from the repository root:

| Command | What it checks |
| --- | --- |
| `pnpm qa:electron smoke` | Seeded evidence through native IPC, renderer behavior, source references, and persistence across restart |
| `pnpm qa:electron smoke --living-spaces` | Local Space creation, native CLI/MCP reads and writes, document editing, revision protection, source links, and restart persistence |
| `pnpm qa:electron learning` | Learning from isolated synthetic agent records, source attribution, local knowledge proposals, and durable history using deterministic inference |
| `pnpm qa:audio` | Actual native audio inputs with a bounded playback stimulus, recorded samples, and persistence |

The default `pnpm qa:electron` command selects `smoke`. For CLI archive and task continuity changes, use `pnpm qa:electron smoke --continuity`. For a packaged-renderer boundary, add `--packaged-renderer` to a supported scenario; this builds the static renderer in the isolated source snapshot.

Audio QA activates real capture and plays a quiet test tone. Use it when that physical input/output check is intended. Fixture-only checks do not prove microphone or system-audio capture, speaker behavior, or real transcription quality.

## Keep runtime paths short

macOS Unix sockets have a 104-byte path limit. Long worktree paths can exceed it. Use an absolute, dedicated QA directory with a short path:

```sh
REMEMBER_QA_RUNTIME_DIR=/private/tmp/remember-qa \
pnpm qa:electron smoke --living-spaces
```

The override moves the owned source snapshots, app copies, profiles, and reports into that directory. It does not change the installed app's data directory. The runner locks the checkout and selected runtime to prevent concurrent runs from reusing them. An external runtime uses the Webpack development bundler so dependency symlinks resolve correctly.

## Read the evidence

Each run prints the path to its final `report.json`. By default, evidence lives under `.qa/runs/<run-id>/`; with an override it lives under `$REMEMBER_QA_RUNTIME_DIR/runs/<run-id>/`. The directory contains the report, process logs, screenshots, and scenario-specific proof files.

Read the final report and relevant logs before claiming success. A process launch, a ready flag, or a screenshot alone is not a passing scenario. A failed cleanup is a failed run. Preserve the original failure evidence while investigating; do not weaken assertions to obtain a green result.

Keep evidence boundaries explicit:

- Browser checks establish renderer behavior, not Electron or native capture.
- Seeded native fixtures establish the exercised IPC and persistence paths, not model quality on real work.
- Deterministic learning checks establish source and storage behavior, not the usefulness of a live model's output.
- An isolated source build does not prove a signed installer, notarization, or the real updater's download/install/relaunch path.

For release preparation and publication, see [CI and releases](ci-and-releases.md). Keep generated profiles, recordings, screenshots containing private data, and model output out of Git.
