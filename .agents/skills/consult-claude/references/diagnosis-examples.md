# Diagnosis examples

## Known recurring pattern

A constrained Claude Code attempt returns:

```text
Not logged in
```

Do not report “Claude failed” or conclude that the user's normal Claude session is signed out from this result alone. A sandboxed process may be unable to see an existing macOS Keychain-backed login/session. Re-run the same supported `claude auth status` check through Codex's narrow escalation mechanism before distinguishing:

- **Authenticated outside the sandbox:** sandbox/Keychain session isolation; use the approved path for the required consultation.
- **Still signed out outside the sandbox:** genuine unauthenticated Claude Code CLI; request the supported user login action.
- **Cannot launch or find the CLI:** executable or environment failure, not authentication.
- **Base URL, DNS, TLS, proxy, token, or `claude-config-invalid` error:** endpoint/configuration failure, not evidence about the normal Keychain-backed login.

## Compact reports

Successful recovery:

> Claude was authenticated in the approved macOS execution environment; the earlier `Not logged in` result was sandbox/session isolation. The second opinion completed through the existing Claude Code route, with no credential changes.

Genuine sign-out:

> The same Claude Code status check returned signed out both inside the sandbox and through the approved macOS execution path. The second opinion remains blocked until the user completes the supported Claude login flow; no credentials were read or changed.

Endpoint/configuration failure:

> Claude authentication was not classified because the configured route failed at the endpoint/configuration layer. No endpoint or credential was changed; the reported configuration issue must be resolved or explicitly authorized before retrying.
