# Agent protocol experiments

This directory contains isolated agent-host experiments and synthetic intent/provenance regressions. Some protocol and validation modules are also imported by the desktop application; do not remove this directory as if it were only archived notes.

| Files | Purpose |
| --- | --- |
| `briefing-protocol.mjs`, `briefing-host.mjs` | Briefing validation and host execution boundaries |
| `coordinator.mjs`, `journal.mjs`, `client.mjs` | Durable single-job coordinator and local client protocol |
| `task-service-transport.mjs` | Transport between a local client and an owned host process |
| `job-router*.mjs` | Job-routing experiments |
| `intent-*.ts`, `audit-source-provenance.ts` | Source identity, quotation, intent, and temporal checks |
| `*.test.*` | Deterministic protocol and storage regressions |

Run a focused JavaScript suite from the repository root:

```sh
node --test experiments/always-on-agent/briefing-protocol.test.mjs
node --test experiments/always-on-agent/briefing-host.test.mjs
```

TypeScript test files use the desktop workspace's `tsx` runner. Native integration should use the documented [Electron QA flow](../../docs/native-verification.md).

Live probes are developer tools. They may start provider work, use SSH, and create files on an explicitly configured host. Read the selected probe and its configuration first. Use an isolated profile and a fresh, owned temporary run directory, and retain failures. Never reset a shared provider service or replace the installed app's data to make a probe pass.

Frozen benchmark manifests retain hashes and paths for earlier synthetic runs. Their referenced `.qa` artifacts are local run output and are not included in a fresh checkout. A manifest is not a claim of current performance or a complete reproducible result without those inputs.

Do not commit live transcripts, credentials, host-specific run output, or personal data. Keep model structure checks, semantic quality, and native integration evidence separate.
