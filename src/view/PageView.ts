import { drawMarkupOnCanvas } from '../markups/draw';
import { calloutLeader, dimensionGeometry } from '../util/geometry';
import type { Markup, OverlaySlot, PageDefaults, Point } from '../state/types';
import { renderPageToCanvas } from '../pdf/render';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

export class PageView {
  readonly el: HTMLDivElement;
  readonly pdfCanvas: HTMLCanvasElement;
  /** Sits between the PDF and markup layers; holds semi-transparent renders of
   *  other pages when the Overlay bar is active. */
  readonly overlayCanvas: HTMLCanvasElement;
  readonly markupCanvas: HTMLCanvasElement;
  readonly svgLayer: SVGSVGElement;
  readonly pageIndex: number;
  private scale = 1;
  private pageHeight = 0;
  private _renderTask: { cancel: () => void; promise: Promise<void> } | null = null;
  /** Guards against an older renderOverlays() call finishing after a newer one. */
  private _overlayGen = 0;

  constructor(pageIndex: number) {
    this.pageIndex = pageIndex;
    this.el = document.createElement('div');
    this.el.className = 'page-view';
    this.el.dataset.page = String(pageIndex);

    this.pdfCanvas = document.createElement('canvas');
    this.pdfCanvas.className = 'page-layer pdf-layer';
    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.className = 'page-layer overlay-layer';
    this.markupCanvas = document.createElement('canvas');
    this.markupCanvas.className = 'page-layer markup-layer';
    this.svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svgLayer.classList.add('page-layer', 'svg-layer');

    this.el.append(this.pdfCanvas, this.overlayCanvas, this.markupCanvas, this.svgLayer);
  }

  async renderPdf(page: PDFPageProxy, zoom: number): Promise<void> {
    this.scale = zoom;
    // Cancel any in-flight render on this canvas before starting a new one
    this._renderTask?.cancel();
    const { task, height } = renderPageToCanvas(page, this.pdfCanvas, zoom);
    this._renderTask = task;
    try {
      await task.promise;
    } catch {
      return; // render was cancelled or errored — don't update layout
    }
    this._renderTask = null;
    this.pageHeight = height / zoom;
    this.markupCanvas.width = this.pdfCanvas.width;
    this.markupCanvas.height = this.pdfCanvas.height;
    this.markupCanvas.style.width = this.pdfCanvas.style.width;
    this.markupCanvas.style.height = this.pdfCanvas.style.height;
    this.svgLayer.setAttribute('width', String(this.pdfCanvas.width));
    this.svgLayer.setAttribute('height', String(this.pdfCanvas.height));
    this.svgLayer.style.width = this.pdfCanvas.style.width;
    this.svgLayer.style.height = this.pdfCanvas.style.height;
  }

  /** Render up to two other pages, semi-transparent, on top of the PDF layer.
   *  Pages are rendered at this view's current zoom into offscreen canvases,
   *  then composited with the slot's opacity. With `multiply` the whole
   *  overlay layer blends Photoshop-Multiply style into the page below it. */
  async renderOverlays(
    pdfDoc: PDFDocumentProxy,
    overlays: readonly (OverlaySlot | null)[],
    multiply = false,
  ): Promise<void> {
    const gen = ++this._overlayGen;
    // Match the PDF layer's size/placement
    this.overlayCanvas.width = this.pdfCanvas.width;
    this.overlayCanvas.height = this.pdfCanvas.height;
    this.overlayCanvas.style.width = this.pdfCanvas.style.width;
    this.overlayCanvas.style.height = this.pdfCanvas.style.height;
    this.overlayCanvas.style.mixBlendMode = multiply ? 'multiply' : '';
    const ctx = this.overlayCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

    for (const slot of overlays) {
      if (!slot || slot.pageIndex === this.pageIndex) continue;
      const page = await pdfDoc.getPage(slot.pageIndex + 1);
      const viewport = page.getViewport({ scale: this.scale });
      const off = document.createElement('canvas');
      off.width = Math.ceil(viewport.width);
      off.height = Math.ceil(viewport.height);
      const offCtx = off.getContext('2d')!;
      await page.render({ canvasContext: offCtx, viewport, canvas: off }).promise;
      if (gen !== this._overlayGen) return; // superseded by a newer call
      ctx.globalAlpha = slot.opacity;
      ctx.drawImage(off, 0, 0);
      ctx.globalAlpha = 1;
    }
  }

  clearOverlays(): void {
    this._overlayGen++;
    this.overlayCanvas.style.mixBlendMode = '';
    const ctx = this.overlayCanvas.getContext('2d');
    ctx?.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
  }

  redrawMarkups(markups: Markup[], defaults: PageDefaults): void {
    const ctx = this.markupCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.markupCanvas.width, this.markupCanvas.height);
    const pageMarkups = markups.filter((m) => m.pageIndex === this.pageIndex);
    for (const m of pageMarkups) {
      drawMarkupOnCanvas(ctx, m, defaults, this.scale, this.pageHeight);
    }
  }

  /** Free GPU/memory for pages that have scrolled far out of the prefetch window. */
  evict(): void {
    this._renderTask?.cancel();
    this._renderTask = null;
    this._overlayGen++;
    this.pdfCanvas.width = 1;
    this.pdfCanvas.height = 1;
    this.overlayCanvas.width = 1;
    this.overlayCanvas.height = 1;
    this.markupCanvas.width = 1;
    this.markupCanvas.height = 1;
  }

  clearSvg(): void {
    this.svgLayer.innerHTML = '';
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
        el.setAttribute('fill', '#9a91b5');
      } else {
        el.setAttribute('cx', String(x));
        el.setAttribute('cy', String(y));
        el.setAttribute('r', '5');
        el.setAttribute('fill', '#6b6280');
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
    anchorDot: Point | null,
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

    if (anchorDot) {
      const s = toS(anchorDot);
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', String(s.x));
      dot.setAttribute('cy', String(s.y));
      dot.setAttribute('r', '3.5');
      dot.setAttribute('fill', color);
      this.svgLayer.appendChild(dot);
    }
  }

  getScale(): number {
    return this.scale;
  }

  getPageHeight(): number {
    return this.pageHeight;
  }

  screenToPage(sx: number, sy: number): Point {
    const rect = this.markupCanvas.getBoundingClientRect();
    const x = ((sx - rect.left) / rect.width) * this.markupCanvas.width;
    const y = ((sy - rect.top) / rect.height) * this.markupCanvas.height;
    return {
      x: x / this.scale,
      y: this.pageHeight - y / this.scale,
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
