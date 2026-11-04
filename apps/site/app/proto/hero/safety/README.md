# Remember safety-net hero lab

Status: archived exploration, retained for comparison. These variants are not the homepage's selected direction.

An isolated, `noindex` exploration of Remember as a safety net for work. The accepted homepage remains the baseline. This lab reused its colors and typography, but replaced its integrated grid composition with a separate illustration stage. That compositional change is a central finding from this round.

## Open the variants

Run `pnpm dev:site`, then use the on-page picker or these routes:

| Variant | Route | Art-direction tradeoff |
| --- | --- | --- |
| Current homepage | [v=1](http://127.0.0.1:3001/proto/hero/safety?v=1) | Comparison baseline. |
| Doek / Net | [v=2](http://127.0.0.1:3001/proto/hero/safety?v=2) | The clearest safety-net metaphor: work visibly lands in a yielding blue surface. |
| Glas / Glass | [v=3](http://127.0.0.1:3001/proto/hero/safety?v=3) | Polished and sculptural; its relationship to remembering is more abstract. |
| Lade / Drawer | [v=4](http://127.0.0.1:3001/proto/hero/safety?v=4) | A tactile personal-memory object; may suggest a physical hardware product. |

## Interaction and implementation

This rejected round explored Airbnb-inspired warmth and the continuity described in Benji Taylor’s [Family Values](https://benji.org/family-values): motion should explain how one state becomes the next, and an existing object should remain the same object through a transition. These references did not establish that the resulting visual direction was successful.

`safety-runtime.ts` owns the shared Three.js scene, lighting, raycasting, falling/capture simulation, and retrieval. `work-fragments.ts` supplies eight illustrative work moments. Each sculpture supplies its geometry, landing positions, and physical response. A caught fragment moves forward when retrieved and returns to its resting place; it is not replaced by a duplicate. Drawer contents follow the moving tray.

Drag the catcher, drop another moment, click a captured fragment, or use the keyboard-accessible recall controls. Animation can be paused. RAF stops while offscreen or the document is hidden; paused scenes settle after interaction. Reduced motion starts with captured fragments and uses immediate state changes. Teardown removes listeners/observers and disposes GPU resources.

This is an interactive illustration, not actual recording, account memory, or source-app access. All moments and timestamps are demo data.

## Verification status

Verified in browser: all three variants render; drawer pointer dragging updates its open state and ARIA; pause and keyboard retrieval work for the Figma and conversation fragments. Biome, lint, and site typecheck pass.

Production build passes, including `/proto/hero/safety`. Responsive browser QA at 390 × 844 confirms the picker fits, the page has no horizontal overflow, and drawer opening and retrieval remain usable. The larger recalled fragment stays in front of the drawer rim. Desktop drag, pause, replay and keyboard recall were exercised. Reduced-motion logic and sculpture resting states were checked in code; an OS-level reduced-motion browser session was not exercised. No native behavior is changed or claimed.
