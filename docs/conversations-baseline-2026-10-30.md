# Conversation recording: implementation and validation findings

This records the recording-flow investigation from 30 October–1 November 2026. The detailed local research journal and production identifiers are retained privately. These are historical scenario results, not certification of a later release candidate.

## User flow

One start action opens the conversation workspace immediately, with an honest starting state. The page provides a title, notes and compact recording controls. Processing is separate from capture. Stop opens the saved conversation after the audio capture process closes and final details are durable. The user can navigate while transcription and cloud processing continue. Discard uses a confirmation dialog; cancelling it preserves the recording. Notes remain available after processing failures.

The interface reuses the existing detail header, controls, colours and scrolling behavior. The reference study favored continuity of the document and optional transcript/assistance disclosures. It did not justify copying a separate app-wide chat or adding a second recording mode.

## Correctness boundaries

- Final title and notes travel in the same native operation as Stop. The renderer cancels stale debounced writes; an old autosave failure cannot overwrite a newer draft. Details updates are accepted only for the active recording.
- Stop records the exact end time, closes capture and preserves raw PCM before acknowledging. Transcription, audio assembly and analysis run afterward. A serial transcription barrier prevents a previous recording's flush from consuming the next recording.
- Manual audio assembly uses exact recording boundaries with no surrounding padding. Automatic recognized episodes retain their existing margin. Tests compare every manifest source interval, sample count and WAV hash, including back-to-back recordings and pause/resume.
- The persisted manual episode owns the recording identity before analysis. Delayed transcription adds source links without replacing a later recording or changing a cloud result's identity.
- Audio can be played before local transcription finishes. Playback waits only for its own audio preparation. Assembly yields between bounded blocks, pins source chunks while active and is cancelled by deletion.
- Cloud replacement preserves notes, manual recording links and source windows. Repeated sync and restart must not recreate a deleted local recording or submit the same upload twice.
- Discard waits for physical capture closure, removes only the recording's evidence and writes the affected day. Queued decodes and late transcription results are fenced by the surviving chunk identities. It does not wait for the entire transcription queue.
- Automatic startup cannot replace an explicitly starting, recording or processing manual meeting. The background engine returns to its ordinary cadence after the manual recording ends.

## Main-thread and startup findings

Synchronous mixing of a two-channel, one-hour synthetic recording delayed the event loop by roughly one second. Cooperative assembly reduced the measured maximum heartbeat gap to approximately 14 ms in that controlled benchmark. This is not a promise about installed-device latency.

Production-size archives exposed work absent from small fixtures: repeated serialization of analysis provenance, unindexed semantic snapshot lookups and synchronous evidence reads. Schema 17 moved large provenance out of frequently written day summaries; targeted indexes reduced one copied-database lookup from roughly 510 ms to 6 ms. Further storage changes are documented in `knowledge-data-architecture.md`.

The packaged webserver must serve Next.js Flight payloads with the correct MIME type to preserve document identity during navigation. Opening the explicit `/day/` document avoids an unnecessary empty root-document transition. Status reads must not start or await capture; agent availability checks can continue independently.

## Verified historical scenarios

Isolated native Electron runs exercised actual system audio, input recovery, shared dictation exclusion, final notes, playback and full restart. Back-to-back recordings were tested with transcription deliberately held: both stopped, published their own audio and retained exact source windows after restart. A local cloud-processing fixture covered failed upload, retry, restart, uncertain acknowledgement, repeated sync and notes/source preservation.

Separate checks against an existing installed profile followed a known test recording through actual cloud processing, verified final notes and playback, then quit and reopened the app. The resulting audio identity and source window were unchanged. These checks establish the selected flow on those historical builds; they do not establish every current provider, permission or error state.

Measured native Stop work in the final historical short-recording checks was roughly 0.1–0.3 seconds. UI observation times include automation overhead and must not be presented as precise latency percentiles. Earlier longer stalls and startup failures were reproduced; only causes directly identified by tracing were treated as fixed.

## Verification and rollback requirements

Use the native QA reports, including actual audio samples and post-restart hashes, before claiming native capture or persistence. Browser fixtures establish renderer behavior only. A readiness flag alone does not establish audio. Test the existing populated profile as well as isolated fixtures when assessing performance.

Keep a closed-profile backup and a verified previous application. Downgrading schema 17/18 requires the offline rollback helper to expand provenance into the earlier representation; lowering the schema number or replacing current recordings with an old database is unsafe. The latest schema and rollback details are owned by the storage implementation and its tests.
