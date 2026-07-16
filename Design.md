# Markup Studio — Design & Function Specification

Markup Studio is a **pure-browser, single-user PDF viewer and markup tool** for
architectural / engineering drawings — a lightweight "Bluebeam-lite" that runs
entirely client-side with no server. It opens PDFs (and images), lets the user
draw and measure on them, and saves the markups back into the PDF.

- **Stack:** Vanilla TypeScript + Vite, [pdfjs-dist](https://github.com/mozilla/pdf.js)
  (legacy build) for rendering, [pdf-lib](https://pdf-lib.js.org/) for writing,
  the File System Access API for save, and a small custom reactive store.
- **Target:** Desktop Chrome / Edge.
- **Theme:** Aurora liquid glass — the toolbar, side panels and viewer
  controls are translucent frosted-glass overlays (backdrop blur + edge rim
  lights) floating over a full-bleed light drafting canvas, so the PDF shows
  through beneath them. Deep indigo-navy window chrome, violet glass document
  rail, dark-glass inspector panel, Space Grotesk UI type, steel-blue accents.
  Folded side panels peek out when the cursor brushes the canvas edge and
  fold back a second after it leaves; the arrow buttons pin them open.

---

## 1. Application layout

Top to bottom:

1. **Menu bar** — `File`, `Edit`, `View`, `Help`, the active filename chip, and a
   `Save` button.
2. **Document tab strip** — one tab per open document (with a × close button) and
   a **drag-and-drop zone**: drop a PDF / JPEG / PNG here to open it as an
   additional document.
3. **Ribbon (tool bar)** — grouped tool icons (Navigate, Shapes, Annotation,
   Measure) plus the **Page Default** controls (scale, colors, line weight/style,
   text size) and the Overlay / Snip buttons.
4. **Overlay bar** — appears when the Overlay tool is on (page-overlay slots).
5. **Main area** — left panel (Bookmarks / Thumbnails), center viewer(s), right
   panel (Properties + Totals + Markups list). Panels are resizable and
   collapsible; the collapse arrows tuck inside the panel when expanded.
6. **Canvas HUD** — glass pills centered at the very bottom of the canvas:
   Scale chip, page ‹ n / m ›, and Fit / − zoom % +.
7. **Status bar** — current tool, calibration, cursor position, markup count,
   sheet size.

The viewer supports **single-page** and **continuous** modes, and a
**split view** (vertical or horizontal) that duplicates the active page in a
second pane with its **own independent zoom**.

---

## 2. Documents & files

- **File ▸ New…** — create a blank document: choose paper size
  (8.5×11, 11×17, ARCH C/D/E1/E), orientation (portrait/landscape), and page
  count.
- **File ▸ Open…** — open a PDF via the file picker.
- **Drag & drop** — drop PDF / JPEG / PNG onto the tab strip (or a PDF onto the
  canvas). Images are wrapped in a single page sized to the image.
- **File ▸ Save / Save As…** — write the markups back into the PDF (stored both
  as flattened vector content and as recoverable metadata so they remain
  editable on reopen). Uses the File System Access API where available, else a
  download.
- **File ▸ Close Current / Close All** — closes documents, **prompting to save
  any unsaved changes** first (Save / Don't Save / Cancel). A document is only
  considered unsaved if it was *edited* after its last save — navigation (zoom,
  scroll, page change, tool switch) never triggers the prompt.
- **Markup menu** — Lock / Unlock All on the current page or in the whole
  file (lock = reversible flatten: drawn in place, not editable), and
  Flatten All on Current Page / in Current File (permanent, confirmed first).
  Each markups-list row also has its own padlock toggle.
- Multiple documents can be open at once, each as a tab.

---

## 3. Tools

The active tool is shown in the status bar. After finishing a markup the app
returns to the last Navigate tool (Select or Zoom).

### Navigate
- **Flip** — page through the document like slides: one wheel gesture (or
  PgUp/PgDn/arrow key in single-page mode) turns exactly one page, and the
  viewport position carries over unchanged from page to page.
- **Ctrl/⌘/Shift + wheel** zooms at the cursor on every tool; middle-drag
  pans on every tool (closed-hand cursor while dragging). Drawing and
  measuring tools show a crosshair cursor while armed.
- **Zoom Page** — wheel to zoom; middle-drag (or Alt+drag) to pan in any
  direction; double middle-click resets to 100%.
- **Select** — click a markup to select; drag to move; drag handles to resize;
  drag the corner-outside handles to **rotate** a rectangle/ellipse. Double-click
  text/callout to edit its text.

### Shapes
- **Rectangle / Ellipse** — two clicks (opposite corners). Live preview while
  drawing. Support infill color, **rotation** (type-in degrees or drag), line
  weight/style and opacity.
- **Polygon** — click each vertex; double-click or click the start vertex to
  close. Optional infill; a checkbox toggles a centered **enclosed-area** label.
- **Line** — two clicks. Shift locks horizontal/vertical. Start/end arrowheads
  (filled or open) with adjustable size; arrow tips are sharp (the body is
  shortened to the arrowhead base).
- **Polyline** — click each vertex, double-click to finish. Shift locks each
  segment ortho. Optional arrowheads; a checkbox toggles a centered **total
  length** label.
- **Highlighter** — over blank areas it **free-draws** a fat translucent yellow
  marker; over PDF text the cursor becomes an I-beam to drag-select a **text run**
  and highlight it line-by-line.

### Annotation
- **Text** — two clicks size a box, then type in place (font, size, line spacing,
  infill).
- **Callout** — three clicks: arrow tip, leader elbow, then the text box; then
  type in place. The leader runs horizontally out of the box to the elbow, then
  to the arrow. Arrow style/size adjustable.

### Measure (all honor the page Scale)
- **Calibrate** — click two points across a known distance, then enter the
  real-world length in a prompt; this sets the page **scale factor**.
- **Dimension** — click two points to dimension a span, then a third click pulls
  the dimension line to an offset. Architectural slash-tick (or arrow) ends,
  optional rounding, and the value text always runs **parallel** to the
  dimension line (kept upright).
- **Angle** — three clicks measure an angle.

### Page tools (Page Default bar)
- **Overlay** — composite up to two other pages over the current one, with
  per-slot opacity and an optional Photoshop-style **Multiply** blend.
- **Snip** — drag a region to copy it (page + markups) to the clipboard; paste
  (Ctrl+V) places it with its lower-left corner at the cursor.
- **Page Default controls** — Scale, Line/Fill/Text colors, Line Weight, Line
  Style, and Text Size applied to *new* markups on the current page.

---

## 4. Properties panel

Selecting a markup shows its editable properties on the right:

- **Color** (stroke/line) and **Infill** — a long, thin color box with a
  light-purple frame plus a standard swatch palette. The palette includes 10
  standard colors **and a grayscale ramp** (white, five grays, black).
- **Weight** — presets 0.25 / 0.5 / 1 / 2 / 3 / Custom…
- **Style** — solid / dashed / dotted / centerline.
- **Rotation** (rectangle/ellipse) — type-in degrees.
- **Opacity** — a thin slider in 5% steps with a live percentage readout.
- **Arrows** (line/polyline/callout) — start/end toggles, style, size relative
  to weight.
- **Text** (text-bearing markups) — size, font, line spacing.
- **Measure toggles** — polyline "Total length", polygon "Show area" (+decimals).
- **Dimension** — end style and rounding.

Below the properties is a **Totals** block (linear / polyline / area sums for the
page) and the **Markups list** (most-recent first; the id is dimmed so the type
name reads first).

---

## 5. Editing & interaction

- **Selection handles** — 8 resize handles (corners + edges). For rotated
  rectangles/ellipses the handles rotate with the shape and resize in the shape's
  local frame; four **rotate handles** sit just outside the corners (rotate
  cursor on hover, hand cursor on the resize handles, closed hand while dragging).
- **Hit-testing** honors rotation, so rotated shapes select correctly.
- **Undo / Redo** — full history (Ctrl/⌘+Z, Shift+Z / Ctrl+Y).
- **Clipboard** — Cut / Copy / Paste / Paste-in-Place / Duplicate.
- **Keyboard** — tool hotkeys, Delete removes the selection, Esc cancels an
  in-progress draw or clears the selection, Ctrl/⌘+S saves.

---

## 6. Source layout

```
src/
  main.ts                  app bootstrap (primary + split workspaces)
  state/
    store.ts               reactive store + actions
    types.ts               all types, page sizes, palettes, defaults
    undo.ts                undo/redo history
  pdf/
    loader.ts              open / save / flatten / new / image / insert / rotate page
    render.ts              page → canvas rendering
    export.ts              write markups into the PDF (pdf-lib)
    importMarkups.ts       recover markups from a saved PDF
    textLayer.ts           text-box cache for the highlighter
  view/
    PageView.ts            one page: PDF + overlay + markup canvases + SVG handles
    Workspace.ts           viewport, scroll/zoom, page mounting (per-pane zoom)
  tools/
    controller.ts          all pointer/keyboard tool handling
  markups/
    draw.ts                canvas drawing of every markup type
    hitTest.ts             selection hit-testing
  ui/
    AppShell.ts            menus, ribbon, panels, dialogs, properties, thumbnails
  styles/main.css          the full design system (indigo chrome / light canvas)
```

---

## 7. Notes & known limitations

- Chrome/Edge only (File System Access API + pdfjs legacy build).
- **Bookmarks** — right-click the Bookmarks tab to add a bookmark for the
  current page or a foldable group; drag rows to reorder, drop a bookmark
  onto a group header to file it inside. Saved into the PDF metadata.
- **Search** — the inspector's second tab searches the whole document's text;
  results list matches highlighted in context, in page order, and clicking
  one jumps to the word and pulses a highlight on it.
- **Text formatting** — while editing a text box or callout, a floating
  toolbar offers bold, underline, indent, row spacing, and horizontal +
  vertical alignment (rendered on canvas and in saved/flattened PDFs).
- The PDF's own outline (table of contents) is not imported as bookmarks.
- PDF export of complex markups (callout elbow, dimension ticks/labels, dashed
  styles, measure labels) is simplified relative to the on-screen rendering.
- Rotated-shape resize keeps the shape's local frame but does not pin the
  opposite corner pixel-perfectly during the drag.
