# Briefing synthesis fixtures

Three synthetic cases test whether a short briefing adds useful decision support beyond repeating the supplied source. The output contract and validator are also used by the desktop application.

| File | Purpose |
| --- | --- |
| `cases.v1.json` | Corpus with human-readable case metadata |
| `inputs/BP01.json`–`BP03.json` | Exact model-visible source packets |
| `prompt.v1.txt` | Model instruction prefix |
| `schema.v1.json` | Structured output contract |
| `validateOutput.mjs` | Runtime shape, quote, and source checks |
| `oracle.v1.json` | Expected meanings and forbidden claims for review |
| `calls/BPxx.input.txt` | Materialized prompt plus input |

All source identifiers and project details are synthetic. Source revisions are hashes of fixture text; they do not establish actual authorization, native observation, or current external state. Never include the oracle, expected answers, or judge feedback in model input.

The cases cover a Dutch project review, an English supplier review, and a stale observation that should remain silent. Review factual accuracy, quoted support, missing evidence, and whether the result helps the intended decision. A longer answer is not necessarily better.

Run the validator's regression tests from the repository root:

```sh
pnpm --filter @remember/desktop exec tsx --test ../../experiments/proactive-agent/briefing-models/validateOutput.test.ts
```

Live comparisons should freeze the exact inputs and model settings, retain every output and failure, and report semantic quality separately from latency and token use. Store generated artifacts outside the tracked source tree. These cases do not establish general performance on real work.
