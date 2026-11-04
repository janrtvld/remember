# Day attention and outcome quality

The first review covers eight frozen days, with 33 attention estimates and 30 outcome headlines. The user accepted 24 attention estimates and 7 headlines. Their free-text corrections are authoritative even when a category checkbox is absent. A note qualified one otherwise accepted attention estimate. Unchecked omissions are unknown, not proof that nothing is missing.

The private snapshot, original labels and original outputs are preserved outside the repository in the day-review artifact. Local evaluation copies and model outputs are under `.qa/day-quality/` (ignored by Git). Do not commit private records or authentication settings.

## Contract

- Attention is personal involvement: briefing, reading, thinking, editing and reviewing. Unattended agent runtime and passive open windows do not count. Reading need not involve typing. Preserve switches and uncertainty through shard compression; do not reconstruct duration from message spacing or broad timeline blocks.
- Outcomes explain meaningful results or concrete progress using recognizable subjects and purposes. Internal identifiers and implementation details rarely belong in headlines. Keep unfinished work unfinished and group substeps toward one result.
- Capture time differs from event time. A reopened old message is not a new completion. Retrospective duration does not start at capture time. Preparation, indecision and agent claims do not prove external execution.
- User-approved examples remain positive controls; omitting everything is not success.

## Repeatable evaluation

`apps/desktop/scripts/benchmarkDayQuality.ts` runs the production evidence compaction, partitioning, shard prompt/schema/parser, and final prompt/schema/parser. It uses Remember's configured Codex model and effort with tools disabled. Every run stores the exact inputs, prompts, raw responses, parsed outputs, model usage, hashes and results. It never writes production Day memory.

```sh
TZ=Europe/Amsterdam pnpm --filter @remember/desktop exec tsx scripts/benchmarkDayQuality.ts --run=my-dry-run
TZ=Europe/Amsterdam pnpm --filter @remember/desktop exec tsx scripts/benchmarkDayQuality.ts --run=my-candidate --live
```

Run names must be new to avoid overwriting evidence. `--cases=id,id` selects cases; `--corpus=PATH` supplies additional cases. `--candidate` loads the saved experimental `.qa/day-quality/dayAnalysisPrompts.candidate.ts`. The production prompt was restored after the candidate failed to show a consistent improvement. `--baseline` loads the frozen local `.qa/day-quality/dayAnalysisPrompts.before.ts`, which was captured before changes and has absolute imports to the production helper modules. This baseline file is local evidence, not part of a fresh checkout. Exact emitted prompts are stored per run so the comparison can be audited despite later helper changes.

The committed corpus contains eight fictional controlled scenarios derived from failure categories, including background delegation, reading, passive windows, separate workstreams, wrong-day completion, profile changes, meaningful unfinished work, and positive delivery controls. Pattern checks are narrow proxies, not a general semantic judge. Inspect actual outputs; a word check must not mistake “not merged” for a completion claim.

The real-data experiment uses 16 evenly sampled original records from two selected subjects, with no user labels included in model inputs. It is reconstructed input, not an exact historical replay: sampled observations do not establish attention duration, and a later send cannot be inferred from an earlier draft. Real-case output quality requires semantic review; no synthetic pass percentage should be presented as real-world accuracy.

## Evaluation integrity

- Initial runs `baseline-1` and `candidate-1` were invalidated because fixture cutoff and narrated times differed by an hour. Never use their scores.
- A broad forbidden-word assertion in `candidate-2` rejected the correctly qualified phrase “not merged”; this is documented, and later runs use positive-claim matching.
- Reserved-day labels were inspected during analysis. They are validation material, not a blind holdout. Future unbiased testing needs fresh whole days.
- Repeated key cases check basic variability, not statistical significance. Attention quality on the user's actual days remains unproven until broader evidence coverage is replayed or fresh days are reviewed.
- Changes are local source only. No installed-app validation or deployment is implied by model or unit tests.

## First result

The corrected baseline passed 7/8 controlled cases. The final candidate also passed 7/8; three additional repeats of the problematic unfinished-progress case passed 2/3. An intermediate 8/8 result was not stable. The candidate is retained separately, not adopted into production. This is a functioning regression benchmark and a negative/partial experimental result, not a verified behavior fix.
