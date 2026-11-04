---
name: remember-ui-intent
description: Turn open-ended Remember UI requests and “make it like X” references into a coherent, demonstrated user experience. Use when improvement, polish, or reference fidelity needs interpretation; skip this extra workflow for narrow, fully specified edits.
---

# Remember UI Intent

Own the translation from the user's intent to a complete experience. Examples such as spinners, summaries, or composer behavior are clues to the quality bar, not automatically an exhaustive checklist. Infer missing details within the requested flow; do not expand into unrelated features or a whole-app redesign.

## Establish the target before editing

Inspect the current flow and the reference the user supplied. For a live application, observe its actual interactions when access is available; a screenshot establishes appearance, not behavior. Distinguish observations from assumptions. If access is unavailable, identify the missing evidence and proceed only with claims the available reference supports.

Briefly state:

- What the user should be able to do and experience.
- Whether the reference governs visual fidelity, interaction behavior, overall quality, or a combination; which Remember conventions remain.
- What would make the result unacceptable, using concrete failures in this flow.

Usually announce a reasonable interpretation and proceed. Ask only when competing interpretations would materially change the result and the available context cannot resolve them. Do not make a routine interpretation statement an approval gate.

Use [remember-ui-decisions](../remember-ui-decisions/SKILL.md) for Remember's design defaults. Explicit user direction takes precedence. Do not silently preserve compactness, existing layout, or component structure when those choices prevent the requested experience. Equally, “like X” does not automatically mean copying its branding or every feature. Resolve that distinction in the stated interpretation.

## Demonstrate a complete flow early

Choose the smallest ordinary user journey that exposes the intended experience. For a chat redesign, this might be empty screen → send → thinking → answer → follow-up. Include the transitions between states, not just attractive isolated screens.

Make this path work in the real renderer before spending substantial effort polishing individual components or expanding technical test coverage. Observe the current behavior first: reuse working behavior and change the layer that owns the actual gap.

For reference-led work, compare equivalent states with comparable window sizes and content. Review composition as a whole: text alignment, icon placement, hierarchy, spacing, composer geometry, action placement, and continuity across states. A component can work correctly while the assembled experience remains wrong.

Keep a short, task-local record of consequential reference differences and known failures, in an existing task note when one exists. Mark each as intentional, unresolved, or corrected with evidence. Do not turn every task into a new specification document. If the user corrects the interpretation, update the target and check the whole affected flow rather than patching only the named symptom.

During long tasks, revisit the complete user flow after each meaningful implementation milestone, before expanding test coverage or infrastructure further. Passing tests do not establish that the experience has improved. Inspect and judge the actual interactions and output; use that observation to choose the next step. Required checks and necessary safety, data-integrity, and regression tests still apply.

## Judge completion against the request

Keep these judgments separate:

- **Functional correctness:** controls, state transitions, accessibility, errors, and data handling work. Run the repository's required checks and relevant regression tests.
- **Experience quality:** the complete flow meets the stated visual and interaction target. Inspect rendered states and transitions; passing tests or taking screenshots without evaluating them does not establish this.
- **Usefulness, when relevant:** the real scenario produces what the user needs. A chat returning a canned response proves connectivity, not access to Remember data; an agent posting a message proves delivery, not useful help. Fixtures can establish mechanics but cannot establish real answer quality.

Do not let success in one category compensate for a failure in another. Choose measurements that address the actual uncertainty: latency numbers cannot establish visual coherence. Preserve necessary correctness checks without making technical certainty the substitute for the user's outcome.

Use browser QA for renderer work and [remember-native-verification](../remember-native-verification/SKILL.md) when the claim depends on native behavior. Follow the user's explicit testing instructions. State evidence boundaries and missing verification without treating them as passes.

Lead the handoff with the demonstrated user outcome and any material remaining gap. Support it with a representative comparison or observed scenario, then summarize technical checks. Distinguish implemented, verified, and installed; do not call the requested experience complete while a known central mismatch remains.
