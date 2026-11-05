# Landing design decisions

## Current hero and app preview — 2026-11-05

- The requested Revinote hero structure replaces the inset lattice on the main
  landing page: left-aligned two-line title, blue second line, and description
  beside the secondary link and Mac download. Keep Remember's existing header,
  copy, fonts, 1200px frame, and lower sections. The English title now reads
  “The system that remembers your work.”
- The supplied Remember My Day screenshot governs the UI inside the preview:
  220px sidebar, 800px day container, app typography, current navigation, and
  three day tabs. Use fictional demo content rather than the screenshot's
  personal work. Do not show a profile avatar in the preview.
- Keep the original preview dimensions and surroundings exactly: 1166 × 650
  canvas, existing framing, border, corner radius, shadow, and cross marks.
  Preserve the original phone crop and 50% scale. Do not resize the preview to
  fit its frame. Hero actions wrap on the narrowest screens; title sizes
  accommodate both languages. Hero subtext uses font-medium and the available
  row width so it stays on one line when space allows. Stack actions below it
  on narrower windows instead of squeezing the sentence beside them.
- Browser comparison corrected the preview's overridden line height and stale
  day tabs. Verify the assembled hero, navigation, sources, and mobile layout
  when changing this surface. Older grid decisions below remain relevant to the
  retained prototype pages and lower page frame, rather than the current hero.
- The smaller side-by-side hero trial was rejected. Keep the preceding
  Revinote-style hero with 600-weight title and font-medium subtext.
- Match Revinote's entry sequence exactly: 400ms blur-and-rise text, delayed
  by 0/90/180/260ms, followed by the 650ms preview entry after 380ms. Use the
  same easing and transforms, skip repeated visits within the session, and
  disable entry motion when reduced motion is preferred.
- The Agent preview starts with the actual app's “Wat houdt je bezig?” heading
  and centered composer. No separate title bar or suggested-question chips.
  Keep the header actions 8px apart and hero top padding at 96px.

## Earlier grid direction

Selected on 2026-09-09 from the grid, artwork, and Memory entrance prototypes.
The user chose Bare and asked to remove the prototype pages.

## Grid and header

- Keep Inset, the thin slate rules, and the compact sticky Rail header. The header
  download uses the hero button's small secondary treatment.
- Keep the hero plain. Each outer column is two empty rectangles, excluded from
  Memory. The dashboard retains its 1200px frame.
- The selected compact hero has ten columns and five rows at 1024px and above,
  ten columns and six rows at 800px, and eight columns and six rows at 640px.
  Below 640px, hide the memory board and its lattice. Let the hero copy determine
  its height, with a 64px header and no empty tile rows.
- Thin plus signs mark intended intersections. Heavy plus signs, doubled rules,
  standalone labels, and a border above the header were rejected.
- Frame, Open, floating, segmented, Center, and Inlay headers were not selected.
  Dots and animated contours behind the copy were removed. The separate wider
  tile and hero-proportion experiments did not replace the selected layout.

## Phone presentation

- Keep the product preview as a desktop app. Below 640px, scale the fixed desktop
  window to 50%, align it 16px from the left, and crop the right edge with a subtle
  fade. The framing reserves 358px of height. This follows Linear's mobile hero
  presentation; do not replace the sidebar with phone navigation or reflow app views.
- Feature videos stay inline at their original 1632:1080 aspect ratio. Preserve
  the complete recording and the compact play/pause control. Separate result
  posters, "Watch demo" buttons, and a fullscreen-only flow were rejected.

## Cards and game

- Bare cells have no resting fill, outline, or hatch. Interaction and entry hints
  use slate-100 with a 0.5px outline, diagonal lines inset by 6px, and a subtle
  centred Remember mark. Use 6px card insets and 8px corners. Revealed faces use slate-50.
- Keep the original Desk pixels: Macintosh, notebook, headphones, camera, coffee,
  and cassette. Unmatched artwork stays monochrome at 48px or 24px in smaller cells.
  Matched pairs have white faces and object-specific accents over neutral
  charcoal outlines and cool highlights. Hardware stays mostly neutral;
  blue accents, a yellow pencil, and green foliage replace the earlier
  repeated coral/blue/ochre tint. Unmatched revealed cards stay slate-50.
- Retain all six original figures in a full board. Add only enough supplementary
  figures for its size. Each figure appears exactly twice. The 15-figure pool is
  a capacity limit, not a request to show every figure in every round.
- Randomize positions on load. After the first card click, show a neutral
  matched/total counter beside the header Download button. Reserve its width
  before play. No floating overlay or reset control; refresh to start again.
- A newly matched pair finishes its flip, then shares a 420ms settling wiggle
  within its cells. Keyboard and reduced-motion play stay still.
- Permanent card backs, faint permanent Lines, warm Paper and bright Toybox
  palettes were rejected. So were white hover/entry fills, a replacement of the
  original artwork, and the oversized 30-figure expansion.

## Discovery motion

- No opening sequence. After 1.2 seconds, hint a real unmatched pair. Each card
  has a soft 1000ms flicker and a 360ms wiggle, at most two degrees; the second
  card follows 250ms after the first. Both settle back into bare cells.
- After each hint or interaction, wait 2.8–4 seconds before the next hint. With
  one card open, hint only its matching partner. Wait while a missed pair is
  revealed. Prefer a different pair next time; both cards must be visible.
  Stop when the board is hidden or complete, and never reveal figures automatically.
- Keep animation inside cell bounds. Cancel temporary hints on clicks, keys, scroll,
  resize, visibility changes, and reduced-motion changes. Reduced motion skips
  discovery animation. Pointer movement alone does not delay hints.
  The final copied reference seed was 1792189266; live
  boards keep the earlier requested random shuffle on each page load.
- Circular Deal, simultaneous Spread/Fan/Swing, lifted Pair hints, and automatic
  artwork peeks were rejected. The production page needs no replay, settings,
  variant picker, or playback-speed controls.

## Saved artwork settings

These preserve the exact former studio inputs. The accepted Mono palette and
pattern remain relevant; later Bare decisions above supersede its card radius
and artwork size. Seeds describe the saved arrangements, not a fixed live game.

| Setting | Selected Mono | Unselected Paper |
| --- | --- | --- |
| Version | 1 | 1 |
| Seed | 2611557511 | 3059731562 |
| Palette | mono | paper |
| Colour | 0 | 70 |
| Warmth | 0 | 45 |
| Radius | 16 | 10 |
| Depth | 0 | 2 |
| Back | lines | lines |
| Size | 72 | 72 |

The grid decoration and contour experiments had no saved configurations.
This document records choices, not deployment or validation evidence.
