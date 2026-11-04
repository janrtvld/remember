---
name: remember-ui-decisions
description: Apply Remember's established interface taste and decision process. Use for every UI build, redesign, polish pass, component change, loading or empty state, modal, navigation, onboarding, settings, activity, wiki, day, project, agent, landing-page preview, or visual QA task in this repository.
---

# Remember UI Decisions

I want this to be as perfect as Linear's website or Apple Notes: simple purpose, simple architecture, simple design, simple implementation. Cut taglines, helper text and secondary labels. If a screen needs them to make sense, fix the layout. Every decision should elevate the user experience (UX), developer experience (DX) and agent experience (AX) at once, without breaking anything.

Build the smallest interface that explains itself. Remember is a calm, mostly invisible tool for a technical audience; the UI must expose useful work context without becoming a dashboard of implementation details.

## Decide before editing

When unsure how an interaction or experience should work, inspect the relevant flow in an available reference app using task-authorized access. Observe the interaction and its transitions, feedback, and edge states, then apply those findings within Remember's purpose and design. If access is blocked, state the actual restriction; do not present assumptions as observed behavior.

1. Inspect the current screen, its nearest sibling, and the shared primitive before changing code.
2. Identify the user's exact requested change. Preserve every nearby choice they did not ask to revisit.
3. Reuse the closest established pattern and shared component. Use the same headers, controls, and flow structure as accepted neighboring screens; do not create near-duplicate variants for the same user action.
4. Remove elements before adding containers, labels, helper text, or variants. Review and remove unnecessary complexity yourself before handing over the result.
5. For exploration, add temporary separate variants or a dedicated preview. Never overwrite the current accepted UI until the user selects a direction.

## Keep controls compact

- Use the shared `small` button variant for every new button unless the user explicitly asks for a larger primary action. This is Remember's default, not an exception.
- Keep icon buttons visually small and give them the same rounded hover background everywhere, including modal close buttons. Preserve an invisible forgiving hit area when needed.
- Match new search fields, switches, dropdowns, tabs, sidebar rows, disclosures, and breadcrumbs to an existing compact control before inventing dimensions.
- Prevent width and position changes between loading, installed, empty, hover, and update states. Labels and controls must not shift when their state changes.
- Use tabular numerals when changing numbers would otherwise move adjacent layout.

Compact visuals matter because the audience is technical and repeatedly uses dense desktop surfaces. Large padding makes the app feel generic and wastes the limited Electron window.

## Reduce visual and verbal noise

- Never use the product UI as a changelog, implementation breadcrumb, or explanation of what the user asked Codex to build. Technical implementation differences should become user-facing choices only when they help the user make a meaningful decision.
- Prefer an ordinary chat message and reply when those suffice; do not introduce a separate proposal component for that exchange. Keep one coherent recording flow with shared controls instead of exposing separate technical recording routes.
- Keep only the text and labels needed for the user to act. Do not add a helper sentence by default. If the screen needs explanatory copy to make its basic purpose clear, improve its layout or use an established interaction. Preserve essential accessibility labels and information needed for consequential decisions.
- Do not add decorative sparkles, boxed icons on grey backgrounds, labels above self-explanatory sections, redundant status badges, or bordered cards by default.
- Prefer flat content and whitespace. Add a card only when the border materially clarifies grouping or interaction.
- Keep secondary and destructive row actions hidden until hover or keyboard focus when discoverability is still clear. Never make every delete control permanently compete with the content.
- Keep result and task titles terse. Put essential nuance in optional secondary text; do not turn every item into a paragraph.
- Use the active language of the surrounding surface. Remember product copy is Dutch by default; keep familiar technical terms in English when that reads naturally.

Less copy matters because Remember is opened for orientation and action, not to read a description of itself.

## Preserve the page system

- Use `system-ui`; do not add custom interface fonts.
- Keep typography slightly compact and consistent across pages. Do not enlarge a page's base type independently.
- Keep top breadcrumb or title bars full width and bordered when the surrounding page system does so. Center and max-width the content below them.
- Align page titles, tabs, loading skeletons, and content origins to the same coordinates across navigation. Switching pages must not cause a header jump.
- Use slate for neutral hover and selected navigation treatments. Reserve the Geist blue scale for meaningful accent or progress states.
- Use solid red backgrounds for destructive primary actions, not white buttons with red outlines.

## Make interactions honest

- Every visible control must work end-to-end. Do not ship hardcoded options, placeholder status, or controls that only resemble a feature.
- Loading states must preserve the final layout and show a spinner instead of briefly flashing onboarding or permissions state.
- Empty states stay sober: an icon only when useful, one sentence, and one relevant action.
- Animate only when it clarifies continuity. Preserve the user's choice when they ask to remove an animation.
- Keep navigation, hover, and z-index hit testing usable in the browser test app. Treat drag regions and traffic lights as native-only behavior that needs a focused desktop check when changed.
- Build landing-page product previews from the actual app components and styles with fake data where feasible. Never guess at a replica when the current implementation is available in the repository.

## Verify visually

1. Read the root `AGENTS.md` before UI testing.
2. Run `pnpm dev` and open `http://localhost:3000` with the Browser or Chrome tool. This is the real renderer with the development browser bridge.
3. Check default, hover, active, loading, empty, error, and narrow-window states affected by the change.
4. Compare alignment and density with the nearest accepted Remember surface and any user-provided screenshot.
5. Use `pnpm dev:desktop` only for changes to Electron IPC, native capture, permissions, notifications, tray behavior, the updater, window chrome, or packaged-app integration. Report browser QA and native QA separately.

Do not call a UI change finished from code inspection alone when it can be exercised in the browser test app.
