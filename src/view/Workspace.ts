import { PageView } from './PageView';
import {
  getActiveDoc,
  getState,
  subscribe,
  updateActiveDoc,
  setCursorPagePoint,
} from '../state/store';
import { handlePointerDown, handlePointerMove, handlePointerUp, handleWheel } from '../tools/controller';

/** Pages pre-rendered on each side of the current page. */
const PREFETCH_RADIUS = 2;
/** Pages beyond this distance from current are evicted to free memory. */
const EVICT_RADIUS = 8;
/** Virtual page buffer for continuous-mode scroll. */
const BUFFER = 2;
/** Pan slack around pages — must match .workspace-content padding in main.css. */
const CONTENT_PAD = 160;

export class Workspace {
  readonly el: HTMLDivElement;
  readonly scrollEl: HTMLDivElement;
  readonly contentEl: HTMLDivElement;
  private pageViews = new Map<number, PageView>();
  /** Set of page indices rendered at the current zoom level. */
  private mounted = new Set<number>();
  private unsub: (() => void) | null = null;
  private _lastDocId: string | null = null;
  private _lastZoom = 0;
  private _rafId: number | null = null;
  /** Signature of the last overlay render, to skip redundant work. */
  private _lastOverlayKey = '';
  /** Center the scroll position after the next render (doc open / fit). */
  private _centerNext = false;
  /** Split pane: this viewer keeps its own zoom instead of the shared doc zoom. */
  private _independentZoom = false;
  /** This viewer's zoom when `_independentZoom` is set. */
  private _zoom = 1;

  constructor(independentZoom = false) {
    this._independentZoom = independentZoom;
    this.el = document.createElement('div');
    this.el.className = 'workspace';
    this.scrollEl = document.createElement('div');
    this.scrollEl.className = 'workspace-scroll';
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'workspace-content';
    this.scrollEl.appendChild(this.contentEl);
    this.el.appendChild(this.scrollEl);

    this.scrollEl.addEventListener('scroll', () => this.onScroll());
    this.contentEl.addEventListener('pointerdown', (e) => handlePointerDown(e, this));
    this.contentEl.addEventListener('pointermove', (e) => handlePointerMove(e, this));
    this.contentEl.addEventListener('pointerup', (e) => handlePointerUp(e, this));
    this.contentEl.addEventListener('wheel', (e) => handleWheel(e, this), { passive: false });

    this.el.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.el.classList.add('drag-over');
    });
    this.el.addEventListener('dragleave', () => this.el.classList.remove('drag-over'));
    this.el.addEventListener('drop', async (e) => {
      e.preventDefault();
      this.el.classList.remove('drag-over');
      const file = e.dataTransfer?.files[0];
      if (file?.type === 'application/pdf') {
        const { loadPdfFromFile } = await import('../pdf/loader');
        await loadPdfFromFile(file, null);
      }
    });
  }

  mount(container: HTMLElement): void {
    // A split viewer starts at the current shared zoom, then zooms independently
    if (this._independentZoom) this._zoom = getActiveDoc()?.zoom ?? this._zoom;
    container.appendChild(this.el);
    this.unsub = subscribe(() => this._scheduleRefresh());
    void this.refresh();
  }

  /** The zoom this viewer renders at: its own when independent (the split
   *  pane), otherwise the shared document zoom. */
  getZoom(): number {
    return this._independentZoom ? this._zoom : (getActiveDoc()?.zoom ?? 1);
  }

  /**
   * Coalesce rapid state changes (cursor moves, tool switches) into a single
   * repaint per animation frame.
   */
  private _scheduleRefresh(): void {
    if (this._rafId !== null) return;
    this._rafId = requestAnimationFrame(async () => {
      this._rafId = null;
      await this.refresh();
    });
  }

  destroy(): void {
    this.unsub?.();
    if (this._rafId !== null) cancelAnimationFrame(this._rafId);
  }

  /** Detach from the DOM and stop reacting to state (used by the split pane's
   *  duplicate viewer when the split is closed). Can be re-`mount`ed later. */
  unmount(): void {
    this.unsub?.();
    this.unsub = null;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._evictAll();
    this._lastDocId = null;
    this._lastZoom = 0;
    this.el.remove();
  }

  /** Re-center the page in the viewport on the next render. */
  centerView(): void {
    this._centerNext = true;
    void this.refresh();
  }

  getPageView(pageIndex: number): PageView | undefined {
    return this.pageViews.get(pageIndex);
  }

  getPageViewAt(clientX: number, clientY: number): PageView | null {
    for (const pv of this.pageViews.values()) {
      const rect = pv.el.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        return pv;
      }
    }
    return null;
  }

  async refresh(): Promise<void> {
    const doc = getActiveDoc();
    if (!doc?.pdfDoc) {
      this.contentEl.innerHTML = '';
      this._evictAll();
      this._lastDocId = null;
      this._lastZoom = 0;
      this.showEmptyState();
      return;
    }

    // Document switched — drop all cached page renders
    if (doc.id !== this._lastDocId) {
      this._evictAll();
      this.contentEl.innerHTML = '';
      this._lastDocId = doc.id;
      this._lastZoom = 0;
      this._centerNext = true;
    }

    // Zoom changed — all cached renders are at the wrong scale
    const zoom = this.getZoom();
    if (zoom !== this._lastZoom && this._lastZoom !== 0) {
      this.mounted.clear();
    }
    this._lastZoom = zoom;

    this.hideEmptyState();

    if (doc.viewMode === 'single') {
      await this.renderSinglePage(doc.currentPage, zoom);
    } else {
      this.rebuildContinuousLayout();
      this.onScroll();
    }

    this.syncOverlays();
    this.redrawAllMarkups();

    if (this._centerNext) {
      this._centerNext = false;
      this.centerScroll();
    }
  }

  /** Bring the page into the middle of the viewport (the content carries
   *  CONTENT_PAD of pan slack on every side, so scroll 0,0 is off-page). */
  private centerScroll(): void {
    const doc = getActiveDoc();
    const s = this.scrollEl;
    s.scrollLeft = (s.scrollWidth - s.clientWidth) / 2;
    // Continuous mode starts at the top of the page stack, not its middle
    if (!doc || doc.viewMode === 'single') {
      s.scrollTop = (s.scrollHeight - s.clientHeight) / 2;
    } else {
      s.scrollTop = 0;
    }
  }

  /** Apply the Overlay bar state: composite the chosen pages onto the current
   *  page's overlay canvas, and clear overlays everywhere else. */
  private syncOverlays(): void {
    const doc = getActiveDoc();
    if (!doc?.pdfDoc) return;
    const key = [
      doc.id,
      doc.currentPage,
      this.getZoom(),
      doc.overlayEnabled,
      doc.overlayMultiply,
      JSON.stringify(doc.overlays),
    ].join('|');
    if (key === this._lastOverlayKey) return;
    this._lastOverlayKey = key;
    for (const [i, pv] of this.pageViews) {
      if (doc.overlayEnabled && i === doc.currentPage) {
        void pv.renderOverlays(doc.pdfDoc, doc.overlays, doc.overlayMultiply);
      } else {
        pv.clearOverlays();
      }
    }
  }

  // ─── Single-page mode ─────────────────────────────────────────────────────

  private async renderSinglePage(pageIndex: number, zoom: number): Promise<void> {
    const doc = getActiveDoc();
    if (!doc?.pdfDoc) return;

    // Ensure a PageView object exists so we can mount it immediately
    let pv = this.pageViews.get(pageIndex);
    if (!pv) {
      pv = new PageView(pageIndex);
      this.pageViews.set(pageIndex, pv);
    }

    // Mount pv.el into the DOM BEFORE the async render so that
    // getPageViewAt() always resolves and tools remain responsive
    // throughout (the PDF canvas fills in asynchronously).
    const existingWrapper = this.contentEl.querySelector('.page-wrapper.single');
    const displayedIndex = existingWrapper
      ? Number((existingWrapper.querySelector('[data-page]') as HTMLElement | null)?.dataset.page ?? -1)
      : -1;

    if (displayedIndex !== pageIndex) {
      this.contentEl.innerHTML = '';
      const wrapper = document.createElement('div');
      wrapper.className = 'page-wrapper single';
      wrapper.appendChild(pv.el);
      this.contentEl.appendChild(wrapper);
    }

    // Render the PDF canvas (no-op if already cached at this zoom)
    if (!this.mounted.has(pageIndex)) {
      const page = await doc.pdfDoc.getPage(pageIndex + 1);
      await pv.renderPdf(page, zoom);
      this.mounted.add(pageIndex);
    }

    // Pre-render adjacent pages in the background (don't block the current page)
    void this.prefetchAdjacent(pageIndex, zoom);

    // Free memory for pages far outside the prefetch window
    this.evictDistantPages(pageIndex, EVICT_RADIUS);
  }

  private async prefetchAdjacent(center: number, zoom: number): Promise<void> {
    const doc = getActiveDoc();
    if (!doc?.pdfDoc) return;
    // Render nearest neighbours first (delta 1, then 2)
    for (let delta = 1; delta <= PREFETCH_RADIUS; delta++) {
      for (const sign of [-1, 1]) {
        const i = center + sign * delta;
        if (i < 0 || i >= doc.pageCount) continue;
        if (!this.mounted.has(i)) {
          await this.renderOffscreen(i, zoom);
        }
      }
    }
  }

  /** Render a page into its canvas without placing it in the DOM. */
  private async renderOffscreen(pageIndex: number, zoom: number): Promise<void> {
    const doc = getActiveDoc();
    if (!doc?.pdfDoc) return;
    if (this.mounted.has(pageIndex)) return;
    let pv = this.pageViews.get(pageIndex);
    if (!pv) {
      pv = new PageView(pageIndex);
      this.pageViews.set(pageIndex, pv);
    }
    const page = await doc.pdfDoc.getPage(pageIndex + 1);
    await pv.renderPdf(page, zoom);
    this.mounted.add(pageIndex);
  }

  private evictDistantPages(center: number, radius: number): void {
    for (const [i, pv] of this.pageViews) {
      if (Math.abs(i - center) > radius) {
        pv.evict();
        this.pageViews.delete(i);
        this.mounted.delete(i);
      }
    }
  }

  private _evictAll(): void {
    for (const pv of this.pageViews.values()) pv.evict();
    this.pageViews.clear();
    this.mounted.clear();
  }

  // ─── Continuous mode ──────────────────────────────────────────────────────

  private showEmptyState(): void {
    if (this.el.querySelector('.empty-state')) return;
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<p>Drop a PDF here or use File → Open</p>';
    this.el.appendChild(empty);
  }

  private hideEmptyState(): void {
    this.el.querySelector('.empty-state')?.remove();
  }

  private rebuildContinuousLayout(): void {
    const doc = getActiveDoc();
    if (!doc) return;
    this.contentEl.innerHTML = '';
    for (let i = 0; i < doc.pageCount; i++) {
      const wrapper = document.createElement('div');
      wrapper.className = 'page-wrapper';
      wrapper.dataset.page = String(i);
      const pv = this.pageViews.get(i) ?? new PageView(i);
      this.pageViews.set(i, pv);
      wrapper.appendChild(pv.el);
      this.contentEl.appendChild(wrapper);
    }
  }

  private onScroll(): void {
    const doc = getActiveDoc();
    if (!doc || doc.viewMode === 'single') return;

    const scrollTop = this.scrollEl.scrollTop;
    const viewH = this.scrollEl.clientHeight;
    const zoom = this.getZoom();

    for (let i = 0; i < doc.pageCount; i++) {
      const wrapper = this.contentEl.querySelector(`[data-page="${i}"]`) as HTMLElement | null;
      if (!wrapper) continue;
      const top = wrapper.offsetTop;
      const h = (doc.pages[i]?.height ?? 792) * zoom;
      const visible = top + h >= scrollTop - BUFFER * h && top <= scrollTop + viewH + BUFFER * h;
      if (visible && !this.mounted.has(i)) {
        void this.mountPage(i);
      }
    }
    this.updateCurrentPageFromScroll();
  }

  private async mountPage(pageIndex: number): Promise<void> {
    const doc = getActiveDoc();
    if (!doc?.pdfDoc || this.mounted.has(pageIndex)) return;
    let pv = this.pageViews.get(pageIndex);
    if (!pv) {
      pv = new PageView(pageIndex);
      this.pageViews.set(pageIndex, pv);
    }
    const page = await doc.pdfDoc.getPage(pageIndex + 1);
    await pv.renderPdf(page, this.getZoom());
    const wrapper = this.contentEl.querySelector(`[data-page="${pageIndex}"]`);
    if (wrapper && !wrapper.querySelector('.page-view')) {
      wrapper.appendChild(pv.el);
    }
    this.mounted.add(pageIndex);
    this.redrawPageMarkups(pageIndex);
    // If this page is the overlay target and rendered after the last sync,
    // force a re-sync so the overlay canvas matches the now-final page size.
    if (doc.overlayEnabled && pageIndex === doc.currentPage) {
      this._lastOverlayKey = '';
      this.syncOverlays();
    }
  }

  private updateCurrentPageFromScroll(): void {
    const doc = getActiveDoc();
    if (!doc) return;
    const scrollTop = this.scrollEl.scrollTop + this.scrollEl.clientHeight / 2;
    let current = 0;
    for (let i = 0; i < doc.pageCount; i++) {
      const wrapper = this.contentEl.querySelector(`[data-page="${i}"]`) as HTMLElement | null;
      if (wrapper && wrapper.offsetTop <= scrollTop) current = i;
    }
    if (current !== doc.currentPage) {
      updateActiveDoc((d) => ({ ...d, currentPage: current }));
    }
  }

  // ─── Markup / selection ───────────────────────────────────────────────────

  redrawAllMarkups(): void {
    const doc = getActiveDoc();
    if (!doc) return;
    if (doc.viewMode === 'single') {
      // Only the current page is in the DOM; no need to iterate all mounted pages
      this.redrawPageMarkups(doc.currentPage);
      return;
    }
    for (const i of this.mounted) {
      this.redrawPageMarkups(i);
    }
  }

  redrawPageMarkups(pageIndex: number): void {
    const doc = getActiveDoc();
    const pv = this.pageViews.get(pageIndex);
    if (!doc || !pv) return;
    const defaults = doc.pageDefaults[pageIndex] ?? doc.pageDefaults[0]!;
    pv.redrawMarkups(doc.markups, defaults);
    const selected = getState().selectedMarkupIds;
    for (const id of selected) {
      const m = doc.markups.find((mk) => mk.id === id);
      if (m && m.pageIndex === pageIndex) {
        pv.drawSelectionHandles(m, true);
      }
    }
  }

  goToPage(index: number): void {
    updateActiveDoc((d) => ({ ...d, currentPage: index }));
    // updateActiveDoc triggers _scheduleRefresh — no manual refresh needed for single mode.
    // For continuous mode, scroll into view after the next frame.
    const doc = getActiveDoc();
    if (!doc) return;
    if (doc.viewMode === 'continuous') {
      requestAnimationFrame(() => {
        const wrapper = this.contentEl.querySelector(`[data-page="${index}"]`) as HTMLElement | null;
        if (wrapper) wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  setZoom(zoom: number, centerX?: number, centerY?: number): void {
    const doc = getActiveDoc();
    if (!doc) return;
    const oldZoom = this.getZoom();
    const newZoom = Math.max(0.1, Math.min(8, zoom));
    if (this._independentZoom) {
      // Split pane: keep our own zoom, don't touch the shared document zoom
      this._zoom = newZoom;
      this._scheduleRefresh();
    } else {
      updateActiveDoc((d) => ({ ...d, zoom: newZoom }));
    }
    // Apply scroll compensation before the RAF-batched refresh fires.
    // Only the page area scales — the CONTENT_PAD slack around it doesn't —
    // so anchor the cursor in page coordinates, not raw content coordinates.
    if (centerX != null && centerY != null) {
      const ratio = newZoom / oldZoom;
      this.scrollEl.scrollLeft =
        (centerX - CONTENT_PAD) * ratio + CONTENT_PAD - (centerX - this.scrollEl.scrollLeft);
      this.scrollEl.scrollTop =
        (centerY - CONTENT_PAD) * ratio + CONTENT_PAD - (centerY - this.scrollEl.scrollTop);
    }
  }

  fitPage(): void {
    const doc = getActiveDoc();
    if (!doc) return;
    const page = doc.pages[doc.currentPage];
    if (!page) return;
    const pad = 48;
    const scaleW = (this.scrollEl.clientWidth - pad) / page.width;
    const scaleH = (this.scrollEl.clientHeight - pad) / page.height;
    this._centerNext = true;
    this.setZoom(Math.min(scaleW, scaleH));
  }

  fit100(): void {
    this.setZoom(1);
  }

  updateCursorFromEvent(e: PointerEvent, pv: PageView): void {
    const p = pv.screenToPage(e.clientX, e.clientY);
    setCursorPagePoint(p);
  }
}
