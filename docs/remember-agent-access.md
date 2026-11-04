# Remember through Codex and Claude

## Product contract

The user works in their chosen agent. Remember captures, processes, stores and retrieves context in the background. Opening its window is optional for normal work. “Background” means the native process continues running; quitting the process or sleeping the computer is a different availability state.

Start with the jobs people actually ask for:

| User request | Required behavior |
| --- | --- |
| “What did we discuss?” | Find the latest actual conversations across dates; retrieve exact transcript passages on demand. |
| “Where were we with this project?” | Find maintained decisions, relevant conversations and recent activity, with dates and sources. |
| “What do I still need to do?” | Read Remember's current task records and distinguish saved status, inferred completion and user commitments. |
| “Remember this decision” | Save or reconcile knowledge in the chosen Space, with revision checks. |
| “Mark that done” | Apply the explicitly requested task change from the host, without a second mandatory trip into Remember. |
| “Record this / pause until tomorrow” | Operate the existing recording/capture lifecycle through a narrow control tool, showing actual state. |
| “Tell me when the transcript is ready” | Establish a subscription in a host that can actually deliver and resume; otherwise explain the available alternative. |

A day summary, displayed webpage, raw audio-chunk count and recorded conversation are different evidence types. The service must make those distinctions, rather than asking the model to reconstruct them from internal tables.

## Findings from the current product

The screenshot was reproduced by Claude Desktop's connected Remember tools. The legacy conversation command searches accepted local episodes only. It excludes imported recordings, and omitting a date selects the latest day rather than the latest conversations. The internal assistant already has a combined archive reader with deletion, visibility, source identity and imported-original handling. Reimplementing that reader in Swift would recreate the divergence.

The separately installed **Remember Tasks** plugin maintains an independent task list. Its old coverage was presented as if it were Remember's current list. Native Remember's task tool returned the actual current items. This is a product naming/data-ownership problem, not something a longer prompt can fully solve. The canonical task store must remain the native one. Retire or clearly rename the experimental list at packaging level after an explicit migration decision; preserve its existing user data and do not merge statuses automatically.

Claude also encountered oversized output: its measured older conversation response approached a million characters, while `now` exceeded 100k. These were reported by Claude's actual tool run, not a benchmark of all possible records. Ordinary retrieval needs bounded lists and separately paginated originals.

Disabled audio/agent ingestion was observed. Disabled is not broken; no settings should be enabled merely to make a demonstration look complete. Current activity coverage and the time an answer is fetched must remain separate.

## Ownership and transport

Keep one canonical query/mutation implementation in Remember's native TypeScript layer. The renderer, internal assistant, local CLI and MCP should call that owner. The Swift executable remains a transport and local archive fallback, not another interpretation of which conversations and tasks exist.

Prefer MCP when the host supplies it; retain the CLI for Codex/Claude Code and diagnostics. A short `remember` skill chooses the right user workflow and preserves evidence boundaries. Put optional exchange/monitoring procedures in references. Keep `memorize` as the existing save entry point during compatibility migration. Do not install unconditional history hooks or start a second autonomous agent just to answer a normal lookup.

The existing app already hides its window on close and can start without showing a window at login. Use this before inventing another daemon. Startup, unavailable-service diagnostics and eventual service-only packaging remain separate work from windowless reads.

Proposed consolidated public surface, after compatibility migration:

- `remember_status`: profile, supported operations, live availability and per-source coverage.
- `remember_search` and `remember_read`: bounded search/listing plus exact revision-aware source reads across conversations, activity, notes and knowledge.
- `remember_tasks`: canonical list/read and narrowly scoped user-requested changes.
- `remember_memory`: Space discovery, reads and revision-checked saves.
- `remember_capture`: existing start/stop/pause/resume operations with truthful state and permission results.
- `remember_changes`: catch-up for supported source changes; clearly distinguish state comparison from an event journal.

Names are a proposed target, not commands the current skill should invent. Keep dedicated operations where their safety and lifecycle differ; do not replace them with an opaque `ask_remember` second-model hop. Tool output should normally fit comfortably within the host context, and always expose a way to retrieve omitted requested content.

Direct user instructions authorize the specified ordinary write. Inferred task completion never does. Mutations need current revisions, retry-safe operation identity where outcomes can be ambiguous, audit attribution and readback. Existing request-answer publication rules must be implemented explicitly in the host before removing the present Remember review step.

## Events and delivery

Emit events for meaningful state transitions: a transcript becoming ready, a task requiring input, a completion suggestion changing, a received answer, or a recording failure. Do not emit one “new” event for every analysis pass over the same evidence. A durable record should carry an event ID, occurrence time, subject reference, source revision and a small payload. Keep replay/delivery state separate from user task state. Changes in access and deletion must invalidate later reads and pending delivery.

Use one outbox shared by catch-up and delivery adapters; acknowledge delivery separately from successful follow-up work. A periodic hash comparison cannot promise an audit of every intermediate transition. Start with the source lifecycle owners and reuse existing persisted provenance where it actually establishes event identity.

OpenAI's [MCP Events documentation](https://developers.openai.com/plugins/build/mcp-events) describes authenticated event discovery/subscriptions and signed webhook delivery for Work/Cloud chats and dots. That is a real prospective wake path, separate from ordinary MCP resource updates. A deployed subscription, receipt and resumed chat still need an actual host test; this documentation does not establish local Codex or Claude Desktop support. A local stdio server alone is insufficient. Design the relay around minimal event metadata and authenticated follow-up reads, with retries, deduplication, expiry, cancellation and revoked-access handling.

[Claude Code Channels](https://code.claude.com/docs/en/channels-reference) is another host-specific candidate, not proof that Claude Desktop chats can be woken. No channel or event subscription was installed during this investigation. Do not solve uncertain push support by silently spawning `codex exec`, changing hooks or adding schedules.

## First implemented slice

The existing `remember_conversations` tool now accepts `view=list` and `view=transcript`. The CLI equivalents are `conversations --view list` and `conversations DATE --view transcript --id ID --revision REVISION`. These route through the existing native socket into the shared visible archive. Legacy no-view reads remain compatible and their narrower coverage is documented.

Lists default to five newest visible records across archive dates, including imports, with short excerpts and exact identities. Transcript reads return at most 6,000 Unicode characters and a next offset. A changed revision requires relisting; removed sources return unavailable instead of stale text. Deliberate manual recordings do not require AI classification to become readable; dismissal and deletion still apply.

The bundled skill now routes current-task questions to native Remember, prefers connected MCP, and separates optional workflow references from ordinary recall. Packaging and installation include those references for both providers and development test profiles. The save skill now passes the required revision for updates.

This slice does not implement task mutations, recording controls, a unified search index, event delivery, migration of the independent task plugin, or a fully service-only installation. Those remain explicit follow-up stages, not capabilities claimed by the revised skill.
