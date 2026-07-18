import { drawMarkupOnCanvas } from '../markups/draw';
import { calloutLeader, dimensionGeometry } from '../util/geometry';
import type { Markup, OverlaySlot, PageDefaults, Point } from '../state/types';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

/* Large vector CAD/Revit pages are expensive to rasterize. The strategy:
   - The full-page "base" bitmap is capped at MAX_BASE_PIXELS and CSS-stretched
     to the layout size, so deep zooms never rasterize a gigapixel canvas.
   - A "detail" canvas re-renders ONLY the visible region at the exact zoom
     once the base is softer than the screen — crisp where the user looks,
     cheap everywhere else.
   - The markup canvas covers just the visible region too and is redrawn
     synchronously (vector, cheap) so markups never lag the PDF.
   - Renders happen offscreen and blit on completion: the previous bitmap
     stays visible (stretched) instead of flashing blank. */
const MAX_BASE_PIXELS = 16_000_000;
/** Extra margin (fraction of the viewport) rendered around the visible region
 *  by the detail pass / markup canvas, so small pans don't need a redraw. */
const REGION_MARGIN = 0.3;
/** Overlay bitmaps cached per page view (slot page → bitmap). */
const OVERLAY_CACHE_MAX = 4;

interface Region { x: number; y: number; w: number; h: number }

type RenderTask = { cancel: () => void; promise: Promise<unknown> };

export class PageView {
  readonly el: HTMLDivElement;
  readonly pdfCanvas: HTMLCanvasElement;
  /** Crisp re-render of just the visible region when the base is capped. */
  readonly detailCanvas: HTMLCanvasElement;
  /** Sits between the PDF and markup layers; holds semi-transparent renders of
   *  other pages when the Overlay bar is active. */
  readonly overlayCanvas: HTMLCanvasElement;
  readonly markupCanvas: HTMLCanvasElement;
  readonly svgLayer: SVGSVGElement;
  readonly pageIndex: number;
  private scale = 1;       // layout zoom — CSS px per PDF point
  private pageWidth = 0;   // page size in PDF points
  private pageHeight = 0;
  private baseScale = 0;   // scale of the current base bitmap (0 = none yet)
  private _page: PDFPageProxy | null = null;
  private _baseTask: RenderTask | null = null;
  private _detailTask: RenderTask | null = null;
  private _detailKey = '';
  /** Visible region in layout CSS px (markup + detail coverage). */
  private region: Region = { x: 0, y: 0, w: 0, h: 0 };
  /** Guards against an older renderOverlays() call finishing after a newer one. */
  private _overlayGen = 0;
  private _ovTasks: RenderTask[] = [];
  private _ovCache = new Map<number, { scale: number; canvas: HTMLCanvasElement }>();

  constructor(pageIndex: number) {
    this.pageIndex = pageIndex;
    this.el = document.createElement('div');
    this.el.className = 'page-view';
    this.el.dataset.page = String(pageIndex);

    this.pdfCanvas = document.createElement('canvas');
    this.pdfCanvas.className = 'page-layer pdf-layer';
    this.detailCanvas = document.createElement('canvas');
    this.detailCanvas.className = 'page-layer detail-layer';
    this.detailCanvas.style.display = 'none';
    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.className = 'page-layer overlay-layer';
    this.markupCanvas = document.createElement('canvas');
    this.markupCanvas.className = 'page-layer markup-layer';
    this.svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svgLayer.classList.add('page-layer', 'svg-layer');

    this.el.append(this.pdfCanvas, this.detailCanvas, this.overlayCanvas, this.markupCanvas, this.svgLayer);
  }

  /** Apply the page geometry + zoom to the DOM synchronously. Existing bitmaps
   *  are CSS-stretched to the new size, so the page content stays visible
   *  while crisp renders catch up. Returns true when anything changed. */
  setLayout(pageWidth: number, pageHeight: number, zoom: number): boolean {
    if (this.pageWidth === pageWidth && this.pageHeight === pageHeight && this.scale === zoom) {
      return false;
    }
    this.pageWidth = pageWidth;
    this.pageHeight = pageHeight;
    this.scale = zoom;
    const w = Math.round(pageWidth * zoom);
    const h = Math.round(pageHeight * zoom);
    this.el.style.width = `${w}px`;
    this.el.style.height = `${h}px`;
    // Stretch whatever bitmaps exist — never blank the page
    this.pdfCanvas.style.width = `${w}px`;
    this.pdfCanvas.style.height = `${h}px`;
    this.overlayCanvas.style.width = `${w}px`;
    this.overlayCanvas.style.height = `${h}px`;
    this.svgLayer.setAttribute('width', String(w));
    this.svgLayer.setAttribute('height', String(h));
    this.svgLayer.style.width = `${w}px`;
    this.svgLayer.style.height = `${h}px`;
    // The detail bitmap belongs to the previous zoom/region — hide it
    this._detailTask?.cancel();
    this._detailTask = null;
    this._detailKey = '';
    this.detailCanvas.style.display = 'none';
    return true;
  }

  /** Largest render scale whose full-page bitmap stays within the pixel cap. */
  getRenderScale(): number {
    const px = this.pageWidth * this.pageHeight * this.scale * this.scale;
    return px > 0 && px > MAX_BASE_PIXELS ? this.scale * Math.sqrt(MAX_BASE_PIXELS / px) : this.scale;
  }

  hasBase(): boolean {
    return this.baseScale > 0;
  }

  /** True when the base bitmap already matches the screen resolution. */
  baseIsCrisp(): boolean {
    return this.baseScale >= this.scale - 1e-6;
  }

  cancelRenders(): void {
    this._baseTask?.cancel();
    this._baseTask = null;
    this._detailTask?.cancel();
    this._detailTask = null;
    for (const t of this._ovTasks) t.cancel();
    this._ovTasks = [];
  }

  /** Render the full page at the capped scale into an offscreen canvas, then
   *  blit — the previous bitmap stays on screen until the new one is ready. */
  async renderBase(page: PDFPageProxy): Promise<boolean> {
    this._page = page;
    const scale = this.getRenderScale();
    // Deep zooms plateau at the cap — the existing bitmap is already right
    if (Math.abs(scale - this.baseScale) < 1e-6) return true;
    this._baseTask?.cancel();
    const viewport = page.getViewport({ scale });
    const off = document.createElement('canvas');
    off.width = Math.ceil(viewport.width);
    off.height = Math.ceil(viewport.height);
    const task = page.render({ canvasContext: off.getContext('2d')!, viewport, canvas: off });
    this._baseTask = task;
    try {
      await task.promise;
    } catch {
      return false; // cancelled or failed — keep showing what we had
    }
    if (this._baseTask !== task) return false; // superseded by a newer render
    this._baseTask = null;
    this.pdfCanvas.width = off.width;
    this.pdfCanvas.height = off.height;
    this.pdfCanvas.getContext('2d')!.drawImage(off, 0, 0);
    this.baseScale = scale;
    this.pdfCanvas.style.width = `${Math.round(this.pageWidth * this.scale)}px`;
    this.pdfCanvas.style.height = `${Math.round(this.pageHeight * this.scale)}px`;
    return true;
  }

  /** Update the visible region (layout CSS px). The markup canvas covers just
   *  this region (+margin). Returns true when the region actually moved. */
  setVisibleRegion(r: Region): boolean {
    const w = this.pageWidth * this.scale;
    const h = this.pageHeight * this.scale;
    const mx = r.w * REGION_MARGIN;
    const my = r.h * REGION_MARGIN;
    const x0 = Math.max(0, Math.floor(r.x - mx));
    const y0 = Math.max(0, Math.floor(r.y - my));
    const x1 = Math.min(w, Math.ceil(r.x + r.w + mx));
    const y1 = Math.min(h, Math.ceil(r.y + r.h + my));
    const next: Region = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
    const cur = this.region;
    if (next.x === cur.x && next.y === cur.y && next.w === cur.w && next.h === cur.h) return false;
    this.region = next;
    const mc = this.markupCanvas;
    mc.style.left = `${next.x}px`;
    mc.style.top = `${next.y}px`;
    mc.style.width = `${next.w}px`;
    mc.style.height = `${next.h}px`;
    if (mc.width !== next.w || mc.height !== next.h) {
      mc.width = next.w;
      mc.height = next.h;
    }
    return true;
  }

  /** Crisp re-render of the visible region at the exact zoom. Skipped while
   *  the base bitmap already matches the screen. */
  async renderDetail(): Promise<void> {
    const page = this._page;
    if (!page) return;
    if (this.baseIsCrisp() || !this.region.w || !this.region.h) {
      this._detailTask?.cancel();
      this._detailTask = null;
      this._detailKey = '';
      this.detailCanvas.style.display = 'none';
      return;
    }
    const { x, y, w, h } = this.region;
    const key = `${x},${y},${w},${h}@${this.scale}`;
    if (key === this._detailKey) return;
    this._detailTask?.cancel();
    const viewport = page.getViewport({ scale: this.scale });
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const task = page.render({
      canvasContext: off.getContext('2d')!,
      viewport,
      canvas: off,
      // Shift the render so the region's top-left lands at the canvas origin
      transform: [1, 0, 0, 1, -x, -y],
    });
    this._detailTask = task;
    try {
      await task.promise;
    } catch {
      return;
    }
    if (this._detailTask !== task) return;
    this._detailTask = null;
    this.detailCanvas.width = w;
    this.detailCanvas.height = h;
    this.detailCanvas.getContext('2d')!.drawImage(off, 0, 0);
    this.detailCanvas.style.left = `${x}px`;
    this.detailCanvas.style.top = `${y}px`;
    this.detailCanvas.style.width = `${w}px`;
    this.detailCanvas.style.height = `${h}px`;
    this.detailCanvas.style.display = '';
    this._detailKey = key;
  }

  /** Render up to two other pages, semi-transparent, on top of the PDF layer.
   *  Slot pages are rasterized once per scale into a small cache — changing
   *  opacity or the Multiply blend only recomposites, and zoom changes above
   *  the pixel cap reuse the same bitmaps. */
  async renderOverlays(
    pdfDoc: PDFDocumentProxy,
    overlays: readonly (OverlaySlot | null)[],
    multiply = false,
  ): Promise<void> {
    const gen = ++this._overlayGen;
    for (const t of this._ovTasks) t.cancel();
    this._ovTasks = [];
    const target = this.getRenderScale();
    const slots = overlays.filter((s): s is OverlaySlot => !!s && s.pageIndex !== this.pageIndex);

    // Rasterize any slot page we don't have at this scale yet
    for (const slot of slots) {
      const cached = this._ovCache.get(slot.pageIndex);
      if (cached && Math.abs(cached.scale - target) < 1e-6) continue;
      const page = await pdfDoc.getPage(slot.pageIndex + 1);
      if (gen !== this._overlayGen) return;
      const viewport = page.getViewport({ scale: target });
      const off = document.createElement('canvas');
      off.width = Math.ceil(viewport.width);
      off.height = Math.ceil(viewport.height);
      const task = page.render({ canvasContext: off.getContext('2d')!, viewport, canvas: off });
      this._ovTasks.push(task);
      try {
        await task.promise;
      } catch {
        return; // cancelled — a newer call owns the overlay now
      }
      if (gen !== this._overlayGen) return;
      this._ovCache.delete(slot.pageIndex);
      this._ovCache.set(slot.pageIndex, { scale: target, canvas: off });
      while (this._ovCache.size > OVERLAY_CACHE_MAX) {
        const oldest = this._ovCache.keys().next().value;
        if (oldest === undefined) break;
        this._ovCache.delete(oldest);
      }
    }
    if (gen !== this._overlayGen) return;

    // Composite the cached bitmaps at the base resolution, CSS-stretched
    const bw = Math.max(1, Math.ceil(this.pageWidth * target));
    const bh = Math.max(1, Math.ceil(this.pageHeight * target));
    this.overlayCanvas.width = bw;
    this.overlayCanvas.height = bh;
    this.overlayCanvas.style.width = `${Math.round(this.pageWidth * this.scale)}px`;
    this.overlayCanvas.style.height = `${Math.round(this.pageHeight * this.scale)}px`;
    this.overlayCanvas.style.mixBlendMode = multiply ? 'multiply' : '';
    const ctx = this.overlayCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, bw, bh);
    for (const slot of slots) {
      const cached = this._ovCache.get(slot.pageIndex);
      if (!cached) continue;
      const k = target / cached.scale;
      ctx.globalAlpha = slot.opacity;
      ctx.drawImage(cached.canvas, 0, 0, cached.canvas.width * k, cached.canvas.height * k);
      ctx.globalAlpha = 1;
    }
  }

  clearOverlays(): void {
    this._overlayGen++;
    for (const t of this._ovTasks) t.cancel();
    this._ovTasks = [];
    this.overlayCanvas.style.mixBlendMode = '';
    const ctx = this.overlayCanvas.getContext('2d');
    ctx?.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
  }

  redrawMarkups(markups: Markup[], defaults: PageDefaults): void {
    const ctx = this.markupCanvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.markupCanvas.width, this.markupCanvas.height);
    // The canvas covers only the visible region — shift page space into it
    ctx.translate(-this.region.x, -this.region.y);
    const pageMarkups = markups.filter((m) => m.pageIndex === this.pageIndex);
    for (const m of pageMarkups) {
      drawMarkupOnCanvas(ctx, m, defaults, this.scale, this.pageHeight);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Composite PDF (base + detail) and markups for a layout-CSS-px region —
   *  used by the Snip tool. */
  captureRegion(x: number, y: number, w: number, h: number): HTMLCanvasElement {
    const tmp = document.createElement('canvas');
    tmp.width = Math.max(1, Math.round(w));
    tmp.height = Math.max(1, Math.round(h));
    const ctx = tmp.getContext('2d')!;
    // Base bitmap, stretched from render scale to layout scale
    if (this.baseScale > 0) {
      const k = this.baseScale / this.scale;
      ctx.drawImage(this.pdfCanvas, x * k, y * k, w * k, h * k, 0, 0, tmp.width, tmp.height);
    }
    // Crisp detail region, where available
    if (this.detailCanvas.style.display !== 'none' && this._detailKey) {
      ctx.drawImage(
        this.detailCanvas,
        x - parseFloat(this.detailCanvas.style.left || '0'),
        y - parseFloat(this.detailCanvas.style.top || '0'),
        w,
        h,
        0,
        0,
        tmp.width,
        tmp.height,
      );
    }
    // Markups (region canvas — shift into its space)
    ctx.drawImage(this.markupCanvas, x - this.region.x, y - this.region.y, w, h, 0, 0, tmp.width, tmp.height);
    return tmp;
  }

  /** Free GPU/memory for pages that have scrolled far out of the prefetch window. */
  evict(): void {
    this.cancelRenders();
    this._overlayGen++;
    this._ovCache.clear();
    this._page = null;
    this.baseScale = 0;
    this._detailKey = '';
    this.detailCanvas.style.display = 'none';
    this.pdfCanvas.width = 1;
    this.pdfCanvas.height = 1;
    this.detailCanvas.width = 1;
    this.detailCanvas.height = 1;
    this.overlayCanvas.width = 1;
    this.overlayCanvas.height = 1;
    this.markupCanvas.width = 1;
    this.markupCanvas.height = 1;
  }

  clearSvg(): void {
    this.svgLayer.innerHTML = '';
  }

  /** Pulse a highlight over a page-coordinate rect (search hits). */
  flashHighlight(rect: { x: number; y: number; w: number; h: number }): void {
    const ns = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(ns, 'rect');
    const pad = 3;
    el.setAttribute('x', String(rect.x * this.scale - pad));
    el.setAttribute('y', String((this.pageHeight - rect.y - rect.h) * this.scale - pad));
    el.setAttribute('width', String(rect.w * this.scale + pad * 2));
    el.setAttribute('height', String(rect.h * this.scale + pad * 2));
    el.setAttribute('rx', '3');
    el.setAttribute('class', 'search-flash');
    this.svgLayer.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }

  drawSelectionHandles(markup: Markup, selected: boolean): void {
    this.clearSvg();
    if (!selected) return;
    const ns = 'http://www.w3.org/2000/svg';
    const handles = getHandlePoints(markup);

    // Rotation (rect / ellipse): rotate the handles about the screen center to
    // match the drawn shape, then add corner-outside rotate handles.
    const rotDeg = markup.type === 'rectangle' || markup.type === 'ellipse' ? markup.rotation ?? 0 : 0;
    const rot = rotDeg * (Math.PI / 180);
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const center = rectEllipseCenter(markup);
    const scx = center ? center.x * this.scale : 0;
    const scy = center ? (this.pageHeight - center.y) * this.scale : 0;
    const toScreen = (h: { x: number; y: number }): { x: number; y: number } => {
      let x = h.x * this.scale;
      let y = (this.pageHeight - h.y) * this.scale;
      if (rot && center) {
        const dx = x - scx;
        const dy = y - scy;
        x = scx + dx * cos - dy * sin;
        y = scy + dx * sin + dy * cos;
      }
      return { x, y };
    };

    const addHandle = (x: number, y: number, id: string, rotate = false): void => {
      const el = document.createElementNS(ns, rotate ? 'rect' : 'circle');
      if (rotate) {
        el.setAttribute('x', String(x - 4));
        el.setAttribute('y', String(y - 4));
        el.setAttribute('width', '8');
        el.setAttribute('height', '8');
        el.setAttribute('rx', '4');
        el.setAttribute('fill', '#7a97e8');
      } else {
        el.setAttribute('cx', String(x));
        el.setAttribute('cy', String(y));
        el.setAttribute('r', '5');
        el.setAttribute('fill', '#2f6fe0');
      }
      el.setAttribute('stroke', '#fff');
      el.setAttribute('stroke-width', '1');
      el.dataset.handle = id;
      this.svgLayer.appendChild(el);
    };

    for (const h of handles) {
      const s = toScreen(h);
      addHandle(s.x, s.y, h.id);
    }

    // Rotate handles just outside each corner (rect / ellipse only)
    if (center) {
      for (const id of ['nw', 'ne', 'se', 'sw']) {
        const corner = handles.find((h) => h.id === id);
        if (!corner) continue;
        const s = toScreen(corner);
        const dx = s.x - scx;
        const dy = s.y - scy;
        const L = Math.hypot(dx, dy) || 1;
        addHandle(s.x + (dx / L) * 16, s.y + (dy / L) * 16, 'rotate', true);
      }
    }
  }

  /** Dashed rubber-band rectangle for marquee (box) selection. */
  drawMarquee(a: Point, b: Point): void {
    this.clearSvg();
    const ns = 'http://www.w3.org/2000/svg';
    const S = this.scale;
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', String(Math.min(a.x, b.x) * S));
    rect.setAttribute('y', String((this.pageHeight - Math.max(a.y, b.y)) * S));
    rect.setAttribute('width', String(Math.abs(b.x - a.x) * S));
    rect.setAttribute('height', String(Math.abs(b.y - a.y) * S));
    rect.setAttribute('fill', 'rgba(47, 111, 224, 0.08)');
    rect.setAttribute('stroke', '#2f6fe0');
    rect.setAttribute('stroke-width', '1.5');
    rect.setAttribute('stroke-dasharray', '6 4');
    this.svgLayer.appendChild(rect);
  }

  drawPreview(points: Point[], closed: boolean, color = '#002060'): void {
    this.clearSvg();
    if (points.length < 1) return;
    const ns = 'http://www.w3.org/2000/svg';
    const pts = points
      .map((p) => `${p.x * this.scale},${(this.pageHeight - p.y) * this.scale}`)
      .join(' ');
    if (closed && points.length > 2) {
      // Use <polygon> so the closing segment and fill render correctly
      const poly = document.createElementNS(ns, 'polygon');
      poly.setAttribute('points', pts);
      poly.setAttribute('fill', color);
      poly.setAttribute('fill-opacity', '0.15');
      poly.setAttribute('stroke', color);
      poly.setAttribute('stroke-width', '2');
      poly.setAttribute('stroke-linejoin', 'miter');
      this.svgLayer.appendChild(poly);
    } else {
      const polyline = document.createElementNS(ns, 'polyline');
      polyline.setAttribute('points', pts);
      polyline.setAttribute('fill', 'none');
      polyline.setAttribute('stroke', color);
      polyline.setAttribute('stroke-width', '2');
      polyline.setAttribute('stroke-linecap', 'butt');
      polyline.setAttribute('stroke-linejoin', 'miter');
      this.svgLayer.appendChild(polyline);
    }
  }

  /** Draft graphic for the 3-click callout: leader polyline, optional text
   *  box, and an anchor dot. All inputs are page coords (box.y = bottom). */
  drawCalloutGuide(
    linePts: Point[],
    box: { x: number; y: number; w: number; h: number } | null,
    color: string,
    /** Filled arrowhead at `tip`, pointing away from `from` (the elbow) —
     *  same 1:1 triangle geometry as the committed rendering. */
    arrow: { tip: Point; from: Point } | null,
  ): void {
    this.clearSvg();
    const ns = 'http://www.w3.org/2000/svg';
    const S = this.scale;
    const ph = this.pageHeight;
    const toS = (p: Point) => ({ x: p.x * S, y: (ph - p.y) * S });

    if (box) {
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', String(box.x * S));
      rect.setAttribute('y', String((ph - box.y - box.h) * S));
      rect.setAttribute('width', String(box.w * S));
      rect.setAttribute('height', String(box.h * S));
      rect.setAttribute('fill', color);
      rect.setAttribute('fill-opacity', '0.12');
      rect.setAttribute('stroke', color);
      rect.setAttribute('stroke-width', '2');
      rect.setAttribute('stroke-linejoin', 'miter');
      this.svgLayer.appendChild(rect);
    }

    if (linePts.length >= 2) {
      const polyline = document.createElementNS(ns, 'polyline');
      polyline.setAttribute('points', linePts.map((p) => { const s = toS(p); return `${s.x},${s.y}`; }).join(' '));
      polyline.setAttribute('fill', 'none');
      polyline.setAttribute('stroke', color);
      polyline.setAttribute('stroke-width', '2');
      polyline.setAttribute('stroke-linecap', 'butt');
      polyline.setAttribute('stroke-linejoin', 'miter');
      this.svgLayer.appendChild(polyline);
    }

    if (arrow) {
      const tip = toS(arrow.tip);
      const from = toS(arrow.from);
      const dx = from.x - tip.x;
      const dy = from.y - tip.y;
      if (Math.hypot(dx, dy) > 0.5) {
        // Match the committed callout arrow: hypotenuse = weight × 2.5 ×
        // ARROW_LEN(6), half-angle atan(0.5) → base width equals depth
        const ang = Math.atan2(dy, dx);
        const spread = Math.atan(0.5);
        const len = 2.5 * S * 6; // default line weight 1
        const p1 = { x: tip.x + len * Math.cos(ang - spread), y: tip.y + len * Math.sin(ang - spread) };
        const p2 = { x: tip.x + len * Math.cos(ang + spread), y: tip.y + len * Math.sin(ang + spread) };
        const tri = document.createElementNS(ns, 'polygon');
        tri.setAttribute('points', `${tip.x},${tip.y} ${p1.x},${p1.y} ${p2.x},${p2.y}`);
        tri.setAttribute('fill', color);
        this.svgLayer.appendChild(tri);
      }
    }
  }

  getScale(): number {
    return this.scale;
  }

  getPageHeight(): number {
    return this.pageHeight;
  }

  screenToPage(sx: number, sy: number): Point {
    // The page element has an explicit layout size of pageSize × zoom, so the
    // mapping is independent of any canvas bitmap resolution.
    const rect = this.el.getBoundingClientRect();
    return {
      x: (sx - rect.left) / this.scale,
      y: this.pageHeight - (sy - rect.top) / this.scale,
    };
  }
}

/** Page-coord center of a rotatable shape (rectangle / ellipse), else null. */
function rectEllipseCenter(markup: Markup): Point | null {
  if (markup.type === 'rectangle') return { x: markup.x + markup.width / 2, y: markup.y + markup.height / 2 };
  if (markup.type === 'ellipse') return { x: markup.cx, y: markup.cy };
  return null;
}

function getHandlePoints(markup: Markup): { id: string; x: number; y: number }[] {
  switch (markup.type) {
    case 'rectangle':
    case 'highlighter':
    case 'snipImage':
      // 8 control points: 4 corners + 4 edge midpoints
      return [
        { id: 'nw', x: markup.x, y: markup.y + markup.height },
        { id: 'n', x: markup.x + markup.width / 2, y: markup.y + markup.height },
        { id: 'ne', x: markup.x + markup.width, y: markup.y + markup.height },
        { id: 'e', x: markup.x + markup.width, y: markup.y + markup.height / 2 },
        { id: 'se', x: markup.x + markup.width, y: markup.y },
        { id: 's', x: markup.x + markup.width / 2, y: markup.y },
        { id: 'sw', x: markup.x, y: markup.y },
        { id: 'w', x: markup.x, y: markup.y + markup.height / 2 },
      ];
    case 'text':
      return [
        { id: 'nw', x: markup.x, y: markup.y + markup.height },
        { id: 'ne', x: markup.x + markup.width, y: markup.y + markup.height },
        { id: 'se', x: markup.x + markup.width, y: markup.y },
        { id: 'sw', x: markup.x, y: markup.y },
      ];
    case 'callout': {
      const leader = calloutLeader(
        markup.textX,
        markup.textY,
        markup.textWidth,
        markup.textHeight,
        markup.anchorX,
        markup.anchorY,
        markup.kinkX,
        markup.kinkY,
      );
      return [
        { id: 'anchor', x: markup.anchorX, y: markup.anchorY },
        { id: 'kink', x: leader.kink.x, y: leader.kink.y },
        { id: 'nw', x: markup.textX, y: markup.textY + markup.textHeight },
        { id: 'ne', x: markup.textX + markup.textWidth, y: markup.textY + markup.textHeight },
        { id: 'se', x: markup.textX + markup.textWidth, y: markup.textY },
        { id: 'sw', x: markup.textX, y: markup.textY },
      ];
    }
    case 'measureAngle':
      return [
        { id: 'p1', x: markup.p1.x, y: markup.p1.y },
        { id: 'vertex', x: markup.vertex.x, y: markup.vertex.y },
        { id: 'p2', x: markup.p2.x, y: markup.p2.y },
      ];
    case 'ellipse':
      // 8 control points on the bounding box: 4 corners (resize both axes by
      // dragging a diagonal) + 4 edge midpoints (resize one axis)
      return [
        { id: 'nw', x: markup.cx - markup.rx, y: markup.cy + markup.ry },
        { id: 'n', x: markup.cx, y: markup.cy + markup.ry },
        { id: 'ne', x: markup.cx + markup.rx, y: markup.cy + markup.ry },
        { id: 'e', x: markup.cx + markup.rx, y: markup.cy },
        { id: 'se', x: markup.cx + markup.rx, y: markup.cy - markup.ry },
        { id: 's', x: markup.cx, y: markup.cy - markup.ry },
        { id: 'sw', x: markup.cx - markup.rx, y: markup.cy - markup.ry },
        { id: 'w', x: markup.cx - markup.rx, y: markup.cy },
      ];
    case 'line':
      return [
        { id: 'start', x: markup.x1, y: markup.y1 },
        { id: 'end', x: markup.x2, y: markup.y2 },
      ];
    case 'dimension': {
      // start/end sit on the measured points (micro-adjust); the offset
      // handle sits mid-span on the dimension line to pull it away
      const g = dimensionGeometry(markup.x1, markup.y1, markup.x2, markup.y2, markup.offset ?? 0);
      return [
        { id: 'start', x: markup.x1, y: markup.y1 },
        { id: 'end', x: markup.x2, y: markup.y2 },
        { id: 'offset', x: g.mid.x, y: g.mid.y },
      ];
    }
    case 'polyline':
    case 'polygon':
    case 'cloud':
      return markup.points.map((p, i) => ({ id: `v${i}`, x: p.x, y: p.y }));
    default:
      return [];
  }
}

export type { PDFPageProxy };
