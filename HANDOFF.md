# Markup Studio — Handoff

## What this is
A pure-browser PDF viewer + markup tool for architectural CAD PDFs ("Bluebeam-lite").
Single user, runs locally, no server.

- **Location:** `BB PDF/markup-studio/`
- **Spec:** `Design.md` (kept up to date with finalized decisions)

## Stack
Vanilla TypeScript + Vite, `pdfjs-dist` (v6, **legacy build** — the modern build
assumes JS features Chrome doesn't ship yet), `pdf-lib`, File System Access API,
custom reactive store.

## How to run
```bash
npm install
npm run dev
```
Open the printed URL in Chrome/Edge (use the dev server URL, not `file://`).
`npm run build` passes (tsc + vite).

## Access gate
`src/ui/PassGate.ts` shows a passcode screen before the app boots (awaited at
the top of `main.ts`). One shared code, compared as a SHA-256 hash (plaintext
is not in the source or bundle); success is remembered in localStorage under
`markup-studio-access`. Client-side only — a deterrent for link-sharing, not
real security. For a server-enforced gate after the Vercel deploy, swap in
Vercel Edge Middleware checking a cookie against an env var.

## Source layout
- `src/state/` — store, types, undo
- `src/pdf/` — loader, render, export, importMarkups, textLayer
- `src/view/` — PageView (PDF canvas + overlay canvas + markup canvas + SVG handles), Workspace (virtualization, zoom, split pane)
- `src/tools/controller.ts` — navigation, shapes, annotations, measure, edit shortcuts
- `src/ui/AppShell.ts` — menus, ribbon, panels, dialogs, properties, thumbnails, status bar
- `src/markups/` — draw, hitTest, order
- `src/styles/main.css` — the design system (see Theme below)

## Status (2026-07-05)
All milestones (M1–M5, see `Design.md`) are implemented and working: viewer,
markup tools + editing, measure + scale, save/flatten/reopen, multi-doc tabs,
split view, overlay, snip. Smoke-tested against a 272-page 64MB CAD PDF
(`Test-PDF.pdf`, untracked): rendering, thumbnails, draw/select/move,
properties, undo/redo, text/callout/dimension, split view and overlay all pass
with a clean console.

### Theme (redesigned 2026-07-05, "liquid glass"; recolored 2026-07-11)
Apple-style liquid glass over a full-bleed MUTED DARK-BLUE drafting canvas
(`--canvas`), muted-blue palette throughout (no indigo/violet): heavy frost
(`--glass-blur` 36px), glass tint fills each pane's padding-box while a
`--glass-bevel` gradient fills the 1px border ring (light-catching rim), and
`--glass-edge` inner highlights suggest pane thickness with a cool refraction
bounce along the bottom edge. UI type is Space Grotesk
(`@fontsource-variable/space-grotesk`, imported in `main.ts`). Ribbon labels
and tool icons are near-white with dark halos for contrast over the frost.
The 16x16 pixel corgi is the favicon + menubar app mark
(`public/corgi.png`) and, background-removed + EPX-upscaled to 64px
(`public/corgi-hero.png`), the 256px empty-state mascot whose purple halo
fades into the canvas. Key structure:

- **The canvas fills the whole `.main-area`;** the ribbon, both side panels
  and the bottom HUD are absolutely-positioned frosted-glass overlays
  (`backdrop-filter` + rim-light `--glass-edge` shadows) — the PDF scrolls
  beneath them and shows through, blurred. Glass tokens live in `:root`
  (`--glass-*`); the 8px chrome margin is `GLASS_GAP` in `AppShell.ts` and
  must stay in sync with the CSS insets.
- Panels hang below the ribbon: their `top` is set in `renderChrome()` from
  the ribbon's measured height (re-run on mount + window resize).
- `Workspace.fitPage()` fits the page into the *visible* region between the
  overlays (subtracts panel widths / ribbon / HUD).
- The viewer controls (Scale chip, page ‹ n / m ›, Fit − % +) are glass pills
  centered at the very bottom of the canvas (`.canvas-hud`).
- Overlay + Snip sit in their own **Edit** ribbon group; filename chip is
  centered in the menubar.
- Properties panel: navy header band (markup type + page, icon reused from
  the ribbon `TOOL_ICONS` via `PROP_ICON`), then Line / Infill / Text color
  wells — each an independent per-markup override of the page defaults.
- Markups list rows: color dot · type · abbreviated info (`ab…yz` of the
  markup's text content, full text in the tooltip). Dragging a row shows a
  glowing insertion line between rows.
- Selection handles on canvas are blue (`#2f6fe0` / `#7a97e8` rotate handles)
  — set in `src/view/PageView.ts`.
- Arrowheads are 1:1 (base width = length) triangles, sized by
  `ARROW_LEN`/`ARROW_SPREAD` in `src/markups/draw.ts`; size options go up to
  800% of the line weight.

### Rendering pipeline (rebuilt 2026-07-10 for large CAD/Revit PDFs)
Tuned for multi-MB vector sheets (tested with a 31MB / 53-page ARCH D set):

- **Capped base + visible-region detail.** Each page's full bitmap is capped
  at `MAX_BASE_PIXELS` (16M px, `PageView.ts`) and CSS-stretched; when the
  screen needs more, a `detailCanvas` re-renders ONLY the visible region at
  the exact zoom (pdfjs `transform` offset). Deep zooms therefore cost a
  ~1–2M px region render (tens of ms) instead of a gigapixel page.
- **Never blank.** Renders go to offscreen canvases and blit on completion;
  `setLayout()` synchronously stretches the existing bitmaps to the new zoom.
- **Settle debouncing.** Rapid wheel zooms only restyle CSS; the crisp pass
  runs once, `ZOOM_SETTLE_MS` after the last step (`Workspace.scheduleCrisp`).
  In-flight renders are cancelled when superseded.
- **Region markup canvas.** The markup layer covers just the viewport
  (+30% margin) and redraws synchronously — markups never lag the PDF.
  `screenToPage` maps through the page element's layout size, independent of
  any bitmap resolution. Snip uses `PageView.captureRegion()`.
- **Overlay bitmap cache.** Slot pages rasterize once per capped scale into
  `_ovCache`; opacity/multiply changes and zoom steps above the cap only
  recomposite (~1ms). Overlay renders are cancellable.
- **Prefetch gating.** Neighbour pages (±2) prefetch 350ms after the crisp
  pass and only at zoom ≤ 1.5 — never while studying details.
- Continuous mode rebuilds its wrapper stack only when the page count
  changes (it used to rebuild on every state change, including cursor moves).

## Resolved history (condensed)
- **Upside-down rendering / broken pdfjs v6:** caused by the *modern* pdfjs
  build requiring `Math.sumPrecise` etc.; fixed by importing the **legacy**
  build in `src/pdf/loader.ts`. Don't switch back without checking Chrome
  support.
- **Overlay was UI-only** → implemented as a dedicated canvas layer in
  `PageView` + `Workspace.syncOverlays()`.
- **Poly tools committed only the last segment**, markups weren't editable
  after placement, `prompt()` popups for text → all replaced with proper
  multi-click accumulation, move/resize/rotate handles, and inline textarea
  editors.
- **Callout** has an elbow leader (`kinkX`/`kinkY`, shared geometry in
  `util/geometry.ts: calloutLeader()`); **dimensions** are offset-style
  (`dimensionGeometry()`), with slash/arrow ends and round-up options.

## Finalized design decisions (in Design.md)
- No pen/freehand; highlighter only. No text highlight/underline/strikethrough,
  radius, count, stamps, metric, volume, autosave, password.
- Revision cloud = polygon modifier (Shift on close), not a standalone tool.
- Save + Save As; Flatten whole document; reopen via custom metadata +
  best-effort annotation parse.
- Imperial ft-in, no decimals. Paste-in-place (Ctrl+Shift+V): same coords if
  same page size, else center-align.
- Multi-doc tabs, split view with draggable divider, overlay bar, raster snip v1.

## Known limitations / what remains
1. The Bookmarks tab is a placeholder (PDF outline not parsed yet); overlay
   page selection is by page number, not bookmark name.
2. PDF export of complex markups (callout elbow, dimension ticks/labels,
   dashed styles, measure labels) is simplified relative to on-screen
   rendering.
3. Rotated-shape resize keeps the local frame but doesn't pin the opposite
   corner pixel-perfectly during the drag.
4. More systematic testing with large architectural PDFs.
