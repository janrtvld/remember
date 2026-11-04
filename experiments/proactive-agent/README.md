# Proactive agent experiments

Controlled fixtures for evaluating useful, source-backed assistance. The desktop application uses the briefing schema and validator from `briefing-models`; these files are part of the current dependency graph.

- `briefing-models/`: synthetic source packets, output schema, prompts, and a deterministic validator.
- `assistant-style/`: fictional context and prompt variants for conversational answer quality.

Keep evaluation inputs separate from expected answers. Valid JSON and exact quotations establish structure and source identity, not whether a suggestion is useful. Inspect the generated content before claiming an improvement.

Run outputs belong in an ignored `.qa` directory or an owned temporary directory. Private investigations and historical installed-app results are not part of the public source distribution. Live model calls and host execution require the user's authorization and must use isolated state.
