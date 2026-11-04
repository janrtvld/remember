# Always-on microphone interruption investigation

17 September 2026. Investigated installed Remember 0.2.263 against checkout `7a7d70bf`.

## Confirmed failure

A microphone interruption could leave both audio sources stopped indefinitely while always-on remained enabled. The recovery callback stopped the system-audio helper and scheduled one microphone retry after one second. If that helper was still closing, `nextAudioEngineToStart` returned `null` because a system-audio process still existed. When it eventually closed, nothing scheduled another microphone attempt.

The isolated native reproduction delays only its own system-helper shutdown by 2.5 seconds, then crashes its microphone renderer. Before the fix, the resulting snapshot had no microphone, no system helper, and no pending retry. See `.qa/runs/2026-09-17T12-09-36.754Z/microphone-recovery.json` and its failed `report.json`.

## Relationship to the recent upgrade

The startup-policy race dates to `84f421fd` on 1 September. `a4942551` on 16 September replaced the separate conversation microphone helper with the Chromium stream shared by conversations and Voice notes. Its AudioWorklet buffer pool and transport watchdog fail capture after roughly two seconds without consumption. A three-second main-process stall reproduces such an interruption in real Electron.

The upgrade therefore added a reproducible way to reach the existing recovery flaw. It also discarded the unfinished microphone chunk on transport failure. This establishes a concrete regression mechanism, but does not prove which event triggered the user's original interruption.

The installed profile's last retained microphone audio ended at 13:32:35 local time and system audio at 13:32:51, despite enabled, unpaused always-on settings. Production stdout/stderr went to `/dev/null`; the old recovery path did not report capture interruptions to Sentry. The latest renderer-crash issue was on an older release and does not explain this incident.

## Changes

- Restart the microphone directly, allowing the shared service to wait for its old transport to release input.
- Leave a working system-audio helper running through microphone recovery.
- Permit microphone startup even when system audio already exists.
- Flush the valid conversation prefix before invalidating a failed transport. Incomplete Voice notes still fail, and corrupt PCM remains rejected.
- Report bounded capture-interruption diagnostics through the existing opt-in error reporter, without audio, transcripts, device names, or raw error text.

## Verification

The policy regression fails before the fix and passes after it. Focused tests cover delayed transport retirement, prefix retention, Voice-note cancellation, routing, and device selection. `pnpm validate` passed, including 819 passing desktop tests and one existing skip.

Native QA now verifies fresh microphone PCM after a recorder crash and a three-second main-process stall, preservation of the same system-helper PID, valid interrupted chunks, repeated Voice notes, and restart persistence. It explicitly selects the built-in shared input when the system default differs; it does not change the machine's default input.

The complete native run passed: `.qa/runs/2026-09-17T12-16-16.939Z/report.json`. It retained 88,394 ms of system audio across two chunks with nonzero signal and no failed chunks. Six shared Voice-note starts had a median first-buffer latency of 42.1 ms. Audio rows and exact WAV hashes survived a full Electron restart, and the assembled recording played successfully.

The earlier Voice-note exclusion assertion mixed sample timestamps with stop-command wall time. The saved note's last sample exactly matched the following conversation's first sample. QA now checks actual AudioWorklet routing boundaries with a one-millisecond storage-rounding allowance, tightened from twenty milliseconds.

These checks use an isolated app and profile. They do not establish physical headphone switching, actual OS sleep, or uninterrupted capture during a real hardware failure. They did not replace or restart the installed production app; release publication is verified separately.
