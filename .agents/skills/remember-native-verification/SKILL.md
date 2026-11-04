---
name: remember-native-verification
description: Verify Remember Timeline evidence and system audio in real Electron when browser checks cannot establish persistence or native capture.
---

# Remember native verification

- For Timeline evidence, IPC edits, and restart persistence, run `pnpm qa:electron`.
- For system audio, run `pnpm qa:audio`. It plays a quiet tone for a bounded native recording and verifies actual samples and persistence. A ready flag alone is not a pass.

Read the printed report and the failed run's logs before changing code or weakening an assertion. The runner owns an isolated app, profile, and source copies; do not attach to production or reset macOS permissions to repair it. Model assets are cloned locally, or selected with `--models /absolute/path/to/models`.

Keep ordinary UI iteration in the browser. Prefer deleting unnecessary tooling, then simplifying the remaining workflow. Use a direct reproduction before adding another automated command.

Read [native verification](../../../docs/native-verification.md) for evidence locations, prerequisite failures, and local Space testing. Fixture evidence does not establish native context capture or AI summary quality. Report only the boundaries exercised.
