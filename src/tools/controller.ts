import {
  getActiveDoc,
  getState,
  selectMarkups,
  uid,
  updateActiveDoc,
  updateMarkup,
  replaceMarkups,
  returnToNavTool,
} from '../state/store';
import type {
  CalloutMarkup,
  InkMarkup,
  Markup,
  Point,
  StickyMarkup,
  TextMarkup,
  ToolId,
} from '../state/types';
import { normalizeRect, calloutLeader, dimensionGeometry } from '../util/geometry';
import { findMarkupAtPoint, cloneMarkup, getMarkupBounds } from '../markups/hitTest';
import { measureTextBlockHeight } from '../markups/draw';
import { moveToBack, moveToFront, nudgeOrder } from '../markups/order';
import { applyMarkupChange, recordMarkupChange } from '../state/undo';
import { ensureTextBoxes, getTextBoxesSync, type TextBox } from '../pdf/textLayer';
import type { Workspace } from '../view/Workspace';
import type { PageView } from '../view/PageView';

/** Fat highlighter pen width (page points) and its translucent yellow colour. */
const HL_PEN_WIDTH = 14;
const HL_COLOR = '#f5c542';
/** Fat-marker cursor (hotspot at the nib tip); falls back to crosshair. */
const MARKER_CURSOR =
  `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'>` +
  `<path d='M13,3l8,8-6,6-8-8z' fill='%23f5c542' stroke='%23a8801a' stroke-width='1.2'/>` +
  `<path d='M7,9l8,8-3.2,2.4-4.8-0.5-1.3-3.5z' fill='%23ffe9a8' stroke='%23a8801a' stroke-width='1'/>` +
  `<path d='M3,19l3.5-1.2-2.3-2.3z' fill='%23333'/></svg>\") 3 19, crosshair`;

interface DrawState {
  start: Point | null;
  points: Point[];
  pageIndex: number;
  pv: PageView | null;
}

/** Active move/resize of committed markups (navigation tools). A move drag
 *  carries EVERY selected markup via `originals`; handle drags stay single. */
interface EditState {
  mode: 'move' | 'handle';
  handleId: string;
  markupId: string;
  start: Point;
  original: Markup;
  /** Snapshots of every markup being moved (multi-selection drags). */
  originals: Map<string, Markup>;
  before: Markup[];
  pv: PageView;
  moved: boolean;
}

/** In-progress rubber-band (marquee) selection on empty canvas. */
interface MarqueeState {
  pv: PageView;
  pageIndex: number;
  start: Point;
  /** Shift/Ctrl held: add to the existing selection instead of replacing. */
  additive: boolean;
  base: string[];
}

/** In-progress 3-click callout (anchor → kink → text). */
interface CalloutDraw {
  pv: PageView;
  pageIndex: number;
  anchor: Point;
  kink: Point | null;
}

/** In-progress 3-click dimension (start → end → offset/location). */
interface DimDraw {
  pv: PageView;
  pageIndex: number;
  p1: Point;
  p2: Point | null;
}

/** Default callout box size in page points (grows as the user types/resizes). */
const CALLOUT_W = 150;
const CALLOUT_H = 48;

let draw: DrawState = { start: null, points: [], pageIndex: 0, pv: null };
let edit: EditState | null = null;
let marquee: MarqueeState | null = null;
let calloutDraw: CalloutDraw | null = null;
let dimDraw: DimDraw | null = null;
/** In-progress 2-click calibration (point 1 → point 2 → prompt for length). */
let calibDraw: DimDraw | null = null;

/** In-progress highlighter gesture — free-hand ink swipe over an area, or a
 *  text selection (drag from a glyph) that snaps to text-line rectangles. */
interface HighlightDraw {
  pv: PageView;
  pageIndex: number;
  mode: 'ink' | 'text';
  points: Point[];
  /** text mode: index of the glyph box where the drag started. */
  startIdx: number;
  /** text mode: the page's text boxes in reading order. */
  boxes: TextBox[];
}
let highlightDraw: HighlightDraw | null = null;
let panning = false;
let panStart = { x: 0, y: 0, scrollLeft: 0, scrollTop: 0 };
let lastClick = 0;

/** An inline text/callout editor is currently open. Queried from the DOM (not a
 *  flag) so it can never get stuck if the editor's host element is recreated. */
function isInlineEditing(): boolean {
  return !!document.querySelector('.inline-text-editor');
}

/** Manual click counter for click-based tools — `e.detail` is unreliable
 *  because preventDefault() on the first pointerdown suppresses the browser's
 *  click sequence and the detail counter no longer increments. */
let lastPolyClick = { time: 0, x: 0, y: 0 };
/** Browser delay window for a double-click. */
const DBL_CLICK_MS = 350;
const DBL_CLICK_PX = 6;

function isDoubleClick(e: PointerEvent): boolean {
  if (e.detail >= 2) return true;
  const now = performance.now();
  const dt = now - lastPolyClick.time;
  const dp = Math.hypot(e.clientX - lastPolyClick.x, e.clientY - lastPolyClick.y);
  return dt < DBL_CLICK_MS && dp < DBL_CLICK_PX;
}
function recordClick(e: PointerEvent): void {
  lastPolyClick = { time: performance.now(), x: e.clientX, y: e.clientY };
}

/** Toggle the closed-hand cursor while a control point / body is being dragged. */
function setGrabbing(on: boolean): void {
  document.body.classList.toggle('grabbing', on);
}

/** Canvas cursor for the active tool: a crosshair while any drawing/measure
 *  tool is armed, an open hand for Pan, the plain arrow for navigation.
 *  While a pan drag is live (middle-drag on any tool) the closed hand wins —
 *  Workspace.refresh() runs during the drag and must not clobber it. */
export function cursorForTool(tool: ToolId): string {
  if (panning) return 'grabbing';
  if (tool === 'pan') return 'grab';
  if (tool === 'flip' || tool === 'zoom' || tool === 'select') return '';
  if (tool === 'highlighter') return MARKER_CURSOR; // refined to I-beam over text on hover
  return 'crosshair';
}

export function handlePointerDown(e: PointerEvent, ws: Workspace): void {
  const doc = getActiveDoc();
  if (!doc) return;
  const pv = ws.getPageViewAt(e.clientX, e.clientY);
  if (!pv) return;
  const tool = getState().activeTool;
  const p = pv.screenToPage(e.clientX, e.clientY);

  // Middle-button drag pans on EVERY tool. Left-button pans with the Pan tool,
  // or Alt+Left on the Navigate tools (flip/zoom) where it has no other meaning.
  // Middle-drag pans on every tool; Alt+Left pans on the navigation tools.
  // The Pan tool's own left-drag starts later, AFTER the markup hit test, so
  // markups stay clickable in pan mode too.
  if (
    e.button === 1 ||
    (e.button === 0 && e.altKey && (tool === 'flip' || tool === 'zoom' || tool === 'pan'))
  ) {
    panning = true;
    panStart = {
      x: e.clientX,
      y: e.clientY,
      scrollLeft: ws.scrollEl.scrollLeft,
      scrollTop: ws.scrollEl.scrollTop,
    };
    // Closed hand while panning — middle-drag included, on every tool
    ws.contentEl.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }

  // An inline editor is open: this click is outside it (clicks inside are
  // stopped by the editor). Let the editor's blur commit the text and return
  // to select; don't begin a new markup here.
  if (isInlineEditing()) return;

  // Markups are clickable/editable on EVERY navigation tool (select, flip,
  // zoom, pan) — the Pan tool only grabs the sheet when the click misses.
  if (tool === 'select' || tool === 'flip' || tool === 'zoom' || tool === 'pan') {
    if (e.button !== 0) return;
    const selected = getState().selectedMarkupIds;

    // 1) Mouse-down on a selection handle → resize/reshape (single selection)
    const handleId = (e.target as HTMLElement | null)?.dataset?.handle;
    if (handleId && selected.length === 1) {
      const m = doc.markups.find((mk) => mk.id === selected[0]);
      if (m && m.pageIndex === pv.pageIndex) {
        edit = {
          mode: 'handle',
          handleId,
          markupId: m.id,
          start: p,
          original: cloneMarkup(m, m.id),
          originals: new Map(),
          before: [...doc.markups],
          pv,
          moved: false,
        };
        setGrabbing(true);
        capturePointer(e);
        e.preventDefault();
        return;
      }
    }

    const hit = findMarkupAtPoint(doc.markups, pv.pageIndex, p);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;

    // 2) Double-click a text-bearing markup → edit its text inline.
    //    isDoubleClick (manual timer), NOT e.detail: preventDefault() on the
    //    first pointerdown stops the browser's click counter from advancing.
    if (hit && !additive && isDoubleClick(e) && (hit.type === 'text' || hit.type === 'callout' || hit.type === 'sticky')) {
      lastPolyClick = { time: 0, x: 0, y: 0 }; // consume the click pair
      selectMarkups([hit.id]);
      openEditorForExisting(pv, hit);
      e.preventDefault();
      return;
    }
    // Arm the double-click detector for the next click
    recordClick(e);

    // 3) Mouse-down on a markup body → select (Shift/Ctrl toggles membership)
    //    and start a move drag that carries the WHOLE selection
    if (hit) {
      let ids: string[];
      if (additive) {
        ids = selected.includes(hit.id)
          ? selected.filter((i) => i !== hit.id)
          : [...selected, hit.id];
      } else {
        // Clicking a member of a multi-selection keeps the group together
        ids = selected.includes(hit.id) ? selected : [hit.id];
      }
      selectMarkups(ids);
      ws.redrawAllMarkups();
      if (!ids.includes(hit.id)) {
        e.preventDefault();
        return; // additive click removed it — nothing to drag
      }
      const byId = new Map(doc.markups.map((mk) => [mk.id, mk] as const));
      const dragIds = ids.filter((id) => byId.get(id)?.pageIndex === pv.pageIndex);
      edit = {
        mode: 'move',
        handleId: '',
        markupId: hit.id,
        start: p,
        original: cloneMarkup(hit, hit.id),
        originals: new Map(dragIds.map((id) => [id, cloneMarkup(byId.get(id)!, id)] as const)),
        before: [...doc.markups],
        pv,
        moved: false,
      };
      setGrabbing(true);
      capturePointer(e);
      e.preventDefault();
      return;
    }

    // 4) Empty canvas: the Pan tool grabs the sheet…
    if (tool === 'pan') {
      panning = true;
      panStart = {
        x: e.clientX,
        y: e.clientY,
        scrollLeft: ws.scrollEl.scrollLeft,
        scrollTop: ws.scrollEl.scrollTop,
      };
      ws.contentEl.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
    // …the other navigation tools rubber-band a selection box
    marquee = { pv, pageIndex: pv.pageIndex, start: p, additive, base: additive ? [...selected] : [] };
    if (!additive && selected.length) {
      selectMarkups([]);
      ws.redrawAllMarkups();
    }
    pv.clearSvg();
    capturePointer(e);
    e.preventDefault();
    return;
  }

  // Highlighter: free-hand ink over an area, or text selection over glyphs
  if (tool === 'highlighter') {
    const boxes = getTextBoxesSync(doc.id, pv.pageIndex);
    if (!boxes && doc.pdfDoc) void ensureTextBoxes(doc.id, doc.pdfDoc, pv.pageIndex);
    const hitIdx = boxes ? boxes.findIndex((b) => pointInTextBox(p, b)) : -1;
    highlightDraw =
      boxes && hitIdx >= 0
        ? { pv, pageIndex: pv.pageIndex, mode: 'text', points: [p], startIdx: hitIdx, boxes }
        : { pv, pageIndex: pv.pageIndex, mode: 'ink', points: [p], startIdx: -1, boxes: [] };
    capturePointer(e);
    e.preventDefault();
    return;
  }

  // Callout, Dimension and Calibrate are discrete multi-click tools — clicks
  // are registered on pointerup.
  if (tool === 'callout' || tool === 'dimension' || tool === 'calibrate') {
    e.preventDefault();
    return;
  }

  // Click tools (poly + two-click rect/ellipse) build up vertices across
  // multiple clicks — do NOT reset the in-progress drawing on every
  // pointerdown. The first click initializes the point list; further
  // vertices are added on pointerup.
  if (isClickTool(tool)) {
    if (!draw.pv) {
      draw = { start: p, points: [p], pageIndex: pv.pageIndex, pv };
    }
    e.preventDefault();
    return;
  }

  draw = { start: p, points: [p], pageIndex: pv.pageIndex, pv };
  capturePointer(e);
  e.preventDefault();
}

function capturePointer(e: PointerEvent): void {
  try {
    (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
  } catch {
    /* pointer capture is best-effort */
  }
}

export function handlePointerMove(e: PointerEvent, ws: Workspace): void {
  const pv = ws.getPageViewAt(e.clientX, e.clientY);
  if (pv) ws.updateCursorFromEvent(e, pv);

  if (panning) {
    ws.scrollEl.scrollLeft = panStart.scrollLeft - (e.clientX - panStart.x);
    ws.scrollEl.scrollTop = panStart.scrollTop - (e.clientY - panStart.y);
    return;
  }

  // Move / resize drag on committed markups
  if (edit) {
    const ep = edit.pv.screenToPage(e.clientX, e.clientY);
    const dx = ep.x - edit.start.x;
    const dy = ep.y - edit.start.y;
    // ~3px dead zone so a plain click doesn't register as a move
    if (!edit.moved && Math.hypot(dx, dy) * edit.pv.getScale() < 3) return;
    edit.moved = true;
    if (edit.mode === 'move') {
      // Translate EVERY markup in the drag set (multi-selection moves whole)
      const originals = edit.originals;
      replaceMarkups(
        docMarkups().map((mk) => {
          const orig = originals.get(mk.id);
          return orig ? translateMarkup(orig, dx, dy) : mk;
        }),
      );
    } else {
      const updated =
        edit.handleId === 'rotate'
          ? applyRotate(edit.original, edit.start, ep, e.shiftKey)
          : applyHandleDrag(edit.original, edit.handleId, ep, e.shiftKey);
      updateMarkup(edit.markupId, () => updated);
    }
    return;
  }

  // Rubber-band selection box (dashed) while dragging over empty canvas
  if (marquee) {
    marquee.pv.drawMarquee(marquee.start, marquee.pv.screenToPage(e.clientX, e.clientY));
    return;
  }

  const tool = getState().activeTool;

  // Highlighter: drag draws ink / selects text; hover swaps marker ↔ I-beam
  if (tool === 'highlighter') {
    if (highlightDraw) {
      renderHighlightPreview(highlightDraw.pv.screenToPage(e.clientX, e.clientY));
      return;
    }
    if (pv) {
      const doc = getActiveDoc();
      const cp = pv.screenToPage(e.clientX, e.clientY);
      const boxes = doc ? getTextBoxesSync(doc.id, pv.pageIndex) : null;
      if (!boxes && doc?.pdfDoc) void ensureTextBoxes(doc.id, doc.pdfDoc, pv.pageIndex);
      const overText = !!boxes && boxes.some((b) => pointInTextBox(cp, b));
      ws.contentEl.style.cursor = overText ? 'text' : MARKER_CURSOR;
    }
    return;
  }
  // Pan tool: open hand on hover, closed hand while dragging
  if (tool === 'pan') {
    ws.contentEl.style.cursor = panning ? 'grabbing' : 'grab';
    return;
  }
  // Keep the tool's cursor applied (crosshair for draw tools, arrow for nav)
  const wanted = cursorForTool(tool);
  if (ws.contentEl.style.cursor !== wanted) ws.contentEl.style.cursor = wanted;

  // Callout: live leader/box preview between clicks
  if (tool === 'callout' && calloutDraw) {
    renderCalloutPreview(calloutDraw.pv.screenToPage(e.clientX, e.clientY));
    return;
  }

  // Dimension: live preview (segment, then offset dimension line)
  if (tool === 'dimension' && dimDraw) {
    renderDimPreview(dimDraw.pv.screenToPage(e.clientX, e.clientY), e.shiftKey);
    return;
  }

  // Calibrate: rubber-band line from the first click to the cursor
  if (tool === 'calibrate' && calibDraw) {
    const c = calibDraw.pv.screenToPage(e.clientX, e.clientY);
    const end = e.shiftKey ? orthoSnap(calibDraw.p1, c) : c;
    calibDraw.pv.drawPreview([calibDraw.p1, end], false, previewColor(calibDraw.pv.pageIndex));
    return;
  }

  if (!draw.pv || !draw.start) return;
  const p = draw.pv.screenToPage(e.clientX, e.clientY);

  if (isPolyTool(tool)) {
    // Rubber-band line from the committed vertices to the current cursor.
    // Shift locks polyline segments to horizontal/vertical. Polygon / area
    // show a closed preview when the cursor is over the start vertex,
    // signalling that a click there will self-close the shape.
    const pt = snapPolyPoint(tool, p, e.shiftKey);
    if (isCloseHover(tool, pt)) {
      draw.pv.drawPreview(draw.points, true, previewColor(draw.pv.pageIndex));
    } else {
      draw.pv.drawPreview([...draw.points, pt], false, previewColor(draw.pv.pageIndex));
    }
    return;
  }

  // Two-click (rectangle/ellipse/text) and drag tools both preview from start
  previewRect(draw.pv, draw.start, p, tool, e.shiftKey);
}

/** True when the cursor is over the start vertex of a closeable polygon/area
 *  with enough points to form a shape. */
function isCloseHover(tool: ToolId, p: Point): boolean {
  if (tool !== 'polygon') return false;
  if (!draw.pv || draw.points.length < 3) return false;
  const first = draw.points[0]!;
  return Math.hypot(p.x - first.x, p.y - first.y) * draw.pv.getScale() < 12;
}

/** Draw the callout draft after each click / on cursor move. */
function renderCalloutPreview(cursor: Point): void {
  if (!calloutDraw) return;
  const { pv, anchor, kink } = calloutDraw;
  const color = previewColor(pv.pageIndex);
  if (!kink) {
    // Stage 1: anchor placed, dragging toward the elbow
    pv.drawCalloutGuide([anchor, cursor], null, color, anchor);
    return;
  }
  // Stage 2: elbow placed, dragging toward the text box (top-left at cursor)
  const box = { x: cursor.x, y: cursor.y - CALLOUT_H, w: CALLOUT_W, h: CALLOUT_H };
  const leader = calloutLeader(box.x, box.y, box.w, box.h, anchor.x, anchor.y, kink.x, kink.y);
  pv.drawCalloutGuide([anchor, kink, leader.exit], box, color, anchor);
}

export function handlePointerUp(e: PointerEvent, ws: Workspace): void {
  if (panning) {
    panning = false;
    // Back to the open hand if we're still on the Pan tool, else clear it
    ws.contentEl.style.cursor = cursorForTool(getState().activeTool);
    if (e.button === 1) {
      const now = Date.now();
      if (now - lastClick < 300) ws.fit100();
      lastClick = now;
    }
    return;
  }

  // Finish a move/resize drag: record one undo step for the whole gesture
  if (edit) {
    setGrabbing(false);
    if (edit.moved) {
      recordMarkupChange(
        edit.mode === 'move' ? 'Move markup' : 'Resize markup',
        edit.before,
        [...docMarkups()],
      );
      ws.redrawAllMarkups();
    }
    edit = null;
    return;
  }

  // Finish a rubber-band selection: everything the box touches gets selected
  if (marquee) {
    const mq = marquee;
    marquee = null;
    const p2 = mq.pv.screenToPage(e.clientX, e.clientY);
    mq.pv.clearSvg();
    const x0 = Math.min(mq.start.x, p2.x);
    const x1 = Math.max(mq.start.x, p2.x);
    const y0 = Math.min(mq.start.y, p2.y);
    const y1 = Math.max(mq.start.y, p2.y);
    const dragPx = Math.max(x1 - x0, y1 - y0) * mq.pv.getScale();
    if (dragPx > 4) {
      const d = getActiveDoc();
      if (d) {
        const hits = d.markups
          .filter((m) => m.pageIndex === mq.pageIndex && !m.locked)
          .filter((m) => {
            const b = getMarkupBounds(m);
            return b.x <= x1 && b.x + b.w >= x0 && b.y <= y1 && b.y + b.h >= y0;
          })
          .map((m) => m.id);
        selectMarkups(mq.additive ? [...new Set([...mq.base, ...hits])] : hits);
      }
    }
    ws.redrawAllMarkups();
    return;
  }

  const doc = getActiveDoc();
  if (!doc) return;
  const tool = getState().activeTool;

  // Callout: discrete clicks (anchor → kink → text)
  if (tool === 'callout') {
    const pv = ws.getPageViewAt(e.clientX, e.clientY) ?? calloutDraw?.pv ?? null;
    if (pv) handleCalloutClick(pv, pv.screenToPage(e.clientX, e.clientY));
    return;
  }

  // Dimension: discrete clicks (start → end → pull offset)
  if (tool === 'dimension') {
    const pv = ws.getPageViewAt(e.clientX, e.clientY) ?? dimDraw?.pv ?? null;
    if (pv) handleDimClick(pv, pv.screenToPage(e.clientX, e.clientY), e, ws);
    return;
  }

  // Calibrate: two clicks define the measured span, then prompt for its length
  if (tool === 'calibrate') {
    const pv = ws.getPageViewAt(e.clientX, e.clientY) ?? calibDraw?.pv ?? null;
    if (pv) handleCalibrateClick(pv, pv.screenToPage(e.clientX, e.clientY), e);
    return;
  }

  // Highlighter: commit the ink swipe or the text selection
  if (tool === 'highlighter') {
    if (!highlightDraw) return;
    const hd = highlightDraw;
    highlightDraw = null;
    const cp = hd.pv.screenToPage(e.clientX, e.clientY);
    if (hd.mode === 'ink') {
      const pts = hd.points.slice();
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(cp.x - last.x, cp.y - last.y) > 0.1) pts.push(cp);
      commitInk(hd.pageIndex, pts);
    } else {
      const idx = nearestBoxIndex(hd.boxes, cp, hd.startIdx);
      commitTextHighlight(hd.pageIndex, selectionToRects(hd.boxes, hd.startIdx, idx));
    }
    hd.pv.clearSvg();
    ws.contentEl.style.cursor = '';
    returnToNavTool();
    ws.redrawAllMarkups();
    return;
  }

  if (!draw.pv || !draw.start) return;
  const p = draw.pv.screenToPage(e.clientX, e.clientY);

  // Two-click tools (rectangle / ellipse / text): place opposite corners
  if (isTwoClickTool(tool)) {
    const last = draw.points[draw.points.length - 1]!;
    if (Math.hypot(p.x - last.x, p.y - last.y) > 0.5) draw.points.push(p);
    if (draw.points.length >= 2) {
      const prevPv = draw.pv;
      const a = draw.points[0]!;
      const b = draw.points[1]!;
      const pageIndex = draw.pageIndex;
      draw = { start: null, points: [], pageIndex: 0, pv: null };
      prevPv?.clearSvg();
      if (tool === 'text') {
        // Two clicks size the box; type the text inside it in place
        const r = normalizeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        if (prevPv && r.width > 2 && r.height > 2) openTextBoxEditor(prevPv, pageIndex, r);
        else returnToNavTool();
      } else {
        commitTwoClick(tool, a, b, e, pageIndex);
        ws.redrawAllMarkups();
      }
    }
    return;
  }

  if (isPolyTool(tool)) {
    const finish = () => {
      const prevPv = draw.pv;
      commitPolyTool(tool, draw.points, e.shiftKey);
      draw = { start: null, points: [], pageIndex: 0, pv: null };
      lastPolyClick = { time: 0, x: 0, y: 0 };
      prevPv?.clearSvg();
      ws.redrawAllMarkups();
    };
    // Double-click ends the shape
    if (isDoubleClick(e)) {
      finish();
      return;
    }
    // Clicking the start vertex self-closes polygon / area
    if (isCloseHover(tool, p)) {
      finish();
      return;
    }
    // Otherwise: add a vertex (Shift locks polyline segments to ortho; skip
    // exact duplicates, e.g. the initial pointerdown repeated by first pointerup)
    const pt = snapPolyPoint(tool, p, e.shiftKey);
    const last = draw.points[draw.points.length - 1]!;
    if (Math.hypot(pt.x - last.x, pt.y - last.y) > 0.5) draw.points.push(pt);
    recordClick(e);
    // Angle measurement completes automatically at 3 points
    if (tool === 'measureAngle' && draw.points.length >= 3) finish();
    return;
  }

  const prevPv = draw.pv;
  commitDragTool(tool, draw.start, p, e, ws);
  draw = { start: null, points: [], pageIndex: 0, pv: null };
  prevPv?.clearSvg();
  ws.redrawAllMarkups();
}

// ── Highlighter (free-hand ink + text selection) ─────────────────────────────

/** Point-in-text-box test with a small pad so hovering/clicking near a glyph
 *  still counts as "over text". */
function pointInTextBox(p: Point, b: TextBox, pad = 1.5): boolean {
  return p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
}

/** Index of the text box under `p`, else the nearest by centre distance. */
function nearestBoxIndex(boxes: TextBox[], p: Point, fallback: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!;
    if (pointInTextBox(p, b)) return i;
    const d = Math.hypot(p.x - (b.x + b.w / 2), p.y - (b.y + b.h / 2));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best >= 0 ? best : fallback;
}

/** Merge the selected glyph boxes (reading-order range) into one rect per text
 *  line — the marker highlight. */
function selectionToRects(boxes: TextBox[], i0: number, i1: number): TextBox[] {
  const lo = Math.min(i0, i1);
  const hi = Math.max(i0, i1);
  const lines = new Map<number, TextBox[]>();
  for (let i = lo; i <= hi; i++) {
    const b = boxes[i];
    if (!b) continue;
    const lineKey = Math.round(b.y / 2) * 2; // 2pt buckets group a line
    const arr = lines.get(lineKey) ?? lines.set(lineKey, []).get(lineKey)!;
    arr.push(b);
  }
  const rects: TextBox[] = [];
  for (const arr of lines.values()) {
    const left = Math.min(...arr.map((b) => b.x));
    const right = Math.max(...arr.map((b) => b.x + b.w));
    const bottom = Math.min(...arr.map((b) => b.y));
    const top = Math.max(...arr.map((b) => b.y + b.h));
    rects.push({ x: left, y: bottom, w: right - left, h: top - bottom });
  }
  return rects;
}

function renderHighlightPreview(cursor: Point): void {
  if (!highlightDraw) return;
  const { pv, mode } = highlightDraw;
  if (mode === 'ink') {
    highlightDraw.points.push(cursor);
    drawInkPreview(pv, highlightDraw.points);
  } else {
    const idx = nearestBoxIndex(highlightDraw.boxes, cursor, highlightDraw.startIdx);
    drawHighlightRects(pv, selectionToRects(highlightDraw.boxes, highlightDraw.startIdx, idx));
  }
}

function drawInkPreview(pv: PageView, pts: Point[]): void {
  pv.clearSvg();
  if (!pts.length) return;
  const ns = 'http://www.w3.org/2000/svg';
  const scale = pv.getScale();
  const ph = pv.getPageHeight();
  const poly = document.createElementNS(ns, 'polyline');
  poly.setAttribute('points', pts.map((p) => `${p.x * scale},${(ph - p.y) * scale}`).join(' '));
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', HL_COLOR);
  poly.setAttribute('stroke-width', String(HL_PEN_WIDTH * scale));
  poly.setAttribute('stroke-linecap', 'round');
  poly.setAttribute('stroke-linejoin', 'round');
  poly.setAttribute('stroke-opacity', '0.35');
  pv.svgLayer.appendChild(poly);
}

function drawHighlightRects(pv: PageView, rects: TextBox[]): void {
  pv.clearSvg();
  const ns = 'http://www.w3.org/2000/svg';
  const scale = pv.getScale();
  const ph = pv.getPageHeight();
  for (const r of rects) {
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', String(r.x * scale));
    rect.setAttribute('y', String((ph - r.y - r.h) * scale));
    rect.setAttribute('width', String(r.w * scale));
    rect.setAttribute('height', String(r.h * scale));
    rect.setAttribute('fill', HL_COLOR);
    rect.setAttribute('fill-opacity', '0.35');
    pv.svgLayer.appendChild(rect);
  }
}

function commitInk(pageIndex: number, pts: Point[]): void {
  // Simplify: drop points closer than ~1pt
  const simplified = pts.filter(
    (p, i) => i === 0 || Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y) > 1,
  );
  // Require a real swipe (ignore an accidental click) unless it's a clear dab
  const len = simplified.reduce(
    (a, p, i) => (i === 0 ? 0 : a + Math.hypot(p.x - simplified[i - 1]!.x, p.y - simplified[i - 1]!.y)),
    0,
  );
  if (len < 3) return; // accidental click, not a swipe
  const markup: InkMarkup = {
    id: uid(),
    type: 'inkHighlight',
    pageIndex,
    points: simplified.map((p) => ({ ...p })),
    penWidth: HL_PEN_WIDTH,
    overrides: { strokeColor: HL_COLOR, opacity: 0.35 },
  };
  applyMarkupChange('Highlight', [...docMarkups(), markup]);
}

function commitTextHighlight(pageIndex: number, rects: TextBox[]): void {
  if (!rects.length) return;
  const markups: Markup[] = rects.map((r) => ({
    id: uid(),
    type: 'highlighter' as const,
    pageIndex,
    x: r.x,
    y: r.y,
    width: r.w,
    height: r.h,
    overrides: { fillColor: HL_COLOR, opacity: 0.35 },
  }));
  applyMarkupChange('Highlight text', [...docMarkups(), ...markups]);
}

/** Wheel-flip accumulator: trackpads emit dozens of small deltas per swipe —
 *  gather them and turn ONE gesture into ONE page, like presentation slides. */
let _flipAccum = 0;
let _lastFlip = 0;
const FLIP_DELTA = 60;
const FLIP_COOLDOWN_MS = 220;

export function handleWheel(e: WheelEvent, ws: Workspace): void {
  const tool = getState().activeTool;
  const doc = getActiveDoc();
  if (!doc) return;

  // Ctrl / ⌘ / Shift + wheel zooms at the cursor on EVERY tool (Ctrl+wheel is
  // also what trackpad pinch gestures send), as does the Zoom tool itself.
  if (tool === 'zoom' || e.ctrlKey || e.metaKey || e.shiftKey) {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const rect = ws.scrollEl.getBoundingClientRect();
    const cx = e.clientX - rect.left + ws.scrollEl.scrollLeft;
    const cy = e.clientY - rect.top + ws.scrollEl.scrollTop;
    // Zoom the viewer that was scrolled — the split pane has its own zoom
    ws.setZoom(ws.getZoom() * factor, cx, cy);
    return;
  }

  if (tool === 'flip') {
    // Flip is discrete: swallow the scroll entirely so the sheet never drifts,
    // and step exactly one page per gesture.
    e.preventDefault();
    const now = performance.now();
    if (now - _lastFlip < FLIP_COOLDOWN_MS) return;
    _flipAccum += e.deltaY;
    if (Math.abs(_flipAccum) < FLIP_DELTA) return;
    const dir = _flipAccum > 0 ? 1 : -1;
    _flipAccum = 0;
    _lastFlip = now;
    ws.goToPage(Math.max(0, Math.min(doc.pageCount - 1, doc.currentPage + dir)));
  }
}

/** Right-click a markup → a draw-order context menu (front/back, delete). */
export function handleContextMenu(e: MouseEvent, ws: Workspace): void {
  const doc = getActiveDoc();
  const pv = ws.getPageViewAt(e.clientX, e.clientY);
  if (!doc || !pv) return;
  const p = pv.screenToPage(e.clientX, e.clientY);
  const hit = findMarkupAtPoint(doc.markups, pv.pageIndex, p);
  let selected = getState().selectedMarkupIds;

  // Right-clicking an unselected markup selects it; right-clicking a member
  // of the current selection (or empty canvas) keeps the selection intact.
  if (hit && !selected.includes(hit.id)) {
    selectMarkups([hit.id]);
    selected = [hit.id];
    ws.redrawAllMarkups();
  }
  const hasClipboard = (doc.clipboard?.length ?? 0) > 0;
  if (!hit && selected.length === 0 && !hasClipboard) return; // native menu

  e.preventDefault();
  document.querySelector('.context-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  const apply = (next: Markup[], label: string): void => {
    applyMarkupChange(label, next);
    ws.redrawAllMarkups();
  };
  const editThen = (action: string): (() => void) => () => {
    handleEditAction(action);
    ws.redrawAllMarkups();
  };
  const actions: ([string, () => void] | 'sep')[] = [];
  // Draw-order ops apply to a single markup
  if (hit && selected.length === 1) {
    actions.push(
      ['Bring to Front', () => apply(moveToFront(docMarkups(), hit.id), 'Bring to front')],
      ['Bring Forward', () => apply(nudgeOrder(docMarkups(), hit.id, 1), 'Bring forward')],
      ['Send Backward', () => apply(nudgeOrder(docMarkups(), hit.id, -1), 'Send backward')],
      ['Send to Back', () => apply(moveToBack(docMarkups(), hit.id), 'Send to back')],
      'sep',
    );
  }
  if (selected.length) {
    actions.push(['Cut', editThen('cut')], ['Copy', editThen('copy')]);
  }
  if (hasClipboard) {
    actions.push(['Paste', editThen('paste')]);
  }
  if (selected.length) {
    actions.push('sep', [`Delete${selected.length > 1 ? ` (${selected.length})` : ''}`, editThen('delete')]);
  }
  const close = (): void => menu.remove();
  for (const a of actions) {
    if (a === 'sep') {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      menu.appendChild(s);
      continue;
    }
    const [label, fn] = a;
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.addEventListener('click', () => { fn(); close(); });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('pointerdown', close, { once: true }), 0);
}

function isPolyTool(tool: ToolId): boolean {
  return ['polygon', 'polyline', 'measureAngle'].includes(tool);
}

/** Rectangle / ellipse / text — placed with two clicks (opposite corners). */
function isTwoClickTool(tool: ToolId): boolean {
  return tool === 'rectangle' || tool === 'ellipse' || tool === 'text';
}

/** Any tool whose geometry accumulates across multiple clicks. */
function isClickTool(tool: ToolId): boolean {
  return isPolyTool(tool) || isTwoClickTool(tool);
}

/** Open line paths where Shift locks each new segment to horizontal/vertical.
 *  (Excludes polygon, whose Shift makes a revision cloud.) */
function isOrthoPoly(tool: ToolId): boolean {
  return tool === 'polyline';
}

/** Snap `p` to a horizontal/vertical from the last placed vertex when Shift is
 *  held on an ortho-poly tool. */
function snapPolyPoint(tool: ToolId, p: Point, shift: boolean): Point {
  if (shift && isOrthoPoly(tool) && draw.points.length > 0) {
    return orthoSnap(draw.points[draw.points.length - 1]!, p);
  }
  return p;
}

/** Stroke color for drag/poly previews — the page default, so previews match
 *  what will actually be committed. */
function previewColor(pageIndex: number): string {
  return getActiveDoc()?.pageDefaults[pageIndex]?.strokeColor ?? '#002060';
}

function previewRect(pv: PageView, a: Point, b: Point, tool: ToolId, shift = false): void {
  // Shift constrains a line / dimension / calibration to horizontal or vertical
  if (shift && (tool === 'line' || tool === 'dimension' || tool === 'calibrate')) b = orthoSnap(a, b);
  pv.clearSvg();
  const ns = 'http://www.w3.org/2000/svg';
  const scale = pv.getScale();
  const ph = pv.getPageHeight();
  const x = Math.min(a.x, b.x) * scale;
  const y = (ph - Math.max(a.y, b.y)) * scale;
  const w = Math.abs(b.x - a.x) * scale;
  const h = Math.abs(b.y - a.y) * scale;
  const color = previewColor(pv.pageIndex);

  if (tool === 'line' || tool === 'dimension' || tool === 'calibrate') {
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', String(a.x * scale));
    line.setAttribute('y1', String((ph - a.y) * scale));
    line.setAttribute('x2', String(b.x * scale));
    line.setAttribute('y2', String((ph - b.y) * scale));
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-linecap', 'butt');
    pv.svgLayer.appendChild(line);
    return;
  }

  // Ellipse preview: show the actual oval while drawing
  if (tool === 'ellipse') {
    const cx = ((a.x + b.x) / 2) * scale;
    const cy = (ph - (a.y + b.y) / 2) * scale;
    const ellipse = document.createElementNS(ns, 'ellipse');
    ellipse.setAttribute('cx', String(cx));
    ellipse.setAttribute('cy', String(cy));
    ellipse.setAttribute('rx', String(w / 2));
    ellipse.setAttribute('ry', String(h / 2));
    ellipse.setAttribute('fill', color);
    ellipse.setAttribute('fill-opacity', '0.15');
    ellipse.setAttribute('stroke', color);
    ellipse.setAttribute('stroke-width', '2');
    pv.svgLayer.appendChild(ellipse);
    return;
  }

  const rect = document.createElementNS(ns, 'rect');
  rect.setAttribute('x', String(x));
  rect.setAttribute('y', String(y));
  rect.setAttribute('width', String(w));
  rect.setAttribute('height', String(h));
  if (tool === 'text') {
    // Text box: dashed outline, no fill
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke-dasharray', '5 3');
  } else {
    rect.setAttribute('fill', color);
    rect.setAttribute('fill-opacity', '0.15');
  }
  rect.setAttribute('stroke', color);
  rect.setAttribute('stroke-width', '2');
  pv.svgLayer.appendChild(rect);
}

function commitDragTool(tool: ToolId, a: Point, b: Point, e: PointerEvent, ws: Workspace): void {
  const pageIndex = draw.pageIndex;
  let markup: Markup | null = null;

  switch (tool) {
    case 'line': {
      // Shift locks the line to horizontal/vertical; Ctrl adds an end arrow
      const end = e.shiftKey ? orthoSnap(a, b) : b;
      markup = {
        id: uid(),
        type: 'line',
        pageIndex,
        x1: a.x,
        y1: a.y,
        x2: end.x,
        y2: end.y,
        arrowEnd: e.ctrlKey ? 'filled' : 'none',
        arrowStart: 'none',
      };
      break;
    }
    case 'snip': {
      void captureSnip(a, b, pageIndex, ws);
      return;
    }
  }

  if (markup) {
    const before = docMarkups();
    applyMarkupChange('Add markup', [...before, markup]);
    returnToNavTool();
  }
}

function commitPolyTool(tool: ToolId, rawPoints: Point[], shiftKey: boolean): void {
  // Drop consecutive duplicate vertices (double-click repeats the last point)
  const points = rawPoints.filter(
    (pt, i) => i === 0 || Math.hypot(pt.x - rawPoints[i - 1]!.x, pt.y - rawPoints[i - 1]!.y) > 0.5,
  );
  if (points.length < 2) return;
  const pageIndex = draw.pageIndex;
  let markup: Markup | null = null;

  switch (tool) {
    case 'polygon':
      markup = {
        id: uid(),
        type: shiftKey ? 'cloud' : 'polygon',
        pageIndex,
        points: points.map((pt) => ({ ...pt })),
      };
      break;
    case 'polyline':
      markup = { id: uid(), type: 'polyline', pageIndex, points: points.map((pt) => ({ ...pt })) };
      break;
    case 'measureAngle':
      if (points.length >= 3) {
        markup = {
          id: uid(),
          type: 'measureAngle',
          pageIndex,
          p1: { ...points[0]! },
          vertex: { ...points[1]! },
          p2: { ...points[2]! },
        };
      }
      break;
  }

  if (markup) {
    applyMarkupChange('Add markup', [...docMarkups(), markup]);
    returnToNavTool();
  }
}

/** Commit a two-click rectangle / ellipse (a, b = opposite corners).
 *  `pageIndex` must be passed in: `draw` is already reset by the caller. */
function commitTwoClick(tool: ToolId, a: Point, b: Point, e: PointerEvent, pageIndex: number): void {
  let markup: Markup | null = null;
  if (tool === 'rectangle') {
    const r = normalizeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    markup = { id: uid(), type: 'rectangle', pageIndex, ...r };
  } else if (tool === 'ellipse') {
    let rx = Math.abs(b.x - a.x) / 2;
    let ry = Math.abs(b.y - a.y) / 2;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    if (e.ctrlKey) {
      const r = Math.max(rx, ry);
      rx = ry = r; // Ctrl = perfect circle
    }
    if (rx < 0.5 || ry < 0.5) return;
    markup = { id: uid(), type: 'ellipse', pageIndex, cx, cy, rx, ry };
  }
  if (markup) {
    applyMarkupChange('Add markup', [...docMarkups(), markup]);
    returnToNavTool();
  }
}

// ── Callout (3-click: anchor → kink → text, typed in place) ──────────────────

function handleCalloutClick(pv: PageView, p: Point): void {
  const color = previewColor(pv.pageIndex);
  if (!calloutDraw) {
    // Click 1: arrow anchor
    calloutDraw = { pv, pageIndex: pv.pageIndex, anchor: { ...p }, kink: null };
    pv.drawCalloutGuide([], null, color, calloutDraw.anchor);
    return;
  }
  if (!calloutDraw.kink) {
    // Click 2: leader elbow
    calloutDraw.kink = { ...p };
    pv.drawCalloutGuide([calloutDraw.anchor, calloutDraw.kink], null, color, calloutDraw.anchor);
    return;
  }
  // Click 3: top-left of the text box — open the in-place editor
  const { anchor, kink, pageIndex } = calloutDraw;
  calloutDraw = null;
  startCalloutTextEntry(pv, pageIndex, anchor, kink, { ...p });
}

/** Show the callout box + leader and let the user type directly in the box. */
function startCalloutTextEntry(
  pv: PageView,
  pageIndex: number,
  anchor: Point,
  kink: Point,
  topLeft: Point,
): void {
  const scale = pv.getScale();
  const ph = pv.getPageHeight();
  const color = previewColor(pageIndex);
  const box = { x: topLeft.x, y: topLeft.y - CALLOUT_H, w: CALLOUT_W, h: CALLOUT_H };
  const leader = calloutLeader(box.x, box.y, box.w, box.h, anchor.x, anchor.y, kink.x, kink.y);
  pv.drawCalloutGuide([anchor, kink, leader.exit], box, color, anchor);

  spawnTextEditor({
    pv,
    leftPx: box.x * scale,
    topPx: (ph - box.y - box.h) * scale,
    widthPx: box.w * scale,
    heightPx: box.h * scale,
    initial: '',
    font: editorFont(pageIndex),
    transparent: true, // type "in the box": no separate popup styling
    onCommit: (text, wPx, hPx) => {
      pv.clearSvg();
      const w = wPx / scale;
      const h = hPx / scale;
      const markup: CalloutMarkup = {
        id: uid(),
        type: 'callout',
        pageIndex,
        textX: topLeft.x,
        textY: topLeft.y - h,
        textWidth: w,
        textHeight: h,
        anchorX: anchor.x,
        anchorY: anchor.y,
        kinkX: kink.x,
        kinkY: kink.y,
        content: text,
        arrowEnd: 'filled',
      };
      applyMarkupChange('Add callout', [...docMarkups(), markup]);
      returnToNavTool();
    },
    onCancel: () => {
      pv.clearSvg();
      returnToNavTool();
    },
  });
}

// ── Dimension (3-click: start → end → pull the dimension line) ───────────────

/** Signed perpendicular distance of `p` from the P1→P2 line (page units). */
function perpOffset(p1: Point, p2: Point, p: Point): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L;
  const ny = dx / L;
  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;
  return (p.x - midX) * nx + (p.y - midY) * ny;
}

function handleDimClick(pv: PageView, p: Point, e: PointerEvent, ws: Workspace): void {
  const color = previewColor(pv.pageIndex);
  if (!dimDraw) {
    // Click 1: first measured point
    dimDraw = { pv, pageIndex: pv.pageIndex, p1: { ...p }, p2: null };
    pv.drawPreview([dimDraw.p1, dimDraw.p1], false, color);
    return;
  }
  if (!dimDraw.p2) {
    // Click 2: second measured point (the length)
    dimDraw.p2 = e.shiftKey ? orthoSnap(dimDraw.p1, p) : { ...p };
    pv.drawPreview([dimDraw.p1, dimDraw.p2], false, color);
    return;
  }
  // Click 3: pull the dimension line to a custom offset
  const { p1, p2, pageIndex } = dimDraw;
  const offset = perpOffset(p1, p2, p);
  dimDraw = null;
  pv.clearSvg();
  const markup: Markup = {
    id: uid(),
    type: 'dimension',
    pageIndex,
    x1: p1.x,
    y1: p1.y,
    x2: p2.x,
    y2: p2.y,
    offset,
  };
  applyMarkupChange('Add markup', [...docMarkups(), markup]);
  returnToNavTool();
  ws.redrawAllMarkups();
}

function renderDimPreview(cursor: Point, shift: boolean): void {
  if (!dimDraw) return;
  const { pv, p1, p2 } = dimDraw;
  const color = previewColor(pv.pageIndex);
  if (!p2) {
    const end = shift ? orthoSnap(p1, cursor) : cursor;
    pv.drawPreview([p1, end], false, color);
    return;
  }
  // Offset preview: a polyline p1 → d1 → d2 → p2 traces the extension lines
  // and the pulled dimension line in one stroke.
  const offset = perpOffset(p1, p2, cursor);
  const g = dimensionGeometry(p1.x, p1.y, p2.x, p2.y, offset);
  pv.drawPreview([p1, g.d1, g.d2, p2], false, color);
}

/** Calibrate: click two points across a known distance, then type the
 *  real-world length; this sets the page scale factor. */
function handleCalibrateClick(pv: PageView, p: Point, e: PointerEvent): void {
  const color = previewColor(pv.pageIndex);
  if (!calibDraw) {
    // Click 1: first endpoint
    calibDraw = { pv, pageIndex: pv.pageIndex, p1: { ...p }, p2: null };
    pv.drawPreview([calibDraw.p1, calibDraw.p1], false, color);
    return;
  }
  // Click 2: second endpoint → prompt for the real length and set the scale
  const p1 = calibDraw.p1;
  const p2 = e.shiftKey ? orthoSnap(p1, p) : { ...p };
  const pageIndex = calibDraw.pageIndex;
  pv.drawPreview([p1, p2], false, color);
  const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (len < 1) {
    // Too short to be meaningful — restart from this click
    calibDraw = { pv, pageIndex, p1: { ...p }, p2: null };
    return;
  }
  const real = prompt('Calibrate scale — enter the real-world length of the drawn line\n(e.g. 10\'-0", 10\', or 120 for inches)');
  calibDraw = null;
  pv.clearSvg();
  if (real) {
    const inches = parseRealLength(real);
    if (inches && inches > 0) {
      updateActiveDoc((d) => {
        const defaults = [...d.pageDefaults];
        defaults[pageIndex] = {
          ...defaults[pageIndex]!,
          scaleLabel: 'Custom',
          scaleFactor: inches / (len / 72),
        };
        return { ...d, pageDefaults: defaults, dirty: true };
      });
    }
  }
  returnToNavTool();
}

// ── Text box (2-click box + in-place typing, like the callout) ───────────────

function openTextBoxEditor(
  pv: PageView,
  pageIndex: number,
  rect: { x: number; y: number; width: number; height: number },
): void {
  const scale = pv.getScale();
  const ph = pv.getPageHeight();
  const color = previewColor(pageIndex);
  const top = rect.y + rect.height; // page-y of the box top edge
  const font = editorFont(pageIndex);
  // Show the box outline while typing
  pv.drawCalloutGuide([], { x: rect.x, y: rect.y, w: rect.width, h: rect.height }, color, null);
  spawnTextEditor({
    pv,
    leftPx: rect.x * scale,
    topPx: (ph - top) * scale,
    widthPx: rect.width * scale,
    heightPx: rect.height * scale,
    initial: '',
    font,
    transparent: true,
    formatting: initialFormatting(undefined, font.spacing),
    onCommit: (text, wPx, hPx, fmt) => {
      pv.clearSvg();
      const f = fmt ?? initialFormatting(undefined, font.spacing);
      const w = wPx / scale;
      // Grow the box to fit the wrapped text (the canvas clips to the box)
      const contentH = measureTextBlockHeight(text, w - 6, font.size, font.family, f.lineSpacing, f.bold, f.indent);
      const h = Math.max(hPx / scale, contentH + 8);
      const markup: TextMarkup = {
        id: uid(),
        type: 'text',
        pageIndex,
        x: rect.x,
        y: top - h, // keep the box top anchored if the editor was resized
        width: w,
        height: h,
        content: text,
        overrides: fmtToOverrides(f),
      };
      applyMarkupChange('Add text', [...docMarkups(), markup]);
      returnToNavTool();
    },
    onCancel: () => {
      pv.clearSvg();
      returnToNavTool();
    },
  });
}

async function captureSnip(a: Point, b: Point, pageIndex: number, _ws: Workspace): Promise<void> {
  const pv = draw.pv;
  if (!pv) return;
  const r = normalizeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  if (r.width < 1 || r.height < 1) {
    returnToNavTool();
    return;
  }
  const scale = pv.getScale();
  const ph = pv.getPageHeight();
  const sx = r.x * scale;
  const sy = (ph - r.y - r.height) * scale;
  const sw = r.width * scale;
  const sh = r.height * scale;
  // PageView composites base + crisp detail + markups for the region
  const tmp = pv.captureRegion(sx, sy, sw, sh);
  const imageData = tmp.toDataURL('image/png');
  const snip: Markup = {
    id: uid(),
    type: 'snipImage',
    pageIndex,
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    imageData,
  };
  // The snip goes to the clipboard only — paste (Ctrl+V) places it with its
  // lower-left corner at the cursor.
  updateActiveDoc((d) => ({ ...d, clipboard: [snip] }));
  returnToNavTool();
  // Best-effort: also put the PNG on the system clipboard
  try {
    const blob = await new Promise<Blob | null>((res) => tmp.toBlob(res, 'image/png'));
    if (blob && navigator.clipboard && 'write' in navigator.clipboard) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    }
  } catch {
    /* clipboard permission denied — in-app paste still works */
  }
}

function docMarkups(): Markup[] {
  return getActiveDoc()?.markups ?? [];
}

function parseRealLength(s: string): number | null {
  const m = s.match(/(\d+)'(?:-(\d+(?:\/\d+)?)")?/);
  if (!m) return Number(s) || null;
  const feet = Number(m[1]) * 12;
  const inches = m[2] ? evalFraction(m[2]) : 0;
  return feet + inches;
}

function evalFraction(s: string): number {
  if (s.includes('/')) {
    const [n, d] = s.split('/');
    return Number(n) / Number(d);
  }
  return Number(s);
}

// ── Geometry editing (select tool) ──────────────────────────────────────────

function orthoSnap(a: Point, b: Point): Point {
  return Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
}

/** Page-coord center of a rotatable shape (rectangle / ellipse). */
function shapeCenter(m: Markup): Point {
  if (m.type === 'ellipse') return { x: m.cx, y: m.cy };
  if (m.type === 'rectangle') return { x: m.x + m.width / 2, y: m.y + m.height / 2 };
  return { x: 0, y: 0 };
}

/** Rotate a page point about `c` by `deg` (screen-clockwise convention). */
function rotatePagePoint(p: Point, c: Point, deg: number): Point {
  const t = (deg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos + dy * sin, y: c.y - dx * sin + dy * cos };
}

/** Rotate handle drag: spin the shape so the grabbed corner follows the cursor. */
function applyRotate(m: Markup, start: Point, cur: Point, shift: boolean): Markup {
  if (m.type !== 'rectangle' && m.type !== 'ellipse') return m;
  const c = shapeCenter(m);
  const a0 = Math.atan2(start.y - c.y, start.x - c.x);
  const a1 = Math.atan2(cur.y - c.y, cur.x - c.x);
  const deltaDeg = ((a1 - a0) * 180) / Math.PI; // page-CCW change
  let rot = (m.rotation ?? 0) - deltaDeg; // stored rotation is screen-clockwise
  if (shift) rot = Math.round(rot / 15) * 15; // Shift snaps to 15°
  rot = ((rot % 360) + 360) % 360;
  return { ...m, rotation: rot };
}

function translateMarkup(m: Markup, dx: number, dy: number): Markup {
  switch (m.type) {
    case 'rectangle':
    case 'highlighter':
    case 'snipImage':
    case 'text':
    case 'sticky':
      return { ...m, x: m.x + dx, y: m.y + dy };
    case 'ellipse':
      return { ...m, cx: m.cx + dx, cy: m.cy + dy };
    case 'line':
    case 'dimension':
      return { ...m, x1: m.x1 + dx, y1: m.y1 + dy, x2: m.x2 + dx, y2: m.y2 + dy };
    case 'polygon':
    case 'cloud':
    case 'polyline':
    case 'inkHighlight':
      return { ...m, points: m.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })) };
    case 'callout':
      return {
        ...m,
        textX: m.textX + dx,
        textY: m.textY + dy,
        anchorX: m.anchorX + dx,
        anchorY: m.anchorY + dy,
        kinkX: m.kinkX !== undefined ? m.kinkX + dx : undefined,
        kinkY: m.kinkY !== undefined ? m.kinkY + dy : undefined,
      };
    case 'measureAngle':
      return {
        ...m,
        p1: { x: m.p1.x + dx, y: m.p1.y + dy },
        vertex: { x: m.vertex.x + dx, y: m.vertex.y + dy },
        p2: { x: m.p2.x + dx, y: m.p2.y + dy },
      };
  }
}

function resizeRectByHandle(
  r: { x: number; y: number; width: number; height: number },
  handle: string,
  p: Point,
): { x: number; y: number; width: number; height: number } {
  let x1 = r.x;
  let y1 = r.y;
  let x2 = r.x + r.width;
  let y2 = r.y + r.height;
  switch (handle) {
    case 'nw': x1 = p.x; y2 = p.y; break;
    case 'ne': x2 = p.x; y2 = p.y; break;
    case 'se': x2 = p.x; y1 = p.y; break;
    case 'sw': x1 = p.x; y1 = p.y; break;
    case 'n': y2 = p.y; break;
    case 's': y1 = p.y; break;
    case 'e': x2 = p.x; break;
    case 'w': x1 = p.x; break;
  }
  return normalizeRect(x1, y1, x2 - x1, y2 - y1);
}

function applyHandleDrag(m: Markup, handle: string, p: Point, shift: boolean): Markup {
  switch (m.type) {
    case 'rectangle': {
      // For a rotated rect, resize in its local (unrotated) frame
      const rot = m.rotation ?? 0;
      const lp = rot ? rotatePagePoint(p, shapeCenter(m), -rot) : p;
      return { ...m, ...resizeRectByHandle(m, handle, lp) };
    }
    case 'highlighter':
    case 'snipImage':
    case 'text':
      return { ...m, ...resizeRectByHandle(m, handle, p) };
    case 'ellipse': {
      // Resize the bounding box (corner = both axes, edge = one axis), then
      // derive the new centre + radii. For a rotated ellipse, resize in its
      // local frame so the handles track the cursor.
      const rot = m.rotation ?? 0;
      const lp = rot ? rotatePagePoint(p, shapeCenter(m), -rot) : p;
      const r = resizeRectByHandle(
        { x: m.cx - m.rx, y: m.cy - m.ry, width: 2 * m.rx, height: 2 * m.ry },
        handle,
        lp,
      );
      return {
        ...m,
        cx: r.x + r.width / 2,
        cy: r.y + r.height / 2,
        rx: Math.max(1, r.width / 2),
        ry: Math.max(1, r.height / 2),
      };
    }
    case 'line':
    case 'dimension': {
      // Mid-span handle: pull the dimension line away from the measured
      // points (perpendicular projection of the cursor)
      if (handle === 'offset' && m.type === 'dimension') {
        const midX = (m.x1 + m.x2) / 2;
        const midY = (m.y1 + m.y2) / 2;
        const dx = m.x2 - m.x1;
        const dy = m.y2 - m.y1;
        const L = Math.hypot(dx, dy) || 1;
        const nx = -dy / L;
        const ny = dx / L;
        return { ...m, offset: (p.x - midX) * nx + (p.y - midY) * ny };
      }
      const other = handle === 'start' ? { x: m.x2, y: m.y2 } : { x: m.x1, y: m.y1 };
      const np = shift ? orthoSnap(other, p) : p;
      return handle === 'start' ? { ...m, x1: np.x, y1: np.y } : { ...m, x2: np.x, y2: np.y };
    }
    case 'polygon':
    case 'cloud':
    case 'polyline': {
      const idx = Number(handle.slice(1));
      if (!Number.isInteger(idx) || idx < 0 || idx >= m.points.length) return m;
      return { ...m, points: m.points.map((pt, i) => (i === idx ? { x: p.x, y: p.y } : pt)) };
    }
    case 'callout': {
      if (handle === 'anchor') return { ...m, anchorX: p.x, anchorY: p.y };
      // Elbow handle: slides horizontally only — it just sets the length of the
      // horizontal run out of the box (the box→elbow segment stays horizontal)
      if (handle === 'kink') return { ...m, kinkX: p.x };
      const r = resizeRectByHandle(
        { x: m.textX, y: m.textY, width: m.textWidth, height: m.textHeight },
        handle,
        p,
      );
      return { ...m, textX: r.x, textY: r.y, textWidth: r.width, textHeight: r.height };
    }
    case 'measureAngle': {
      if (handle === 'p1') return { ...m, p1: { ...p } };
      if (handle === 'vertex') return { ...m, vertex: { ...p } };
      if (handle === 'p2') return { ...m, p2: { ...p } };
      return m;
    }
    case 'sticky':
    case 'inkHighlight':
      // No resize handles (free-hand stroke) — only move via translateMarkup
      return m;
  }
}

// ── Inline text editing (text / callout / sticky) ───────────────────────────

/** Font settings for the inline editor, resolved overrides → page defaults. */
function editorFont(
  pageIndex: number,
  existing?: { overrides?: { fontSize?: number; fontFamily?: string; lineSpacing?: number } },
): { size: number; family: string; spacing: number } {
  const defs = getActiveDoc()?.pageDefaults[pageIndex];
  return {
    size: existing?.overrides?.fontSize ?? defs?.fontSize ?? 12,
    family: existing?.overrides?.fontFamily ?? defs?.fontFamily ?? 'Arial',
    spacing: existing?.overrides?.lineSpacing ?? 1.35,
  };
}

/** Block formatting collected by the inline-editor toolbar (text/callout). */
export interface EditorFormatting {
  bold: boolean;
  underline: boolean;
  /** Block left indent, in steps of 12pt. */
  indent: number;
  lineSpacing: number;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
}

const ALIGN_ICONS: Record<'left' | 'center' | 'right', string> = {
  left: `<svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="1.5" y1="2.5" x2="10.5" y2="2.5"/><line x1="1.5" y1="6" x2="7" y2="6"/><line x1="1.5" y1="9.5" x2="9" y2="9.5"/></svg>`,
  center: `<svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="1.5" y1="2.5" x2="10.5" y2="2.5"/><line x1="3.5" y1="6" x2="8.5" y2="6"/><line x1="2.5" y1="9.5" x2="9.5" y2="9.5"/></svg>`,
  right: `<svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="1.5" y1="2.5" x2="10.5" y2="2.5"/><line x1="5" y1="6" x2="10.5" y2="6"/><line x1="3" y1="9.5" x2="10.5" y2="9.5"/></svg>`,
};

const VALIGN_ICONS: Record<'top' | 'middle' | 'bottom', string> = {
  top: `<svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="1.5" y1="1.5" x2="10.5" y2="1.5"/><path d="M6 10.5V4.5M6 4.5l-2 2M6 4.5l2 2"/></svg>`,
  middle: `<svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="1.5" y1="6" x2="10.5" y2="6"/><path d="M6 1.5v2.2M6 10.5V8.3"/></svg>`,
  bottom: `<svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="1.5" y1="10.5" x2="10.5" y2="10.5"/><path d="M6 1.5v6M6 7.5l-2-2M6 7.5l2-2"/></svg>`,
};

function spawnTextEditor(opts: {
  pv: PageView;
  leftPx: number;
  topPx: number;
  widthPx?: number;
  heightPx?: number;
  initial: string;
  font?: { size: number; family: string; spacing: number };
  /** Blend into the markup graphic beneath (callout box) instead of a popup. */
  transparent?: boolean;
  /** When set, a formatting toolbar (B/U, indent, spacing, align) shows. */
  formatting?: EditorFormatting;
  onCommit: (text: string, wPx: number, hPx: number, fmt?: EditorFormatting) => void;
  onCancel?: () => void;
}): void {
  const ta = document.createElement('textarea');
  ta.className = opts.transparent ? 'inline-text-editor inline-text-editor--bare' : 'inline-text-editor';
  ta.value = opts.initial;
  ta.style.left = `${opts.leftPx}px`;
  ta.style.top = `${opts.topPx}px`;
  ta.style.width = `${Math.max(120, opts.widthPx ?? 200)}px`;
  ta.style.height = `${Math.max(32, opts.heightPx ?? 48)}px`;
  if (opts.font) {
    ta.style.fontSize = `${opts.font.size * opts.pv.getScale()}px`;
    ta.style.fontFamily = `"${opts.font.family}", sans-serif`;
    ta.style.lineHeight = String(opts.font.spacing);
  }
  // Keep canvas tool handlers and global shortcuts away from the editor
  for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'dblclick', 'wheel', 'contextmenu']) {
    ta.addEventListener(ev, (evt) => evt.stopPropagation());
  }

  // ── Formatting toolbar (text / callout) ─────────────────────────────────
  const fmt = opts.formatting ? { ...opts.formatting } : null;
  let bar: HTMLElement | null = null;
  const applyFmtPreview = (): void => {
    if (!fmt) return;
    ta.style.fontWeight = fmt.bold ? '700' : '400';
    ta.style.textDecoration = fmt.underline ? 'underline' : 'none';
    ta.style.textAlign = fmt.align;
    ta.style.lineHeight = String(fmt.lineSpacing);
    ta.style.paddingLeft = `${5 + fmt.indent * 12 * opts.pv.getScale()}px`;
  };
  if (fmt) {
    bar = document.createElement('div');
    bar.className = 'text-format-bar';
    for (const ev of ['pointermove', 'pointerup', 'dblclick', 'wheel', 'contextmenu']) {
      bar.addEventListener(ev, (evt) => evt.stopPropagation());
    }
    // Buttons must not steal focus from the textarea (blur = commit)
    bar.addEventListener('pointerdown', (evt) => {
      evt.stopPropagation();
      if ((evt.target as HTMLElement).tagName !== 'SELECT') evt.preventDefault();
    });

    const actives: (() => void)[] = [];
    const addBtn = (html: string, title: string, isOn: () => boolean, onClick: () => void): void => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tfb-btn';
      b.innerHTML = html;
      b.title = title;
      b.addEventListener('click', () => {
        onClick();
        applyFmtPreview();
        actives.forEach((f) => f());
      });
      actives.push(() => b.classList.toggle('on', isOn()));
      bar!.appendChild(b);
    };
    const addSep = (): void => {
      const s = document.createElement('span');
      s.className = 'tfb-sep';
      bar!.appendChild(s);
    };

    addBtn('<b>B</b>', 'Bold', () => fmt.bold, () => (fmt.bold = !fmt.bold));
    addBtn('<u>U</u>', 'Underline', () => fmt.underline, () => (fmt.underline = !fmt.underline));
    addSep();
    addBtn('⇤', 'Decrease indent', () => false, () => (fmt.indent = Math.max(0, fmt.indent - 1)));
    addBtn('⇥', 'Increase indent', () => fmt.indent > 0, () => (fmt.indent = Math.min(8, fmt.indent + 1)));
    addSep();
    for (const a of ['left', 'center', 'right'] as const) {
      addBtn(ALIGN_ICONS[a], `Align ${a}`, () => fmt.align === a, () => (fmt.align = a));
    }
    addSep();
    for (const v of ['top', 'middle', 'bottom'] as const) {
      addBtn(VALIGN_ICONS[v], `Vertical align ${v}`, () => fmt.valign === v, () => (fmt.valign = v));
    }
    addSep();
    const spacing = document.createElement('select');
    spacing.className = 'tfb-spacing';
    spacing.title = 'Row spacing';
    spacing.innerHTML = [1, 1.15, 1.35, 1.5, 2]
      .map((s) => `<option value="${s}" ${s === fmt.lineSpacing ? 'selected' : ''}>${s === 1 ? '1.0' : s}×</option>`)
      .join('');
    spacing.addEventListener('change', () => {
      fmt.lineSpacing = Number(spacing.value);
      applyFmtPreview();
      ta.focus(); // the select took focus — hand it back before blur commits
    });
    bar.appendChild(spacing);

    actives.forEach((f) => f());
    applyFmtPreview();
    // Sit just above the editor; flip below when there's no headroom
    bar.style.left = `${opts.leftPx}px`;
    bar.style.top = `${Math.max(2, opts.topPx - 34)}px`;
    opts.pv.el.appendChild(bar);
  }

  let done = false;
  const finish = (commit: boolean): void => {
    if (done) return;
    done = true;
    const text = ta.value.trim();
    const w = ta.offsetWidth;
    const h = ta.offsetHeight;
    ta.remove();
    bar?.remove();
    if (commit && text) opts.onCommit(text, w, h, fmt ?? undefined);
    else opts.onCancel?.();
  };
  ta.addEventListener('keydown', (evt) => {
    evt.stopPropagation();
    if (evt.key === 'Escape') finish(false);
    if (evt.key === 'Enter' && (evt.ctrlKey || evt.metaKey)) finish(true);
  });
  // Clicking anywhere outside the editor blurs it → commit + return to
  // select. Focus moving INTO the toolbar (the spacing select) doesn't count.
  ta.addEventListener('blur', (evt) => {
    const to = (evt as FocusEvent).relatedTarget as HTMLElement | null;
    if (to && bar && bar.contains(to)) return;
    finish(true);
  });
  opts.pv.el.appendChild(ta);
  requestAnimationFrame(() => ta.focus());
}

/** Initial toolbar formatting for an editor session, from overrides. */
function initialFormatting(existing: { overrides?: TextMarkup['overrides'] } | undefined, spacing: number): EditorFormatting {
  return {
    bold: existing?.overrides?.bold ?? false,
    underline: existing?.overrides?.underline ?? false,
    indent: existing?.overrides?.indent ?? 0,
    lineSpacing: spacing,
    align: existing?.overrides?.align ?? 'left',
    valign: existing?.overrides?.valign ?? 'top',
  };
}

/** Toolbar formatting → overrides patch. Defaults become `undefined`, which
 *  both clears a previously-set value on merge and drops out of the saved
 *  JSON metadata. */
function fmtToOverrides(f: EditorFormatting): Partial<NonNullable<TextMarkup['overrides']>> {
  return {
    bold: f.bold || undefined,
    underline: f.underline || undefined,
    indent: f.indent > 0 ? f.indent : undefined,
    lineSpacing: f.lineSpacing !== 1.35 ? f.lineSpacing : undefined,
    align: f.align !== 'left' ? f.align : undefined,
    valign: f.valign !== 'top' ? f.valign : undefined,
  };
}

function openTextEditor(pv: PageView, pageIndex: number, at: Point, existing?: TextMarkup): void {
  const scale = pv.getScale();
  const ph = pv.getPageHeight();
  const font = editorFont(pageIndex, existing);
  spawnTextEditor({
    pv,
    leftPx: (existing ? existing.x : at.x) * scale,
    topPx: existing ? (ph - existing.y - existing.height) * scale : (ph - at.y) * scale,
    widthPx: existing ? existing.width * scale : undefined,
    heightPx: existing ? existing.height * scale : undefined,
    initial: existing?.content ?? '',
    font,
    formatting: initialFormatting(existing, font.spacing),
    onCommit: (text, wPx, hPx, fmt) => {
      const f = fmt ?? initialFormatting(existing, font.spacing);
      const w = wPx / scale;
      // Grow the box to fit the wrapped text (the canvas clips to the box, so
      // a too-short box would otherwise swallow the overflow)
      const contentH = measureTextBlockHeight(text, w - 6, font.size, font.family, f.lineSpacing, f.bold, f.indent);
      const h = Math.max(hPx / scale, contentH + 8);
      if (existing) {
        applyMarkupChange(
          'Edit text',
          docMarkups().map((m) =>
            m.id === existing.id
              ? {
                  ...existing,
                  content: text,
                  width: w,
                  height: h,
                  y: existing.y + existing.height - h,
                  overrides: { ...existing.overrides, ...fmtToOverrides(f) },
                }
              : m,
          ),
        );
      } else {
        const markup: TextMarkup = {
          id: uid(),
          type: 'text',
          pageIndex,
          x: at.x,
          y: at.y - h,
          width: w,
          height: h,
          content: text,
          overrides: fmtToOverrides(f),
        };
        applyMarkupChange('Add text', [...docMarkups(), markup]);
        returnToNavTool();
      }
    },
    onCancel: () => {
      if (!existing) returnToNavTool();
    },
  });
}

function openCalloutEditor(
  pv: PageView,
  pageIndex: number,
  anchor: Point,
  textAt: Point,
  existing?: CalloutMarkup,
): void {
  const scale = pv.getScale();
  const ph = pv.getPageHeight();
  // A plain click (no drag): place the text box up and to the right
  if (!existing && Math.hypot(textAt.x - anchor.x, textAt.y - anchor.y) < 4) {
    textAt = { x: anchor.x + 60, y: anchor.y + 60 };
  }
  const ax = existing ? existing.anchorX : anchor.x;
  const ay = existing ? existing.anchorY : anchor.y;
  // Live leader-line preview while typing
  pv.drawPreview(
    [
      { x: ax, y: ay },
      existing ? { x: existing.textX, y: existing.textY + existing.textHeight } : textAt,
    ],
    false,
    previewColor(pageIndex),
  );
  const font = editorFont(pageIndex, existing);
  spawnTextEditor({
    pv,
    leftPx: (existing ? existing.textX : textAt.x) * scale,
    topPx: existing ? (ph - existing.textY - existing.textHeight) * scale : (ph - textAt.y) * scale,
    widthPx: existing ? existing.textWidth * scale : undefined,
    heightPx: existing ? existing.textHeight * scale : undefined,
    initial: existing?.content ?? '',
    font,
    formatting: initialFormatting(existing, font.spacing),
    onCommit: (text, wPx, hPx, fmt) => {
      pv.clearSvg();
      const f = fmt ?? initialFormatting(existing, font.spacing);
      const w = wPx / scale;
      // Grow the box to fit the wrapped text (the canvas clips to the box)
      const contentH = measureTextBlockHeight(text, w - 8, font.size, font.family, f.lineSpacing, f.bold, f.indent);
      const h = Math.max(hPx / scale, contentH + 10);
      if (existing) {
        applyMarkupChange(
          'Edit callout',
          docMarkups().map((m) =>
            m.id === existing.id
              ? {
                  ...existing,
                  content: text,
                  textWidth: w,
                  textHeight: h,
                  textY: existing.textY + existing.textHeight - h,
                  overrides: { ...existing.overrides, ...fmtToOverrides(f) },
                }
              : m,
          ),
        );
      } else {
        const markup: CalloutMarkup = {
          id: uid(),
          type: 'callout',
          pageIndex,
          textX: textAt.x,
          textY: textAt.y - h,
          textWidth: w,
          textHeight: h,
          anchorX: anchor.x,
          anchorY: anchor.y,
          content: text,
          arrowEnd: 'filled',
          overrides: fmtToOverrides(f),
        };
        applyMarkupChange('Add callout', [...docMarkups(), markup]);
        returnToNavTool();
      }
    },
    onCancel: () => {
      pv.clearSvg();
      if (!existing) returnToNavTool();
    },
  });
}

function openStickyEditor(pv: PageView, pageIndex: number, at: Point, existing?: StickyMarkup): void {
  const scale = pv.getScale();
  const ph = pv.getPageHeight();
  const x = existing ? existing.x : at.x;
  const y = existing ? existing.y : at.y;
  spawnTextEditor({
    pv,
    leftPx: x * scale + 24,
    topPx: (ph - y) * scale,
    initial: existing?.content ?? '',
    font: editorFont(pageIndex, existing),
    onCommit: (text) => {
      if (existing) {
        applyMarkupChange(
          'Edit note',
          docMarkups().map((m) => (m.id === existing.id ? { ...existing, content: text } : m)),
        );
      } else {
        const markup: StickyMarkup = { id: uid(), type: 'sticky', pageIndex, x: at.x, y: at.y, content: text };
        applyMarkupChange('Add note', [...docMarkups(), markup]);
        returnToNavTool();
      }
    },
    onCancel: () => {
      if (!existing) returnToNavTool();
    },
  });
}

function openEditorForExisting(pv: PageView, m: Markup): void {
  if (m.type === 'text') openTextEditor(pv, m.pageIndex, { x: m.x, y: m.y }, m);
  else if (m.type === 'callout')
    openCalloutEditor(pv, m.pageIndex, { x: m.anchorX, y: m.anchorY }, { x: m.textX, y: m.textY }, m);
  else if (m.type === 'sticky') openStickyEditor(pv, m.pageIndex, { x: m.x, y: m.y }, m);
}

export function handleEditAction(action: string): void {
  const doc = getActiveDoc();
  if (!doc) return;
  const selected = getState().selectedMarkupIds;

  switch (action) {
    case 'undo':
      import('../state/undo').then(({ undo }) => undo());
      break;
    case 'redo':
      import('../state/undo').then(({ redo }) => redo());
      break;
    case 'delete':
      if (selected.length) {
        applyMarkupChange('Delete', doc.markups.filter((m) => !selected.includes(m.id)));
        selectMarkups([]);
      }
      break;
    case 'cut':
      if (selected.length) {
        const toBeCut = doc.markups.filter((m) => selected.includes(m.id));
        updateActiveDoc((d) => ({
          ...d,
          clipboard: toBeCut.map((m) => cloneMarkup(m, m.id)),
        }));
        applyMarkupChange('Cut', doc.markups.filter((m) => !selected.includes(m.id)));
        selectMarkups([]);
      }
      break;
    case 'copy':
      if (selected.length) {
        updateActiveDoc((d) => ({
          ...d,
          clipboard: d.markups.filter((m) => selected.includes(m.id)).map((m) => cloneMarkup(m, m.id)),
        }));
      }
      break;
    case 'paste':
      pasteMarkups(false);
      break;
    case 'paste-in-place':
      pasteMarkups(true);
      break;
    case 'duplicate':
      if (selected.length) {
        const copies = doc.markups
          .filter((m) => selected.includes(m.id))
          .map((m) => cloneMarkup(m, uid(), doc.currentPage));
        applyMarkupChange('Duplicate', [...doc.markups, ...copies]);
      }
      break;
  }
}

function pasteMarkups(inPlace: boolean): void {
  const doc = getActiveDoc();
  if (!doc?.clipboard?.length) return;
  const targetPage = doc.currentPage;
  const targetSize = doc.pages[targetPage];
  const cursor = getState().cursorPagePoint;
  const copies = doc.clipboard.map((m) => {
    const copy = cloneMarkup(m, uid(), targetPage);
    // Snips paste with their lower-left corner at the cursor position
    if (!inPlace && copy.type === 'snipImage' && cursor) {
      copy.x = cursor.x;
      copy.y = cursor.y;
      return copy;
    }
    if (!inPlace && targetSize) {
      const srcSize = doc.pages[m.pageIndex];
      if (srcSize && (srcSize.width !== targetSize.width || srcSize.height !== targetSize.height)) {
        offsetMarkupToCenter(copy, srcSize!, targetSize);
      }
    }
    return copy;
  });
  applyMarkupChange('Paste', [...doc.markups, ...copies]);
}

function offsetMarkupToCenter(
  m: Markup,
  _src: { width: number; height: number },
  tgt: { width: number; height: number },
): void {
  const dx = (tgt.width - _src.width) / 2;
  const dy = (tgt.height - _src.height) / 2;
  if ('x' in m && typeof m.x === 'number') m.x += dx;
  if ('y' in m && typeof m.y === 'number') m.y += dy;
  if ('cx' in m) {
    m.cx += dx;
    m.cy += dy;
  }
  if ('x1' in m) {
    m.x1 += dx;
    m.y1 += dy;
    m.x2 += dx;
    m.y2 += dy;
  }
  if ('points' in m && m.points) {
    for (const p of m.points) {
      p.x += dx;
      p.y += dy;
    }
  }
}

export function setupKeyboardShortcuts(): void {
  window.addEventListener('keydown', (e) => {
    // Never hijack keys while the user is typing in a field or inline editor
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
      return;
    }

    // Enter finishes an in-progress polyline/polygon/measure path
    if (e.key === 'Enter' && draw.pv && isPolyTool(getState().activeTool)) {
      const prevPv = draw.pv;
      commitPolyTool(getState().activeTool, draw.points, e.shiftKey);
      draw = { start: null, points: [], pageIndex: 0, pv: null };
      prevPv.clearSvg();
      return;
    }
    // Escape cancels an in-progress drawing or move/resize drag
    if (e.key === 'Escape') {
      if (marquee) {
        marquee.pv.clearSvg();
        marquee = null;
        return;
      }
      if (calloutDraw) {
        calloutDraw.pv.clearSvg();
        calloutDraw = null;
        return;
      }
      if (dimDraw) {
        dimDraw.pv.clearSvg();
        dimDraw = null;
        return;
      }
      if (calibDraw) {
        calibDraw.pv.clearSvg();
        calibDraw = null;
        return;
      }
      if (draw.pv) {
        draw.pv.clearSvg();
        draw = { start: null, points: [], pageIndex: 0, pv: null };
        lastPolyClick = { time: 0, x: 0, y: 0 };
        return;
      }
      if (edit) {
        setGrabbing(false);
        replaceMarkups(edit.before);
        edit = null;
        return;
      }
      selectMarkups([]);
      return;
    }

    const mod = e.metaKey || e.ctrlKey;

    // PgUp / PgDn / arrows page through the document like slides (single mode)
    if (!mod) {
      const doc = getActiveDoc();
      if (doc && doc.viewMode === 'single') {
        const step =
          e.key === 'PageDown' || e.key === 'ArrowDown' || e.key === 'ArrowRight'
            ? 1
            : e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'ArrowLeft'
              ? -1
              : 0;
        if (step) {
          e.preventDefault();
          updateActiveDoc((d) => ({
            ...d,
            currentPage: Math.max(0, Math.min(d.pageCount - 1, d.currentPage + step)),
          }));
          return;
        }
      }
    }

    if (mod && e.key === 's') {
      e.preventDefault();
      const doc = getActiveDoc();
      if (doc) import('../pdf/loader').then(({ saveDocument }) => saveDocument(doc.id));
    }
    if (mod && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      handleEditAction('undo');
    }
    if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      handleEditAction('redo');
    }
    if (mod && e.key === 'x') {
      e.preventDefault();
      handleEditAction('cut');
    }
    if (mod && e.key === 'c') handleEditAction('copy');
    if (mod && e.key === 'v' && e.shiftKey) {
      e.preventDefault();
      handleEditAction('paste-in-place');
    } else if (mod && e.key === 'v') handleEditAction('paste');
    if (mod && e.key === 'd') {
      e.preventDefault();
      handleEditAction('duplicate');
    }
    if (e.key === 'Delete' || e.key === 'Backspace') handleEditAction('delete');

    const toolKeys: Record<string, ToolId> = {
      f: 'flip',
      h: 'pan',
      z: 'zoom',
      r: 'rectangle',
      o: 'ellipse',
      l: 'line',
      p: 'polyline',
      t: 'text',
      q: 'callout',
      d: 'dimension',
    };
    if (!mod && toolKeys[e.key.toLowerCase()]) {
      import('../state/store').then(({ setActiveTool }) => setActiveTool(toolKeys[e.key.toLowerCase()]!));
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
      import('../state/store').then(({ setActiveTool }) => setActiveTool('polygon'));
    }
  });
}
