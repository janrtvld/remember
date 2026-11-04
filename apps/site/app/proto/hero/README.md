# Remember hero exploration

An isolated comparison of the existing Memory hero and three new directions.
No production homepage component imports this directory. All prototype pages and the image route return 404 outside development. The generation prompt lives with the authoring sources and is never served.

## Current status — restart requested, 16 October 2026

The rendered `safety/` directions (net, glass ribbon and drawer) were rejected.
The user explicitly invoked `emil-get-creative` and asked for stronger integration
with the page itself. The next exploration is at the research/taste-checkpoint
stage; no new direction has been selected or implemented. The sections below
document earlier rounds, not the current recommendation.

## Third exploration — Afdruk, Focus, Tijd

The third-round comparison is at `/proto/hero/next?v=2`, with the accepted homepage
at `?v=1` and three new directions at `?v=2`, `?v=3`, and `?v=4`. The user
rejected the earlier concepts; they remain available below as exploration history.

The user liked these visuals, then asked for the product to live inside the 3D
interaction itself. This pass removes the separate context card completely. It
retains the site's fonts, heading, light grid, blue CTA and existing materials.

- **Afdruk / retain:** the metal pins spell an actual remembered decision:
  “Donderdag live”, “Terugknop blijft” or “Klaar om te delen”. Dragging continuously
  reshapes the pin heights. Source, time and supporting detail are engraved into
  the same projected metal base. Moment buttons provide keyboard selection.
- **Focus / retrieve:** the surface holds original conversation and work excerpts.
  Moving the optical lens transforms a source into its remembered decision inside
  the glass, with its source and time. On narrow screens the evidence moves under
  the lens. The result also has an accessible text equivalent.
- **Tijd / resume:** the rotary object's recessed reading window carries a work
  moment and its next step. Turning the ring moves work through that aperture.
  The final handoff is the starting point; arrows, Home, End and time selectors
  provide the same navigation.

`work-moments.ts` uses the onboarding fixtures from `LocalAppPreview.tsx`.
These are labelled examples, not live capture or assistant results. No separate
product panel is needed to explain the objects. The full product preview remains
immediately below the hero.

The objects are procedural WebGL, not Blender assets. All renderers have fallback
paths, reduced-motion handling and offscreen/hidden suspension. No new runtime
dependency was added. `next/` owns this round; `refined/ExistingPageParts.tsx`
provides the site framing with an optional description override, and the shared
picker handles comparison. Production homepage code is unchanged.

### Third-round verification

The prior visual-only and context-card passes were browser-reviewed at 1280px,
900px and 390px, including pointer and keyboard interaction and NL/EN language
changes. Earlier `next-*` and `product-*` screenshots document those passes.
Current integrated-object verification:

- Browser-reviewed the integrated objects at 1280px and 390px; Focus also at
  900px and across mobile-to-desktop resizing in the production preview.
- Verified direct pin scrubbing, lens dragging and dial rotation, plus keyboard
  selection and NL/EN rendering. These are viewport/mouse checks, not physical
  device touch testing.
- Moved Focus provenance into the clear aperture, consumed final drag coordinates,
  and added footer clearance so the mobile prototype picker cannot cover the
  language selector. Both issues were rechecked in the browser.
- `pnpm lint`, site TypeScript, scoped Biome, `git diff --check` and production
  build pass. No console warnings or errors observed in the built preview.
- Fallback, reduced-motion and offscreen paths were code-reviewed. Forced GPU loss
  and OS motion preference changes were not exercised.
- Evidence: `integrated-afdruk.jpg`, `integrated-focus.jpg`, `integrated-tijd.jpg`
  and `integrated-tijd-mobile.jpg` in this task's `hero-review` artifact folder.
- These checks validate website prototypes; native Remember was not changed.

## Refined direction — existing site style

The next pass is at `/proto/hero/refined?v=2` (Stroom) and
`/proto/hero/refined?v=3` (Glas). Its picker includes the current homepage for
comparison. The earlier exploratory themes remain below for reference.

This pass retains the production Manrope/Figtree typography, Dutch hero copy,
blue download button, sticky header, light grid, 1200px frame, and every section
below the hero. `ExistingPageParts.tsx` intentionally copies the current local
hero helpers so this experiment does not require changing the accepted page.

- **Stroom:** a physical ribbon of work fragments. Pointer movement sends a wave
  through the pages; dragging collects them around the selected thought. Release
  preserves that thought with a clearly marked example source. Click to reopen;
  Enter/Space, arrows, and Escape provide keyboard control.
- **Glas:** an asymmetric optical-glass ribbon that unfolds directly with a drag.
  A compact button provides the same interaction. The canvas renders on input
  and spring settling, with a static SVG fallback when WebGL is unavailable.
- Both scenes inherit the website palette and fit the same reserved art region.
  Reduced motion and offscreen/hidden pause paths avoid unnecessary movement.
- The comparison picker moves into the free desktop header area so it does not
  cover the artwork controls; on smaller viewports it remains at the bottom.

### Refined review evidence

- Reviewed at 1280px, 900px, and 390px, including gathered/open states.
- Verified direct drags, retained source selection, keyboard arrow selection,
  Escape/reset, and glass Fold/Unfold in the browser. No console warnings/errors
  were observed in the reviewed production preview.
- Refined the ribbon framing, responsive scale, source-caption spacing, glass
  silhouette, Bézier continuity, and reflection normals from actual screenshots.
- Lint, scoped Biome, site TypeScript, production build, and whitespace checks pass.
- Reduced motion and unavailable-WebGL handling are implemented and code-reviewed;
  OS preference toggling and forced GPU failure were not simulated.
- These are isolated website previews. The accepted homepage and native app were
  not changed. Desktop/mobile screenshot evidence lives in this task's
  `hero-review` artifact folder.

## Original exploration

Run `pnpm dev:site`, then open `/proto/hero?v=4` on port 3001.
The reviewed production build also runs locally on port 3002.

| Variant | Direction | Interaction | Tradeoff |
| --- | --- | --- | --- |
| 1 — Current | Existing Memory game | Match the pairs | The visual depends on discovery |
| 2 — Prism | Quiet gallery, cobalt-edged optical glass | Move the pointer or rotate the seven-leaf fan | Abstract; depends on the product section for explanation |
| 3 — Continuum | Work fragments becoming a continuous thread | Three chapters gather the ribbon into a memory | More vertical space and explanatory content |
| 4 — Room | A cinematic workspace after hours | Explore the cube, notebook, and laptop for example memories | A larger visual departure and a raster backdrop |

Click the picker or use 1–4 / arrow keys. R resets the current interaction.
Selection is persisted in the URL. Keyboard shortcuts leave inputs and the
interactive product preview alone. At desktop widths Continuum's picker moves
above the hero to avoid covering its chapter controls.

## Materials

- Prism uses dependency-free WebGL analytic ray tracing, with a CSS fallback.
  The renderer draws only while input is settling and stops when hidden or offscreen.
- Continuum uses deterministic CSS 3D geometry. Coordinates are rounded before
  server rendering to avoid browser float serialization hydration warnings.
- Room uses a generated architectural backdrop, not a Blender model. It was made
  with the built-in image generation tool. Asset and exact prompt are saved at
  `apps/site/app/proto/hero/assets/after-hours-studio.png` and
  `apps/site/app/proto/hero/assets/after-hours-studio.prompt.txt`.
- All copy, controls, and sample memories are HTML. Each new direction leads into
  the existing interactive `LocalAppPreview` and the actual Mac download URL.

## Review evidence — 2026-10-16

- Iterated Prism's silhouette/materials three times from browser screenshots.
- Refined Continuum's framing, gathered state, and copy; tested chapter changes.
- Refined Room's first-screen framing, memory interactions, and touch states.
- Browser checks at 1280px, 900px, and 390px; responsive layouts, keyboard variant
  switching, rotation, memory open/close, product anchor, and preview panning.
- Phone preview keyboard panning verified: 348px visible region, 520px canvas,
  ArrowRight moved scrollLeft from 0 to 40 without switching the prototype.
- Reduced-motion CSS and WebGL paths are implemented; OS preference emulation
  was not exercised in the browser tool.
- `pnpm lint`, scoped Biome, site TypeScript, `git diff --check`, and site production
  build pass. The sandboxed build stalled at compilation; the same build outside
  the sandbox completed successfully.
- This validates the website renderer. No Electron or native behavior was changed
  or validated by this exploration.

No direction has been promoted. The current homepage and unrelated experiments
remain intact.
