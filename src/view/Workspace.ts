import { PageView } from './PageView';
import {
  getActiveDoc,
  getState,
  subscribe,
  updateActiveDoc,
  setCursorPagePoint,
} from '../state/store';
import { handlePointerDown, handlePointerMove, handlePointerUp, handleWheel, handleContextMenu } from '../tools/controller';

/** Pages pre-rendered on each side of the current page (fit-level zoom only). */
const PREFETCH_RADIUS = 2;
/** Prefetching neighbours is skipped above this zoom — at detail zoom the
 *  user is studying one sheet, and CAD pages are too expensive to speculate. */
const PREFETCH_MAX_ZOOM = 1.5;
/** Pages beyond this distance from current are evicted to free memory. */
const EVICT_RADIUS = 8;
/** Virtual page buffer for continuous-mode scroll. */
const BUFFER = 2;
/** Pan slack around pages — must match .workspace-content padding in main.css. */
const CONTENT_PAD = 160;
/** Idle time after the last zoom step before the expensive crisp render. */
const ZOOM_SETTLE_MS = 200;
/** Idle time after the last page flip before rendering (prefetched pages hit
 *  the bitmap cache and appear instantly regardless). */
const PAGE_SETTLE_MS = 60;
/** Idle time after scrolling before the visible-region detail re-render. */
const SCROLL_SETTLE_MS = 160;

export class Workspace {
  readonly el: HTMLDivElement;
  readonly scrollEl: HTMLDivElement;
  readonly contentEl: HTMLDivElement;
  private pageViews = new Map<number, PageView>();
  private unsub: (() => void) | null = null;
  private _lastDocId: string | null = null;
  /** The pdfDoc proxy last rendered — page insert/delete/rotate/paste replace
   *  it, and every cached page render is stale when that happens. */
  private _lastPdfDoc: unknown = null;
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
  /** Timers for the debounced crisp / detail / prefetch passes. */
  private _crispTimer: number | null = null;
  private _detailTimer: number | null = null;
  private _prefetchTimer: number | null = null;
  /** True between a zoom/page change and its settled crisp render — cheap
   *  CSS-stretched frames only, no expensive rasterizing. */
  private _settling = false;
  private _scrollRaf: number | null = null;

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
    this.contentEl.addEventListener('contextmenu', (e) => handleContextMenu(e, this));

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
    this._clearTimers();
  }

  private _clearTimers(): void {
    if (this._crispTimer !== null) clearTimeout(this._crispTimer);
    if (this._detailTimer !== null) clearTimeout(this._detailTimer);
    if (this._prefetchTimer !== null) clearTimeout(this._prefetchTimer);
    this._crispTimer = null;
    this._detailTimer = null;
    this._prefetchTimer = null;
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
    this._clearTimers();
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
      if (!pv.el.isConnected) continue;
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

    // Same document but a new pdfDoc proxy (page inserted / deleted / pasted /
    // rotated) — the cached renders are indexed by page number and stale
    if (doc.pdfDoc !== this._lastPdfDoc) {
      this._evictAll();
      this.contentEl.innerHTML = '';
      this._lastPdfDoc = doc.pdfDoc;
    }

    const zoom = this.getZoom();
    const zoomChanged = this._lastZoom !== 0 && zoom !== this._lastZoom;
    this._lastZoom = zoom;

    this.hideEmptyState();

    if (doc.viewMode === 'single') {
      this.layoutSinglePage(zoomChanged);
    } else {
      this.layoutContinuous(zoomChanged);
    }

    this.updateRegions();
    this.syncOverlays();
    this.redrawAllMarkups();

    if (this._centerNext) {
      this._centerNext = false;
      this.centerScroll();
      this.updateRegions();
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

  /** Apply the current zoom to every mounted page synchronously (CSS only) —
   *  called from setZoom so scroll compensation sees the new content size. */
  applyLayoutNow(): void {
    const doc = getActiveDoc();
    if (!doc) return;
    const zoom = this.getZoom();
    for (const [i, pv] of this.pageViews) {
      const info = doc.pages[i];
      if (info && pv.el.isConnected) pv.setLayout(info.width, info.height, zoom);
    }
  }

  // ─── Single-page mode ─────────────────────────────────────────────────────

  private layoutSinglePage(zoomChanged: boolean): void {
    const doc = getActiveDoc();
    if (!doc?.pdfDoc) return;
    const pageIndex = doc.currentPage;
    const info = doc.pages[pageIndex];
    if (!info) return;

    let pv = this.pageViews.get(pageIndex);
    if (!pv) {
      pv = new PageView(pageIndex);
      this.pageViews.set(pageIndex, pv);
    }
    pv.setLayout(info.width, info.height, this.getZoom());

    const wrapper = this.contentEl.querySelector('.page-wrapper.single');
    const displayedIndex = wrapper
      ? Number((wrapper.querySelector('.page-view') as HTMLElement | null)?.dataset.page ?? -1)
      : -1;

    if (displayedIndex !== pageIndex) {
      if (pv.hasBase() || displayedIndex === -1) {
        // Swap immediately — the new page already has pixels (prefetched) or
        // there is nothing on screen yet
        this.mountSingleWrapper(pv);
      }
      // else: keep the previous page visible; the crisp pass swaps when the
      // new page's base render lands
      this.scheduleCrisp(PAGE_SETTLE_MS);
      return;
    }

    if (!pv.hasBase()) {
      this.scheduleCrisp(0);
    } else if (zoomChanged) {
      this.scheduleCrisp(ZOOM_SETTLE_MS);
    }
  }

  private mountSingleWrapper(pv: PageView): void {
    this.contentEl.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper single';
    wrapper.appendChild(pv.el);
    this.contentEl.appendChild(wrapper);
  }

  /** The expensive pass: rasterize the current page (base + visible-region
   *  detail) and the overlays, once zooming/flipping has settled. */
  private scheduleCrisp(delay: number): void {
    this._settling = true;
    if (this._crispTimer !== null) clearTimeout(this._crispTimer);
    this._crispTimer = window.setTimeout(() => {
      this._crispTimer = null;
      void this.crispPass();
    }, delay);
  }

  private async crispPass(): Promise<void> {
    const doc = getActiveDoc();
    if (!doc?.pdfDoc) return;
    const zoom = this.getZoom();
    const targets =
      doc.viewMode === 'single' ? [doc.currentPage] : this.visiblePages();

    // Stop stale renders of pages we are not looking at
    for (const [i, pv] of this.pageViews) {
      if (!targets.includes(i)) pv.cancelRenders();
    }

    for (const pageIndex of targets) {
      const info = doc.pages[pageIndex];
      if (!info) continue;
      let pv = this.pageViews.get(pageIndex);
      if (!pv) {
        pv = new PageView(pageIndex);
        this.pageViews.set(pageIndex, pv);
      }
      pv.setLayout(info.width, info.height, zoom);
      const page = await doc.pdfDoc.getPage(pageIndex + 1);
      const ok = await pv.renderBase(page);
      if (!ok) return; // superseded — a newer pass owns the screen

      // Single mode: if this page was waiting off-screen (page flip), swap it
      // in now that it has pixels
      if (doc.viewMode === 'single') {
        const shown = this.contentEl.querySelector('.page-wrapper.single .page-view') as HTMLElement | null;
        if (Number(shown?.dataset.page ?? -1) !== pageIndex) {
          this.mountSingleWrapper(pv);
          if (this._centerNext) {
            this._centerNext = false;
            this.centerScroll();
          }
        }
      }
      this.updateRegions();
      this.redrawPageMarkups(pageIndex);
      void pv.renderDetail();
    }

    this._settling = false;
    this.syncOverlays(true);
    this.schedulePrefetch();
    const current = getActiveDoc();
    if (current) this.evictDistantPages(current.currentPage, EVICT_RADIUS);
  }

  /** Prefetch neighbour pages a beat after the current page is crisp, and
   *  only at overview zooms — CAD sheets are too heavy to speculate on while
   *  the user is zoomed into details. */
  private schedulePrefetch(): void {
    if (this._prefetchTimer !== null) clearTimeout(this._prefetchTimer);
    if (this.getZoom() > PREFETCH_MAX_ZOOM) return;
    this._prefetchTimer = window.setTimeout(async () => {
      this._prefetchTimer = null;
      const doc = getActiveDoc();
      if (!doc?.pdfDoc || doc.viewMode !== 'single' || this._settling) return;
      const zoom = this.getZoom();
      const center = doc.currentPage;
      for (let delta = 1; delta <= PREFETCH_RADIUS; delta++) {
        for (const sign of [-1, 1]) {
          const i = center + sign * delta;
          if (i < 0 || i >= doc.pageCount) continue;
          const info = doc.pages[i];
          if (!info) continue;
          let pv = this.pageViews.get(i);
          if (!pv) {
            pv = new PageView(i);
            this.pageViews.set(i, pv);
          }
          pv.setLayout(info.width, info.height, zoom);
          if (pv.hasBase() && pv.baseIsCrisp()) continue;
          if (this._settling) return; // a new zoom/page came in — stop
          const page = await doc.pdfDoc.getPage(i + 1);
          await pv.renderBase(page);
        }
      }
    }, 350);
  }

  // ─── Continuous mode ──────────────────────────────────────────────────────

  private showEmptyState(): void {
    if (this.el.querySelector('.empty-state')) return;
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    // The 16×16 pixel-art mascot, scaled 16× with hard pixel edges
    empty.innerHTML =
      '<img class="empty-mascot" src="/corgi.png" alt="" width="256" height="256">' +
      '<p>Drop a PDF here or use File → Open</p>';
    this.el.appendChild(empty);
  }

  private hideEmptyState(): void {
    this.el.querySelector('.empty-state')?.remove();
  }

  private layoutContinuous(zoomChanged: boolean): void {
    const doc = getActiveDoc();
    if (!doc) return;
    const zoom = this.getZoom();
    // Rebuild the wrapper stack only when the page list actually changed —
    // refresh() runs on every state change (cursor moves included)
    if (this.contentEl.querySelectorAll('.page-wrapper').length !== doc.pageCount) {
      this.contentEl.innerHTML = '';
      for (let i = 0; i < doc.pageCount; i++) {
        const wrapper = document.createElement('div');
        wrapper.className = 'page-wrapper';
        wrapper.dataset.page = String(i);
        const pv = this.pageViews.get(i) ?? new PageView(i);
        this.pageViews.set(i, pv);
        const info = doc.pages[i];
        if (info) pv.setLayout(info.width, info.height, zoom);
        wrapper.appendChild(pv.el);
        this.contentEl.appendChild(wrapper);
      }
      this.onScroll();
      return;
    }
    if (zoomChanged) {
      this.applyLayoutNow();
      this.scheduleCrisp(ZOOM_SETTLE_MS);
    } else {
      // Make sure visible pages have their base render
      for (const i of this.visiblePages()) {
        const pv = this.pageViews.get(i);
        if (pv && !pv.hasBase()) {
          this.scheduleCrisp(0);
          break;
        }
      }
    }
  }

  /** Page indices whose wrappers intersect the viewport (± buffer). */
  private visiblePages(): number[] {
    const doc = getActiveDoc();
    if (!doc) return [];
    if (doc.viewMode === 'single') return [doc.currentPage];
    const scrollTop = this.scrollEl.scrollTop;
    const viewH = this.scrollEl.clientHeight;
    const out: number[] = [];
    for (let i = 0; i < doc.pageCount; i++) {
      const wrapper = this.contentEl.querySelector(`.page-wrapper[data-page="${i}"]`) as HTMLElement | null;
      if (!wrapper) continue;
      const top = wrapper.offsetTop;
      const h = wrapper.offsetHeight;
      if (top + h >= scrollTop - BUFFER * h && top <= scrollTop + viewH + BUFFER * h) {
        out.push(i);
      }
    }
    return out;
  }

  private onScroll(): void {
    if (this._scrollRaf !== null) return;
    this._scrollRaf = requestAnimationFrame(() => {
      this._scrollRaf = null;
      const doc = getActiveDoc();
      if (!doc) return;

      // Keep the markup layer aligned with the viewport (cheap vector redraw)
      this.updateRegions();

      if (doc.viewMode === 'continuous') {
        // Mount/render pages entering the buffered viewport
        for (const i of this.visiblePages()) {
          const pv = this.pageViews.get(i);
          if (pv && !pv.hasBase()) {
            this.scheduleCrisp(0);
            break;
          }
        }
        this.updateCurrentPageFromScroll();
      }

      // Crisp detail for the settled viewport
      if (this._detailTimer !== null) clearTimeout(this._detailTimer);
      this._detailTimer = window.setTimeout(() => {
        this._detailTimer = null;
        if (this._settling) return;
        for (const i of this.visiblePages()) {
          const pv = this.pageViews.get(i);
          if (pv?.hasBase()) void pv.renderDetail();
        }
      }, SCROLL_SETTLE_MS);
    });
  }

  /** Recompute each mounted page's visible region; redraw markups for pages
   *  whose region moved (region redraws are cheap vector work). */
  private updateRegions(): void {
    const view = this.scrollEl.getBoundingClientRect();
    for (const [i, pv] of this.pageViews) {
      if (!pv.el.isConnected) continue;
      const r = pv.el.getBoundingClientRect();
      const changed = pv.setVisibleRegion({
        x: view.left - r.left,
        y: view.top - r.top,
        w: view.width,
        h: view.height,
      });
      if (changed) this.redrawPageMarkups(i);
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

  /** Apply the Overlay bar state: composite the chosen pages onto the current
   *  page's overlay canvas, and clear overlays everywhere else. Slot bitmaps
   *  are cached inside the PageView, so opacity/multiply tweaks and capped
   *  deep zooms recomposite without touching the PDF worker. */
  private syncOverlays(force = false): void {
    const doc = getActiveDoc();
    if (!doc?.pdfDoc) return;
    if (this._settling && !force) return; // wait for the crisp pass
    const pv = this.pageViews.get(doc.currentPage);
    const key = [
      doc.id,
      doc.currentPage,
      pv ? pv.getRenderScale().toFixed(4) : '0',
      doc.overlayEnabled,
      doc.overlayMultiply,
      JSON.stringify(doc.overlays),
    ].join('|');
    if (!force && key === this._lastOverlayKey) return;
    this._lastOverlayKey = key;
    for (const [i, view] of this.pageViews) {
      if (doc.overlayEnabled && i === doc.currentPage) {
        void view.renderOverlays(doc.pdfDoc, doc.overlays, doc.overlayMultiply);
      } else {
        view.clearOverlays();
      }
    }
  }

  private evictDistantPages(center: number, radius: number): void {
    for (const [i, pv] of this.pageViews) {
      if (Math.abs(i - center) <= radius) continue;
      pv.evict();
      // Keep views whose element is still mounted (continuous-mode wrappers)
      // so they can re-render into place; drop detached ones entirely.
      if (!pv.el.isConnected) this.pageViews.delete(i);
    }
  }

  private _evictAll(): void {
    this._clearTimers();
    this._settling = false;
    for (const pv of this.pageViews.values()) pv.evict();
    this.pageViews.clear();
  }

  // ─── Markup / selection ───────────────────────────────────────────────────

  redrawAllMarkups(): void {
    const doc = getActiveDoc();
    if (!doc) return;
    for (const [i, pv] of this.pageViews) {
      if (pv.el.isConnected) this.redrawPageMarkups(i);
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
    // Resize the layout synchronously so the scroll compensation below isn't
    // clamped against the old content size.
    this.applyLayoutNow();
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
    // The glass chrome (ribbon, side panels, bottom HUD) floats OVER the
    // canvas — fit the page into the visible region between the overlays.
    const st = getState();
    const panelW =
      (st.leftPanelVisible ? st.leftPanelWidth + 16 : 0) +
      (st.rightPanelVisible ? st.rightPanelWidth + 16 : 0);
    const ribbonH = (document.querySelector('.ribbon') as HTMLElement | null)?.offsetHeight ?? 0;
    const hudH = 44;
    const availW = Math.max(120, this.scrollEl.clientWidth - panelW - pad);
    const availH = Math.max(120, this.scrollEl.clientHeight - ribbonH - 16 - hudH - pad);
    const scaleW = availW / page.width;
    const scaleH = availH / page.height;
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
