# macOS microphone mode

Remember keeps the orange microphone privacy dot. The larger orange menu-bar
button is macOS's Mic Mode control (Standard / Voice Isolation), a separate
control from the privacy indicator.

On macOS 27.0.1 (26A434), Control Center reported these states during recording:

| App/configuration | Voice processing bypassed | Mic Mode enabled |
| --- | --- | --- |
| Codex dictation | true | false |
| Remember, original settings | false | true |
| Remember, native bypass configured | true | false |

The user confirmed the large button disappeared with bypass, returned when
bypass was disabled, and disappeared again when it was enabled. The same
Chromium microphone stream stayed active through the latter two transitions,
with echo cancellation, noise suppression, and automatic gain control enabled.
The bypass also survived a full restart of the signed Remember test copy.
The user subsequently confirmed that both manual recording and always-on in
the installed production Remember showed only the dot, with screen sharing off.
The installed bundle was not replaced: the configuration applied under the
same application identity already affects it. The source change reapplies the
configuration on future launches once included in a build.

## Implementation

Before preparing the shared recorder, `prepareMicrophoneMode` invokes the
existing native microphone helper with `--configure-microphone-mode`. The helper
configures an `AVAudioEngine` input node for voice processing and sets its public
`isVoiceProcessingBypassed` property. It never starts the engine or installs a
capture tap. macOS retains this state for the responsible application, including
its existing Chromium input. The helper exits immediately after configuration.

Preparation is shared once per app process and only runs after microphone
permission has been granted. There is no permission reset, private macOS API,
screen-sharing workaround, or privacy-indicator suppression. A failed or timed
out configuration logs a warning and allows recording to continue. Shared
conversation/Voice-note ownership, Chromium audio processing, sample boundaries,
and idle teardown remain unchanged. The normal native-helper recording command
also remains unchanged.

This app-wide persistence is observed platform behavior, not an Apple guarantee
about future menu-bar presentation. Recheck the controlled experiment after
major macOS changes. The native property describes system voice-processing
bypass; it is not a general API for hiding microphone indicators.

## Verification constraints

Do not use computer-use screen tools while judging the menu-bar icon. An active
ScreenCaptureKit sharing session can replace the large orange Mic Mode button
with the purple sharing control. Early experiments were invalid for this reason.
Use Control Center logs and a human observation with screen sharing stopped.

Changing getUserMedia's three processing booleans, choosing AirPods instead of
the built-in microphone, stopping system-audio capture, or switching to the
existing native HAL recorder did not disable Mic Mode in controlled tests.

For live regression checks use `pnpm qa:electron audio --cold-starts` with the
built-in microphone as the system default. The scenario requires the shared
microphone path and a nonzero acoustic signal. An AirPods default selects the
separate fallback recorder and does not exercise that scenario. Restore the
user's device selections after testing. A temporary `REMEMBER_QA_RUNTIME_DIR`
selects the runner's webpack mode if the isolated Turbopack renderer cannot
resolve Next.js.

On 2026-10-29, lint, desktop type checking, native helper compilation and all
28 focused service/writer/transport tests passed, including disposal while mode
configuration is pending. The live cold-start scenario did not pass: its
`command && started && signal` assertion failed both with AirPods and with
built-in defaults. That assertion runs 200 ms after recording starts; the
failure report does not identify which event was missing. Do not count this as
a passing full audio regression run or assume the device selection explains it.
Reports are under `/private/tmp/remember-mic-mode-qa/runs/`, with the last attempt
`2026-10-29T10-11-57.123Z`. Original input and output selections were restored.
The separate signed-app experiments established real nonzero audio, native
mode transitions, restart persistence and the production menu-bar result.
