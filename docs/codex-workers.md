# Codex Workers

Inbox Codex turns use the bundled Codex App Server over its public stdio JSON-RPC protocol. Remember retains its own login/profile and a resumable thread per task. Tasks without a project get a persistent directory under `agent-workspaces` in Remember's user data. Selecting another project starts a new thread.

The Worker enables web search and network access, allows workspace writes, and forwards Codex's requested approvals, questions and primitive MCP forms to the Worker tab. Additional filesystem access still follows the provider's approval flow. Stop interrupts the turn and terminates its owned process group; offline mode and app shutdown use the existing process lifecycle. Claude and background analysis retain their existing SDK configuration.

For the personal macOS trial, Remember discovers `unified-computer-use` (or the older `computer-use`) in the user's installed OpenAI bundled-plugin cache. It invokes the installed launcher with its dependencies and provider home; it does not copy those components or substitute the provider's account into Remember. Other MCP servers configured in Remember's Codex home remain available. Missing tools leave ordinary Codex execution usable.

## Existing browser by default

Workers default to the user's existing signed-in browser through OpenAI's installed `cua_repl` MCP and browser extension. The unified tool configuration enables the `chrome` backend (which serves connected extension browsers), while preserving native computer tools. It excludes the in-app browser backend. The Worker discovers browser connection metadata with `cua.listBrowsers()`; an empty browser list from the general `cua.getState()` inventory is not conclusive. It follows an explicit browser/profile choice, and asks when several connections would be ambiguous. It opens a task tab unless the user identifies an existing relevant tab.

This reuses the browser's website sessions and installed extensions without extracting cookies or passwords. It keeps provider website access prompts and limits work to the assigned task. Password-manager unlocks, login and MFA can still require direct user action in the browser. Closing a Worker session stops its tools; Remember does not own or terminate the user's browser. Provider tab cleanup rules apply to task-created tabs.

When no browser is connected, the Worker guides the user to the official app's **Settings > Computer Use** browser setup. See [OpenAI's browser extension documentation](https://learn.chatgpt.com/docs/chrome-extension), which covers Chrome, Edge, Brave, Opera and Vivaldi. Remember does not silently download Chromium, create another profile or substitute Playwright.

The earlier failed in-app browser probe was a different path: that backend requires a matching desktop-owned Codex session. An external Remember thread has no such browser. The Chrome extension connection was separately verified from a real Remember App Server turn using its own thread and turn identities. No desktop identities were substituted.

Google's [Chrome DevTools MCP auto-connect](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect) is another supported route for Chrome 144+, requiring remote debugging and the browser's connection approval. It is not needed or installed for the working OpenAI extension path in this personal trial.

**Continue in Codex** remains an optional handoff for provider-app features. It passes saved task context and recent results into a new official-app conversation. That conversation is not automatically synchronized back to Remember. This personal integration does not establish redistribution support for OpenAI's proprietary components.

## Verification

- `pnpm --filter @remember/desktop types:check`
- `pnpm --filter @remember/web types:check`
- `pnpm lint`
- `pnpm --filter @remember/desktop test`
- `pnpm qa:electron smoke --codex-worker`

The focused Electron flag substitutes a deterministic App Server only in the runner's disposable source copy. It checks actual IPC, approval UI, cancellation, projectless session identity and persistence after renderer reload. It never invokes real browser/computer tools or a paid model.
