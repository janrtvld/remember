# PM-v1 — where should Remember use model reasoning?

A controlled comparison on synthetic source packets. The runner changes no app runtime, tasks, memory, settings, or release. Read together with [case design](CASE-DESIGN.md).

## Hypotheses

1. An efficient model can interpret straightforward events and suppress misleading sources, but may miss useful cross-source initiative.
2. A frontier model earns its extra latency/tokens only if it improves concrete usefulness or resolves semantic ambiguity. Larger is not presumed better.
3. A cascade that escalates every non-silent or uncertain efficient-model decision may reduce frontier calls, but silent false negatives can survive. Measure those misses explicitly.
4. Provenance, current access, grants, deduplication, expiry and effects belong to deterministic code. A correct model decision is a recommendation, never execution authority.

## Frozen comparison

Use the repository-pinned provider runtime, an authorized local provider login, tools disabled, an ephemeral read-only working directory, and no inherited project/user instructions. The cached Remember model catalog supplies eligibility only; an unavailable model is recorded as a failure, never substituted.

Arms: `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-6-astra`, all reasoning effort `low`, identical prompt/schema and original source packet. These are relative product tiers, not measured parameter counts. SDK does not report the effective served model: record requested model and `effectiveModel:null` explicitly.

Run all 16 fresh synthetic cases on each arm (48 calls), sequentially. Rotate model order by case index: L/S/A, S/A/L, A/L/S. Then repeat PM03, PM04, PM07, PM09 once with the model order reversed (12 calls). Maximum 60 calls, zero application retries, one fresh thread per call, 120-second deadline. Abort the batch on an execution-tool boundary violation or three consecutive transport failures; retain all partial output. No prompt/model tuning after results.

The repeat subset was selected by opaque IDs before corpus results: error synthesis, conflict, reported speech, delayed context. Repeats are stability probes, not independent new cases. Freeze source/prompt/schema/corpus/oracle/runner/catalog hashes before calls. Keep raw provider events, full final text, exact input, usage and failures.

## Assessment and routing simulation

Score JSON shape/exact source IDs separately from decision-kind agreement and full semantic review against the prewritten oracle. All positive cases require useful meaning; silence cannot pass them. An unsupported actor, live/media claim, invented completion, broadened grant or source instruction obeyed is a blocking semantic failure, regardless of aggregate score. Independent review receives anonymized arm labels and all original source packets/outputs. Model review aids the root's case-by-case judgment; it is not an external ground-truth population.

Report first-pass counts out of 16 separately from four repeated calls. Measure monotonic request-to-stream-end duration, input/cached/output/reasoning tokens as reported. Report median and range; with 16 heterogeneous cases, no production p95, dollar estimate or native event-to-chat latency claim.

Frozen offline cascade: use Luna output only if structurally valid, `kind=silent` and `uncertainty=none`; otherwise select Astra's independent answer to the **original** packet. Count missing/error arms as failures. Simulated serial latency is the sum of the two separately measured calls for escalated cases; this is not an executed cascade. Also show always-Sol/always-Astra, model-call counts and positive-case misses. Do not hide Luna misses behind aggregate suppression counts.

After assessment choose a bounded next implementation candidate and name remaining uncertainties. Completing this experiment does not itself enable a runtime feature.

## Reproduction

`pnpm --filter @remember/desktop exec tsx scripts/benchmarkProactiveModels.ts --dry-run --out /private/tmp/remember-proactive-models-PREFLIGHT`

`pnpm --filter @remember/desktop exec tsx scripts/benchmarkProactiveModels.ts --run --out /private/tmp/remember-proactive-models-RUN`

Each output directory must be new. The runner archives its inputs before any model call and writes a terminal report even after a failure. Auth contents are neither read nor archived.
