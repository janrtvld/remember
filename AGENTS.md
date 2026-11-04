# Workspace instructions

## Local-first product

- Remember is a standalone macOS app. Recordings, transcripts, activity, and Spaces live on the user's Mac. Spaces are long-term memory for the user and their agents; they have no accounts, invitations, or hosted sharing.
- Personal is the default Space. Additional local Spaces are optional. Preserve human edits, source references, revision checks, and data integrity when changing knowledge workflows.
- AI providers and optional integrations can make external requests. Describe those boundaries accurately; local storage does not imply fully offline AI.

## Data and authorization

- Use synthetic fixtures and isolated app profiles for development and public examples. Use a person's existing Remember data only within their explicit authorization.
- Keep recordings, transcripts, captures, credentials, private evaluation outputs, and personal machine paths out of commits, screenshots, logs, and issue reports.
- Inspect the working tree before editing and preserve unrelated changes. Publishing, deployment, and external messages require authorization for the actual action.

## Validate the user experience

- Make the experience simpler and consistent with what exists. Reuse established headers, controls, and flows. Keep one coherent recording flow and use ordinary chat messages when sufficient.
- Judge progress by exercising the app as a user. Passing tests support that judgment; they do not establish that the experience has improved.
- Observe the relevant flow before changing it, then exercise the complete flow with realistic sample data. Inspect the actual output and interactions. Use the browser for renderer behavior and native Remember for native integration.
- Return to that flow after meaningful implementation milestones. Address confusing, slow, or broken behavior before expanding coverage. Keep necessary safety, data-integrity, and regression checks; avoid tests that merely restate implementation.
- When a reference product informs an interaction, inspect it where access is authorized. Distinguish observations from assumptions and report access limitations accurately.

## Project skills

- Use `.agents/skills/remember-ui-intent/SKILL.md` for open-ended interface requests when the desired experience needs interpretation, alongside `remember-ui-decisions`. Narrow, specified edits do not need the extra workflow.
- Use `.agents/skills/remember-ui-decisions/SKILL.md` for Remember interface, navigation, state, and landing-preview changes.
- Use `.agents/skills/remember-native-verification/SKILL.md` when verification depends on native Remember.
- Use `.agents/skills/git-direct-publish/SKILL.md` for authorized commits, pushes, and Git publication. Use Git directly; GitHub API authentication is unnecessary for ordinary Git operations.
- Use `.agents/skills/consult-claude/SKILL.md` when Claude is explicitly requested as a second opinion or research collaborator.
- Use `.agents/skills/sentry-triage/SKILL.md` for authorized Sentry investigations. Keep investigation read-only unless a mutation or code change is separately requested.

## Checks and UI verification

- Run `pnpm lint` after changes and fix errors. It runs Oxlint with `@shadcn/lint` for web and site. Biome provides the general formatting check. Run `pnpm validate` before submitting a complete change.
- Configure shared lint rules in `.oxlintrc.json`, or app-specific rules in `apps/web/.oxlintrc.json` and `apps/site/.oxlintrc.json`. Keep discovery scoped to the app; themes come from its Tailwind CSS entry.
- Start `pnpm dev` and use `http://localhost:3000` for routine UI development. It runs the real Next.js renderer with a development-only local bridge and mutable sample data.
- Prefer browser tools for interaction and screenshots. Check affected default, hover, active, loading, empty, error, and narrow-window states.
- Browser verification does not prove Electron IPC, native capture, permissions, notifications, tray behavior, updater behavior, or packaged-app integration. State remaining verification boundaries.
- Use `pnpm dev:desktop` for manual native development. Use `pnpm qa:electron` for agent-driven native checks and read its report before claiming success. Routine interface work should not depend on a native window.
- See [CI and releases](docs/ci-and-releases.md) for hosted validation and signed release workflows.
