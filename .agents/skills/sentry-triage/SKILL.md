---
name: sentry-triage
description: Locate, inspect, and explain Remember production errors through the project-scoped Sentry MCP. Use for Sentry issue links or IDs, production crash reports, error-code investigations, release regressions, and requests to review unresolved Remember errors.
---

# Remember Sentry triage

Use the project-scoped `sentry` MCP connection. It is constrained to organization `jr-development-0f` and project `remember-desktop`; do not discover or query unrelated Sentry projects.

## Keep triage read-only

Treat finding, filtering, reading, and analyzing Sentry data as authorized by a triage request. Do not resolve, archive, ignore, assign, comment on, merge, or otherwise mutate a Sentry issue unless the user explicitly asks for that separate action. Do not implement a code fix unless the request includes remediation.

If the Sentry MCP is unavailable, inspect `codex mcp get sentry` and report the precise connection or OAuth blocker. Do not substitute public web search or infer live Sentry state from repository code. A signed-in browser is only a fallback when the user explicitly authorizes browser-based investigation.

## Find the evidence

- When given an issue URL, short ID, numeric issue ID, or event ID, fetch it directly before running a broad search.
- Otherwise start with unresolved production errors from the last 14 days, ordered by most recently seen. Narrow with the user's terms, `error_code`, `app_area`, release, provider, reason, or phase. Expand to 90 days only when the initial window is empty or the request is historical.
- Read the issue aggregate and at least one representative event. For active or changing issues, compare the latest event with an earlier representative event.
- Correlate `release` values shaped like `remember-desktop-<version>` with the repository and released versions. Older releases used an email-shaped `remember-desktop@<version>` value that Sentry could scrub to `[email]`. Treat tags and counts as evidence, not as proof of causality.
- Prefer raw issue and event data when an aggregate, Seer, or secondary analysis call fails. Retry with a narrower query instead of repeatedly issuing the same failing request.

## Locate the code

Use symbolicated in-app frames when available. Match the top relevant application frame to the current checkout, inspect the surrounding implementation and recent history, and distinguish the observed failing frame from an inferred root cause. If frames remain bundled or source maps are missing, say so explicitly and use release, error-code, and stack evidence without inventing a source location.

Remember intentionally removes recordings, transcripts, prompts, responses, breadcrumbs, user identity, and other private content before events are sent. Work with the retained release, environment, safe tags, counters, error code, and sanitized stack; do not recommend weakening that privacy boundary merely to make triage easier.

## Report the result

Include the issue link and short ID, status, first and last seen times, event and user counts, affected releases/environments, representative event ID, relevant tags and diagnostics, top application frame, likely repository path, evidence-backed cause assessment, recommended disposition, and remaining verification gaps. State when one user or release dominates the volume. Keep confidence proportional to the evidence.
