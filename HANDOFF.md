# Markup Studio — Handoff

## What this is
A pure-browser PDF viewer + markup tool for architectural CAD PDFs ("Bluebeam-lite").
Single user, runs locally, no server.

- **Location:** `BB PDF/markup-studio/`
- **Spec:** `../Design.rtf` (kept up to date with finalized decisions)
- **Build plan:** `.cursor/plans/markup_studio_build_09fecdf3.plan.md` (do not edit)

## Stack
Vanilla TypeScript + Vite, `pdfjs-dist` (v6), `pdf-lib`, File System Access API, custom reactive store.

## How to run
```bash
npm install
npm run dev
```
Open **http://localhost:5174/** in Chrome/Edge.

> Notes:
> - Use the dev server URL, not `file://` on `index.html`.
> - Port 5173 may serve stale code; prefer 5174 (`npm run dev -- --force` if needed).
> - `npm run build` currently passes.

## Source layout
- `src/state/` — store, types, undo
- `src/pdf/` — loader, render, export, importMarkups
- `src/view/` — PageView (3 layers: PDF canvas, markup canvas, SVG), Workspace (virtualization)
- `src/tools/controller.ts` — navigation, shapes, annotations, measure, edit shortcuts
- `src/ui/AppShell.ts` — menus, ribbon, panels, HUDs, split view, overlay bar, doc tabs
- `src/markups/` — draw, hitTest
- `src/styles/main.css` — dark theme

## Milestones (all implemented at a functional level)
- **M1** Foundation + viewer (open, layout shell, virtualization, continuous/single, rotation, Flip/Zoom nav, thumbnails/bookmarks, HUDs, status bar)
- **M2** Markup tools + editing (shapes, annotations, selection/handles, page defaults, Properties panel, Markups list, Edit menu)
- **M3** Measure + scale (calibration, imperial scales, dimension/polyline/area/angle, ft-in formatting, Totals)
- **M4** Save / Flatten / Reopen (pdf-lib export + metadata dict, Save/Save As, reopen-parse, Flatten, page insert/rotate)
- **M5** Advanced (multi-doc tabs, split view, overlay bar, raster snip v1, new blank page sizes)

---

## RESOLVED (2026-06-11, part 3): callout elbow + offset dimensions

- **Callout leader has an elbow**: horizontal run exits the text box at
  mid-height (left or right side), bends at a kink, then goes diagonally to
  the arrow. `CalloutMarkup.kinkX` stores the elbow X (undefined = auto on
  the anchor side); a "kink" selection handle drags it left/right. Shared
  geometry in `util/geometry.ts: calloutLeader()` keeps draw / hitTest /
  handles consistent.
- **Dimensions are offset-style**: measured points (x1,y1)/(x2,y2) stay on
  the object; `offset` displaces the dimension line perpendicular; extension
  lines stretch to bridge. Handles: `start`/`end` micro-adjust the measured
  points, `offset` (mid-span) pulls the dimension line away. Geometry in
  `util/geometry.ts: dimensionGeometry()`.
- **Properties panel rebuilt and actually wired** (inputs previously had no
  event handlers): stroke, weight, line style, opacity for any markup; for
  dimensions also End style (slash tick / arrow) and "Round up to"
  (Exact, 1/4", 1", 6", 1') — rounding is ceil on the real-world value,
  implemented in `formatLength(..., roundUpToInches)`.

## RESOLVED (2026-06-11, part 2): core tool interactions

- **Polyline/polygon committed only the last segment** — `handlePointerDown`
  reset the in-progress vertex list on every click. Now poly tools accumulate
  vertices across clicks; Enter finishes, Escape cancels, double-click or
  closing on the start point still ends the shape; angle tool auto-completes
  at 3 points.
- **Markups were not editable after placement** — added move (drag body) and
  resize/reshape (drag selection handles) in the select tool, with a single
  undo step per gesture and Escape to abort. Rectangles now expose 8 handles
  (corners + edge midpoints); handles added for text, callout (incl. anchor),
  and angle markups.
- **Text / Callout / Sticky used browser prompt() popups** — replaced with an
  inline textarea on the page (commit on blur or Ctrl/Cmd+Enter, Escape
  cancels). Callout is now Bluebeam-style: drag from subject → text box with
  border, leader line from nearest box edge, filled arrowhead. Double-click
  any of these in select mode to re-edit. Sticky renders as a folded-corner
  note icon.
- **Dimension** now draws architectural graphics: extension (stick) lines,
  45° slash ticks, centered ft-in label with halo; Shift locks horizontal/
  vertical during draw and endpoint drag. Measurement markups default to teal.
- **Global shortcuts no longer fire while typing** in inputs/textareas
  (previously typing "r" in any field switched to Rectangle).

## RESOLVED (2026-06-11): upside-down rendering + overlay not working

**Root cause of instability:** the project used pdfjs-dist v6's *modern* build,
which assumes JS features (`Math.sumPrecise`, `Map.getOrInsertComputed`) the
installed Chrome doesn't have — the console TypeErrors below were breaking
rendering, not cosmetic. **Fix:** `src/pdf/loader.ts` now imports the *legacy*
build (`pdfjs-dist/legacy/build/pdf.mjs` + legacy worker), which polyfills
these. Verified: Test-PDF.pdf (AUS manual, 272 pp, /Rotate 0) renders upright
through the legacy build at the pinned version (6.0.227).

**Overlay:** the feature was UI-only — the toggle and dropdowns wrote state but
nothing rendered it. Now implemented: `PageView` has an `overlayCanvas` layer
(between PDF and markup layers) with `renderOverlays()`/`clearOverlays()`;
`Workspace.syncOverlays()` composites the selected pages at slot opacity onto
the current page and re-syncs on page/zoom/state changes. Also fixed:
selecting "— Page —" wrongly set page 1 (`Number('') === 0`), and the overlay
bar's hidden class is now derived from state instead of blindly toggled.

Remaining overlay gap vs Design.rtf: page selection by bookmark name (currently
page numbers only).

---

## Previous bug notes (kept for history): pages render upside down
Opening `AUS Design Standards Manual-Q1 2026.pdf` renders BOTH the main view and the
thumbnails rotated 180° (text readable but inverted).

### Relevant code
`src/pdf/render.ts`
```ts
const viewport = page.getViewport({ scale, rotation });
await page.render({ canvasContext: ctx, viewport, canvas }).promise;
```

`src/pdf/loader.ts` (per page)
```ts
const vp = page.getViewport({ scale: 1, rotation: page.rotate });
pages.push({ width: vp.width, height: vp.height, rotation: page.rotate });
```

`src/view/Workspace.ts`
```ts
const rotation = doc.pages[pageIndex]?.rotation ?? 0;
await pv.renderPdf(page, zoom, rotation);
```

Thumbnails in `src/ui/AppShell.ts` `renderLeftPanel()` use `getViewport({ scale })`
(defaults rotation to `page.rotate`).

### Analysis so far
- PDF.js renders upright by default (it Y-flips via `viewport.transform`). Both the main
  view and thumbnails go through the same default-rotation path, so the inversion is
  inherent to how this file is being handled, not a divergence between the two paths.
- A 180° "upside down" result = flip on BOTH axes, i.e. an *extra* 180° relative to upright.
- Leading hypothesis: this CAD-exported PDF may bake page rotation into the content
  stream **and** also set `/Rotate 180`. PDF.js applies `/Rotate` once on top of the
  already-rotated content → net 180°. If so, the fix is to NOT re-apply `page.rotate`
  for such pages (render with `rotation: 0`) — but this must be verified against a normal
  PDF so we don't break correctly-authored files.
- Other things to rule out: pdfjs v6 viewport API change, `pageHeight` math
  (`viewport.height / zoom` vs `viewport.rawDims.pageHeight`) — note `pageHeight` only
  affects markup coordinate mapping, not the PDF raster, so it is NOT the cause of the
  visual flip.
- CSS: `.page-view` / `.page-layer` have no transforms, so it is not a CSS flip.

### Console warnings seen in dev (pdfjs v6, likely unrelated to the flip)
- `TypeError: Math.sumPrecise is not a function`
- `TypeError: this[#methodPromises].getOrInsertComputed is not a function`
- `Cannot use the same canvas during multiple render() operations` (render re-entrancy;
  worth guarding by cancelling the prior `RenderTask` before re-rendering a page)

These suggest the runtime may lack very new JS features pdfjs v6 expects. Consider pinning
pdfjs to a slightly older v6.x or using the `legacy` build if these persist.

### Suggested next steps
1. **Reproduce in isolation:** generate a known-orientation test PDF with `pdf-lib`
   (no network needed), render it through the app, and confirm whether a *normal* PDF
   is also flipped. This separates "code bug" from "this-file-specific".
2. If only the AUS file flips: log `page.rotate`, `page.view` (viewBox), and
   `viewport.transform` for page 1 of that file and compare to a normal PDF.
3. Apply the minimal fix based on findings (most likely: handle the baked-rotation +
   `/Rotate` double-count), and keep both code paths (main view + thumbnails) consistent.
4. Add a guard to cancel the previous `RenderTask` per canvas to remove the
   "same canvas during multiple render()" rejection.

### Files to touch for the fix
- `src/pdf/render.ts` — `renderPageToCanvas`, `renderThumbnail`
- `src/pdf/loader.ts` — `loadPageInfos`
- `src/view/PageView.ts` — `pageHeight` after render (markup coords only)
- `src/ui/AppShell.ts` — thumbnail rendering in `renderLeftPanel`

---

## Other recently completed work
**Panel toggle UX:** toggle triangle buttons stay visible on the workspace edges when a
side panel is collapsed (overlay layer `.panel-edge-controls`, `z-index: 30`, event
delegation on `.main-area`). Panels are resizable via `.panel-resizer` drag handles;
widths `leftPanelWidth` / `rightPanelWidth` (160–480px) live in the store. Verified on
localhost:5174.

## Finalized design decisions (in Design.rtf)
- No pen/freehand; highlighter only. No text highlight/underline/strikethrough, radius,
  count, stamps, metric, volume, autosave, password.
- Revision cloud = polygon modifier (Shift on close), not a standalone tool.
- Save + Save As; Flatten whole document; reopen via custom metadata + best-effort
  annotation parse.
- Imperial ft-in, no decimals. Paste-in-place (Ctrl+Shift+V): same coords if same page
  size, else center-align.
- Multi-doc tabs, split view with draggable divider, overlay bar, raster snip v1.

## What remains
1. Fix upside-down rendering (above) — top priority.
2. Verify thumbnail rotation consistency and markup `pageHeight` math.
3. Guard render re-entrancy (cancel prior RenderTask per canvas).
4. Systematic testing with large architectural PDFs.
