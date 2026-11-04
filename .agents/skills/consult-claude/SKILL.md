---
name: consult-claude
description: Reliably consult Claude as a second opinion or research collaborator from Remember and Codex tasks while distinguishing a real signed-out state from sandbox or macOS Keychain session isolation and from endpoint or configuration failures. Use whenever a request in this repository asks to consult, check with, ask, cross-check, validate with, or get a required second opinion from Claude or Claude Code.
---

# Consult Claude

Use Remember's project-supported route: the locally installed Claude Code CLI with its existing authentication and login environment. Treat authentication checks and the requested consultation as one required workflow when the user requires Claude's opinion.

## Follow the decision tree

1. **Resolve the supported route.** Locate the existing Claude Code executable and use the repository's established login environment. Verify authentication with the route's read-only `claude auth status` check. Record only the executable path, environment class (sandboxed or approved unsandboxed), exit category, and sanitized error text.
2. **Classify the first result.**
   - Authenticated → invoke Claude through that same route with only task-authorized context.
   - Missing executable or launch failure → report the exact path/launch problem; do not label it an authentication failure.
   - Endpoint, DNS, TLS, proxy, or `claude-config-invalid` failure → classify it as endpoint/configuration, not login or Keychain failure. Do not change endpoints or credentials.
   - `Not logged in`, `loggedIn: false`, or an equivalent signed-out result inside a constrained environment → treat it as ambiguous until the same supported status check runs with approved access to the user's normal macOS login/Keychain session.
3. **Resolve an ambiguous signed-out result.** Request Codex escalation for the smallest exact status command needed to run outside the sandbox. Explain that this checks whether the existing authenticated macOS session is visible; it does not weaken isolation globally or modify authentication.
   - Escalated check is authenticated → diagnose sandbox/Keychain session isolation. Run the required Claude consultation through the same narrowly approved execution path.
   - Escalated check is also signed out → diagnose a genuine unauthenticated CLI and ask the user to complete the project's supported Claude login flow. Do not run login or alter credentials without explicit authorization.
   - Approval is denied or unavailable → state that the required second opinion is blocked on approval for the exact status/invocation path.
4. **Complete the consultation.** Give Claude only the evidence authorized for the task. Compare its response with the primary analysis and preserve disagreements instead of forcing consensus.
5. **Gate completion.** When a Claude second opinion is user-required, never mark the task complete after only a failed constrained attempt. Complete only after the safe authenticated route succeeds, or report the precise approval or user login action still required.

## Enforce safety boundaries

- Never reset, overwrite, expose, export, print, or copy credentials or Keychain secrets.
- Never inspect Keychain entries directly or invent Keychain commands, service names, account names, credential files, or environment variables.
- Never silently weaken sandboxing, broaden an escalation, change a login, or substitute an endpoint.
- Never use a production endpoint or user data beyond the task's explicit authorization.
- Treat Remember's optional Anthropic-compatible endpoint as separate, opt-in configuration. Do not create, edit, or select it merely to make a second-opinion request work.
- Sanitize reports: include the route, sandbox-versus-approved environment, classification, and next action; omit tokens, raw environment dumps, prompts containing private data, and credential-bearing output.

## Report the diagnosis

Use one short statement such as:

> Claude consultation blocked: the sandboxed CLI returned `Not logged in`; an approved out-of-sandbox `claude auth status` check is still needed to distinguish a real sign-out from macOS login/Keychain isolation. No credentials were read or changed.

Read [references/diagnosis-examples.md](references/diagnosis-examples.md) when interpreting failures or writing the final task report.
