# Task quality evaluation

Tasks should represent finite, meaningful outcomes that the person wants preserved across context changes. Related outstanding steps belong in the description. A shared company or project does not make two distinct outcomes the same task.

This iteration follows the October 29 review: 27 verdicts and one additional note. The raw personal archive and review labels remain outside the repository. The controlled fixtures encode the feedback without treating ambiguous or unreviewed decisions as ground truth.

## Behaviour

- Group an application's supported remaining video, answers, and references into the application task.
- Reuse the exact task ID when adding steps or refining an existing generated substep into its established outcome.
- Keep ordinary titles stable. `titleChangeReason: "outcome"` explicitly distinguishes a supported outcome refinement from cosmetic rewording. User-edited title and description fields remain protected in storage.
- Keep the description's generated limit and open-task prompt projection aligned at 600 characters, so a short checklist can survive subsequent analysis. Keep existing total prompt budgets and priority for open identities.
- Suppress optional templates, incidental agent steps, ordinary automatic CI, and automatic mirroring of assigned tickets or reviews. Explicit meaningful small commitments remain eligible.
- Preserve unfinished outcome identity after partial progress. Missing observations do not prove completion or create new verification obligations.
- No automatic migration, deletion, or merging of existing user tasks is performed by this change. Existing multiple fragments need a separately grounded reconciliation; the model must not treat unrelated tasks as duplicates.

## Evaluation entry point

```sh
pnpm --filter @remember/desktop exec tsx scripts/benchmarkTaskQuality.ts --run=unique-run-name --live
pnpm --filter @remember/desktop exec tsx scripts/benchmarkTaskQuality.ts --run=unique-day-run --live --day
pnpm --filter @remember/desktop exec tsx scripts/benchmarkTaskQuality.ts --run=unique-validation-run --live --day --corpus=tests/fixtures/task-quality/validation-v1.json
```

Omit `--live` to materialize inputs without contacting a model or reading the installed profile. Corpus `userName` controls fixture attribution; it defaults to the fictional name Alex. `--cases=id,id` narrows a run. Model and effort come from Remember's configured analysis settings. Tools are disabled and checked in returned provider items. The runner writes no live tasks. It retains exact prompts, raw outputs, parsed plans, corpus, schema hash, usage, and results under `.qa/task-quality/<run>`.

Day mode uses the same `dayAnalysisPrompts.ts` shard and synthesis functions, structured schemas, and parsers as production. Ambient mode uses the production ambient prompt and parser. A prompt-builder extraction made this possible without loading Electron or replacing production behaviour with an evaluation-only prompt.

`--baseline` is a local comparison against the pre-change prompt snapshots in `.qa/task-quality`; it requires those snapshots. Both sides of the real-context policy comparison used the same schema. That is a policy comparison, not an exact recreation of the previously installed application.

The scorer checks task count, required outcome/step patterns, stable IDs, explicit refinement, source IDs, and absence of unsupported lifecycle changes. Pattern checks are useful regressions, not a general semantic oracle. Inspect the output before claiming a quality improvement. `reviewOnly` corpora do not receive automatic quality pass/fail results.

## Observed results

Configured model: `gpt-5.6-sol`, medium effort.

| Run | Result | Scope |
| --- | --- | --- |
| `baseline` | 12/16 | Original ambient policy and controlled cases |
| `outcome-v1` | 16/16 | Revised ambient policy |
| `day-outcome-v1` | 16/16 | Production shard + synthesis prompts |
| `final-ambient-regression` | 16/16 | Expanded description support |
| `final-day-validation` | 8/8 | Additional controlled contrasts, including partial completion and an actionable CI failure |

The final explicit-refinement contract passed 3/3 targeted cases in both `outcome-refinement-ambient` and `outcome-refinement-day`, including stable ID reuse, explicit outcome refinement, and user-written title protection.

Real-context policy comparisons used five selected sets of original captured screen records from before task creation. Those private sources and outputs remain local and are not included in this repository. The comparison improved application-level framing and suppressed an unwanted review request while retaining a useful profile-update task. One active drafting window was insufficient to score the desired application outcome and was not counted as a success. Additional unlabelled outputs were not scored.

Published controlled fixtures fictionalize names and identifiers. Development scores describe the locally frozen versions; the publish runs explicitly validate the fictionalized fixtures.

These results support a narrower improvement in outcome granularity and external-backlog filtering. They do not establish production-wide accuracy, full recall, or performance on new users. All feedback-derived cases are development/validation data; no independently authored blind holdout is claimed.

## Mechanical validation

The daily-review suite passed all 673 tests, including a new parser → SQLite → restart check for outcome refinement and preservation of user edits, existing title-stability checks, and prompt-budget tests.

The isolated Electron ambient task scenario passed native source parsing, SDK fixture transport, task creation, exact source linking, notification opening, restart, repeated-evidence deduplication, and non-replayed notifications/offers. The initial fixture used Remember's own bundle prefix and was correctly rejected as derived output; its external test identity was corrected without changing that production filter. A shorter runtime path avoids the macOS socket limit.

Native proof: `/private/tmp/rtq/runs/2026-10-29T13-57-47.656Z/report.json` and `ambient-proof.json`. This uses synthetic capture and deterministic model output, not physical capture or live-model quality. The final field-only refinement change is additionally covered by the parser/store tests and live model cases. No installed application was replaced by this work.
