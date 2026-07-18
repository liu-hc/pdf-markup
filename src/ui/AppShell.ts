import {
  getState,
  subscribe,
  getActiveDoc,
  setState,
  setActiveTool,
  updateActiveDoc,
  closeDocument,
  uid,
} from '../state/store';
import type { ToolId, LineStyle, Markup, BookmarkItem, OverlaySlot } from '../state/types';
import { applyPageOrder } from '../markups/order';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { ARCH_SCALES, ENG_SCALES, SWATCH_COLORS, FONT_FAMILIES, LINE_SPACING_OPTIONS, LINE_WEIGHT_OPTIONS, TEXT_SIZE_OPTIONS, AREA_DECIMAL_OPTIONS, ARROW_SIZE_OPTIONS, DEFAULT_COLOR } from '../state/types';
import type { ArrowHead } from '../state/types';
import { openFilePicker, saveDocument, flattenDocument, insertBlankPage, rotatePage, createBlankDocument, openDroppedFile, deletePage, copyPage, pastePage, hasPageClipboard } from '../pdf/loader';
import { handleEditAction } from '../tools/controller';
import { parseArchScale, parseEngScale } from '../util/geometry';
// User-guide illustrations (shared with the README)
import guideWorkspace from '../../docs/graphics/workspace.png';
import guideToolbar from '../../docs/graphics/toolbar.png';
import guideNavigate from '../../docs/graphics/navigate.svg';
import guideShapes from '../../docs/graphics/shapes.svg';
import guideAnnotate from '../../docs/graphics/annotate.svg';
import guideMeasure from '../../docs/graphics/measure.svg';
import guideOrganize from '../../docs/graphics/organize.svg';
import guideDocuments from '../../docs/graphics/documents.svg';
import guideAdvanced from '../../docs/graphics/advanced.svg';
import { formatLength, formatArea, formatAngle } from '../util/units';
import { polygonArea, polylineLength, dist, angleDegrees } from '../util/geometry';
import type { Workspace } from '../view/Workspace';

/* ── Tool icon library ─────────────────────────────────────────────────── */
const TOOL_ICONS: Record<string, string> = {
  flip: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5V3.4c0-.5.4-.9.9-.9H9.5l3.5 3.5v3.5"/><path d="M9.5 2.5V6H13"/><path d="M4 9.5v4.6c0 .5.4.9.9.9h3.6" stroke-dasharray="1.8 1.6"/><path d="M13 10a4 4 0 0 1-3 4.6"/><path d="M9 12.6l1 2 2.1-.7"/></svg>`,
  zoom: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="5"/><line x1="12" y1="12" x2="15.5" y2="15.5"/><line x1="8" y1="6" x2="8" y2="10"/><line x1="6" y1="8" x2="10" y2="8"/></svg>`,
  pan: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 8.5V4.2a1.1 1.1 0 0 1 2.2 0v3.6"/><path d="M8.7 7.4V3.4a1.1 1.1 0 0 1 2.2 0v4.4"/><path d="M10.9 7.8V4.6a1.1 1.1 0 0 1 2.2 0V9"/><path d="M13.1 7.6a1.1 1.1 0 0 1 2.2 0v3.2c0 2.6-1.7 4.7-4.6 4.7-1.8 0-3-.6-3.9-1.9L4.3 11c-.5-.8.5-1.8 1.4-1.3l.8.6V8.5"/></svg>`,
  select: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2.5v11l2.8-2.8 1.8 4.3 1.4-.6-1.8-4.3L13 10z" fill="currentColor" opacity="0.15"/><path d="M3.5 2.5v11l2.8-2.8 1.8 4.3 1.4-.6-1.8-4.3L13 10z"/></svg>`,
  rectangle: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="miter"><rect x="2.5" y="4.5" width="13" height="9"/></svg>`,
  ellipse: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="9" cy="9" rx="6.5" ry="4.5"/></svg>`,
  polygon: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="miter"><polygon points="3,6 10.5,2.5 15.5,8 12.5,15.5 4.5,13"/><circle cx="3" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="10.5" cy="2.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="12.5" cy="15.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="13" r="1.2" fill="currentColor" stroke="none"/></svg>`,
  line: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="3.5" y1="14.5" x2="14.5" y2="3.5"/><circle cx="3.5" cy="14.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="14.5" cy="3.5" r="1.5" fill="currentColor" stroke="none"/></svg>`,
  polyline: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="2.5,14 6,7 10.5,10.5 15.5,4"/><circle cx="2.5" cy="14" r="1.2" fill="currentColor" stroke="none"/><circle cx="6" cy="7" r="1.2" fill="currentColor" stroke="none"/><circle cx="10.5" cy="10.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="4" r="1.2" fill="currentColor" stroke="none"/></svg>`,
  highlighter: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.5l5.5 5.5-4.5 4.5L5.5 7z"/><path d="M5.5 7l5.5 5.5-2.2 1.7-3.6-0.4-1-2.6z" fill="#f5c542" stroke="#c9a227"/><line x1="2.5" y1="16.3" x2="12" y2="16.3" stroke="#f5c542" stroke-width="2.4"/></svg>`,
  text: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="miter"><rect x="2" y="2" width="14" height="14"/><text x="9" y="13.4" text-anchor="middle" font-size="13" font-weight="700" font-family="Arial, sans-serif" fill="currentColor" stroke="none">T</text></svg>`,
  callout: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="miter" stroke-linecap="round"><rect x="7" y="2" width="9" height="6"/><polyline points="7,5 4,5 2.5,15" fill="none"/><path d="M2.5 15 4.5 11.2 1.7 10.7Z" fill="currentColor" stroke="none"/></svg>`,
  sticky: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.5h10v10L9 16H3z"/><path d="M13 12.5l-4 3.5V12.5h4z" fill="currentColor" opacity="0.2"/><line x1="6" y1="7" x2="11" y2="7"/><line x1="6" y1="9.5" x2="9" y2="9.5"/></svg>`,
  calibrate: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><line x1="9" y1="1.6" x2="9" y2="4.2"/><circle cx="9" cy="4.5" r="1"/><line x1="8.6" y1="5.3" x2="3.4" y2="15.6"/><line x1="9.4" y1="5.3" x2="14.6" y2="15.6"/><path d="M3.4 15.6l-.6 1.1M14.6 15.6l.6 1.1"/></svg>`,
  dimension: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="7" x2="15" y2="7"/><line x1="3" y1="5.5" x2="3" y2="16"/><line x1="15" y1="5.5" x2="15" y2="16"/><line x1="1" y1="9" x2="5" y2="5"/><line x1="13" y1="9" x2="17" y2="5"/></svg>`,
  measureAngle: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="14" x2="16" y2="14"/><line x1="3" y1="14" x2="13" y2="4"/><path d="M10 14 A7 7 0 0 0 7.95 9.05" fill="none"/><circle cx="3" cy="14" r="1.2" fill="currentColor" stroke="none"/></svg>`,
  snip: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="10" height="8" stroke-dasharray="2 1.6"/><circle cx="10.6" cy="15" r="1.5"/><circle cx="14.8" cy="12.6" r="1.5"/><line x1="11.7" y1="13.9" x2="14.5" y2="8.5"/><line x1="13.6" y1="11.7" x2="9" y2="8.5"/></svg>`,
  overlay: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="8" height="10" rx="1"/><rect x="7.5" y="5.5" width="8" height="10" rx="1" fill="currentColor" opacity="0.15"/><rect x="7.5" y="5.5" width="8" height="10" rx="1"/></svg>`,
};

export function buildAppShell(workspace: Workspace, secondaryWorkspace: Workspace): HTMLElement {
  const root = document.createElement('div');
  root.className = 'app-shell';
  root.innerHTML = `
    <header class="menubar">
      <div class="app-mark"><img src="/corgi.png" alt="Markup Studio" width="26" height="26"></div>
      <nav class="menu-nav">
        <div class="menu-item" data-menu="file">File<ul class="dropdown">
          <li data-action="new">New…</li>
          <li data-action="open">Open…</li>
          <li class="sep"></li>
          <li data-action="save">Save</li>
          <li data-action="save-as">Save As…</li>
          <li class="sep"></li>
          <li data-action="close">Close Current</li>
          <li data-action="close-all">Close All</li>
        </ul></div>
        <div class="menu-item" data-menu="edit">Edit<ul class="dropdown">
          <li data-action="undo">Undo</li>
          <li data-action="redo">Redo</li>
          <li class="sep"></li>
          <li data-action="cut">Cut</li>
          <li data-action="copy">Copy</li>
          <li data-action="paste">Paste</li>
          <li data-action="paste-in-place">Paste in Place</li>
          <li data-action="duplicate">Duplicate</li>
          <li data-action="delete">Delete</li>
        </ul></div>
        <div class="menu-item" data-menu="view">View<ul class="dropdown">
          <li data-action="continuous">Continuous</li>
          <li data-action="single">Single Page</li>
          <li class="sep"></li>
          <li data-action="split-v">Split Vertical</li>
          <li data-action="split-h">Split Horizontal</li>
          <li data-action="split-none">Close Split</li>
        </ul></div>
        <div class="menu-item" data-menu="markup">Markup<ul class="dropdown">
          <li data-action="lock-page">Lock All on Current Page</li>
          <li data-action="lock-file">Lock All in Current File</li>
          <li class="sep"></li>
          <li data-action="unlock-page">Unlock All on Current Page</li>
          <li data-action="unlock-file">Unlock All in Current File</li>
          <li class="sep"></li>
          <li data-action="flatten-page">Flatten All on Current Page…</li>
          <li data-action="flatten-file">Flatten All in Current File…</li>
        </ul></div>
        <div class="menu-item" data-menu="help">Help<ul class="dropdown">
          <li data-action="help">User Guide</li>
        </ul></div>
      </nav>
      <div class="doc-tabs"></div>
      <button class="btn-save" title="Save (Ctrl+S)">Save</button>
    </header>
    <div class="main-area">
      <div class="center-column">
        <div class="viewer-stack">
          <div class="viewer-pane primary"></div>
          <div class="split-divider hidden"></div>
          <div class="viewer-pane secondary hidden">
            <button class="pane-close" title="Close viewer">✕</button>
          </div>
        </div>
      </div>
      <div class="ribbon"></div>
      <aside class="left-panel">
        <div class="panel-inner">
          <div class="panel-tabs"><button data-tab="bookmarks">Bookmarks</button><button data-tab="thumbnails" class="active">Thumbnails</button></div>
          <div class="panel-content"></div>
        </div>
        <div class="panel-resizer left-resizer" title="Drag to resize"></div>
      </aside>
      <aside class="right-panel">
        <div class="panel-resizer right-resizer" title="Drag to resize"></div>
        <div class="panel-inner">
          <div class="panel-tabs right-tabs"><button data-rtab="properties" class="active">Properties</button><button data-rtab="search">Search</button></div>
          <div class="right-tab-properties">
            <div class="panel-content properties-panel"></div>
            <div class="totals-block"></div>
            <div class="markups-list"><h4>Markups</h4><ul></ul></div>
          </div>
          <div class="right-tab-search hidden">
            <input type="search" class="search-input" placeholder="Search document…" spellcheck="false">
            <div class="search-status"></div>
            <ul class="search-results"></ul>
          </div>
        </div>
      </aside>
      <div class="canvas-hud">
        <div class="hud-scale">Scale: None</div>
        <div class="hud-page"><button class="page-prev">‹</button><span class="page-label">0/0</span><button class="page-next">›</button></div>
        <div class="hud-zoom"><button data-zoom="fit">Fit</button><button data-zoom="out">−</button><span class="zoom-label">100%</span><button data-zoom="in">+</button></div>
      </div>
      <div class="panel-peek-zone left" aria-hidden="true"></div>
      <div class="panel-peek-zone right" aria-hidden="true"></div>
      <div class="panel-edge-controls" aria-hidden="false">
        <button class="panel-toggle left-toggle" title="Toggle left panel">◀</button>
        <button class="panel-toggle right-toggle" title="Toggle right panel">▶</button>
      </div>
    </div>
    <footer class="status-bar">
      <div class="status-text"></div>
    </footer>
  `;

  wireMenus(root, workspace);
  wireRibbon(root);
  wirePanels(root, workspace);
  wireHUDs(root, workspace);
  wireDropZone(root);
  wireSearch(root, workspace);
  _rerenderChrome = () => renderChrome(root, workspace, secondaryWorkspace);
  subscribe(() => renderChrome(root, workspace, secondaryWorkspace));
  renderChrome(root, workspace, secondaryWorkspace);
  // The panels hang below the floating ribbon, whose height is only known
  // once the shell is in the DOM — re-run after mount and on window resize.
  requestAnimationFrame(() => renderChrome(root, workspace, secondaryWorkspace));
  window.addEventListener('resize', () => renderChrome(root, workspace, secondaryWorkspace));
  return root;
}

function wireMenus(root: HTMLElement, ws: Workspace): void {
  root.querySelector('.btn-save')?.addEventListener('click', () => {
    const doc = getActiveDoc();
    if (doc) saveDocument(doc.id);
  });

  root.querySelectorAll('.dropdown li[data-action]').forEach((el) => {
    el.addEventListener('click', async () => {
      const action = (el as HTMLElement).dataset.action!;
      const doc = getActiveDoc();
      switch (action) {
        case 'new':
          showNewFileDialog();
          break;
        case 'help':
          showHelpDialog();
          break;
        case 'open':
          await openFilePicker();
          break;
        case 'save':
          if (doc) await saveDocument(doc.id);
          break;
        case 'save-as':
          if (doc) await saveDocument(doc.id, true);
          break;
        case 'close':
          if (doc) await requestCloseDocument(doc.id);
          break;
        case 'close-all':
          await closeAllDocuments();
          break;
        case 'undo':
        case 'redo':
        case 'cut':
        case 'copy':
        case 'paste':
        case 'paste-in-place':
        case 'duplicate':
        case 'delete':
          handleEditAction(action);
          ws.redrawAllMarkups();
          break;
        case 'lock-page':
        case 'lock-file':
        case 'unlock-page':
        case 'unlock-file': {
          if (!doc) break;
          const locking = action.startsWith('lock');
          const pageOnly = action.endsWith('-page');
          const next = doc.markups.map((m) =>
            !pageOnly || m.pageIndex === doc.currentPage ? { ...m, locked: locking } : m,
          );
          const { applyMarkupChange } = await import('../state/undo');
          applyMarkupChange(locking ? 'Lock markups' : 'Unlock markups', next);
          // Locked markups can't stay selected
          if (locking) setState({ selectedMarkupIds: [] });
          ws.redrawAllMarkups();
          break;
        }
        case 'flatten-page': {
          if (!doc) break;
          const n = doc.markups.filter((m) => m.pageIndex === doc.currentPage).length;
          if (!n) break;
          const ok = await confirmDialog(
            'Flatten page',
            `Permanently embed ${n} markup${n === 1 ? '' : 's'} on page ${doc.currentPage + 1} into the PDF? They will no longer be editable, and this cannot be undone.`,
            'Flatten',
          );
          if (!ok) break;
          const { flattenPage } = await import('../pdf/loader');
          await flattenPage(doc.id, doc.currentPage);
          setState({ selectedMarkupIds: [] });
          (await import('../state/undo')).clearHistory();
          ws.redrawAllMarkups();
          break;
        }
        case 'flatten-file': {
          if (!doc) break;
          const n = doc.markups.length;
          if (!n) break;
          const ok = await confirmDialog(
            'Flatten file',
            `Permanently embed all ${n} markup${n === 1 ? '' : 's'} in "${doc.filename}" into the PDF? They will no longer be editable, and this cannot be undone.`,
            'Flatten',
          );
          if (!ok) break;
          await flattenDocument(doc.id);
          setState({ selectedMarkupIds: [] });
          (await import('../state/undo')).clearHistory();
          ws.redrawAllMarkups();
          break;
        }
        case 'continuous':
          updateActiveDoc((d) => ({ ...d, viewMode: 'continuous' }));
          ws.refresh();
          break;
        case 'single':
          updateActiveDoc((d) => ({ ...d, viewMode: 'single' }));
          ws.refresh();
          break;
        case 'split-v':
          updateActiveDoc((d) => ({ ...d, splitMode: 'vertical' }));
          break;
        case 'split-h':
          updateActiveDoc((d) => ({ ...d, splitMode: 'horizontal' }));
          break;
        case 'split-none':
          updateActiveDoc((d) => ({ ...d, splitMode: 'none' }));
          break;
      }
    });
  });
}

/* ── Modal dialogs (New File / Help) ───────────────────────────────────── */
function openModal(title: string, bodyHtml: string, width = 380): HTMLElement {
  document.querySelector('.modal-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-card" style="max-width:${width}px">
    <div class="modal-head"><span>${title}</span><button class="modal-close" title="Close">✕</button></div>
    <div class="modal-body">${bodyHtml}</div>
  </div>`;
  const close = (): void => overlay.remove();
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector('.modal-close')?.addEventListener('click', close);
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', esc);
    }
  });
  document.body.appendChild(overlay);
  return overlay;
}

/** Save / Don't Save / Cancel prompt for closing a dirty document. */
function askSaveBeforeClose(message: string): Promise<'save' | 'discard' | 'cancel'> {
  return new Promise((resolve) => {
    let done = false;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-card" style="max-width:400px">
      <div class="modal-head"><span>Unsaved changes</span><button class="modal-close" title="Close">✕</button></div>
      <div class="modal-body"><p style="margin:0 0 14px">${message} Save before closing?</p>
        <div class="modal-actions">
          <button class="modal-btn-ghost" data-r="cancel">Cancel</button>
          <button class="modal-btn-ghost" data-r="discard">Don't Save</button>
          <button class="modal-btn" data-r="save">Save</button>
        </div></div></div>`;
    const finish = (r: 'save' | 'discard' | 'cancel'): void => {
      if (done) return;
      done = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(r);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish('cancel');
    };
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) finish('cancel');
    });
    overlay.querySelector('.modal-close')?.addEventListener('click', () => finish('cancel'));
    overlay.querySelectorAll<HTMLElement>('[data-r]').forEach((b) =>
      b.addEventListener('click', () => finish(b.dataset.r as 'save' | 'discard' | 'cancel')),
    );
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  });
}

/** Simple OK/Cancel confirmation modal. Resolves true when confirmed. */
function confirmDialog(title: string, message: string, confirmLabel = 'OK'): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-card" style="max-width:420px">
      <div class="modal-head"><span>${title}</span><button class="modal-close" title="Close">✕</button></div>
      <div class="modal-body"><p style="margin:0 0 14px">${message}</p>
        <div class="modal-actions">
          <button class="modal-btn-ghost" data-r="no">Cancel</button>
          <button class="modal-btn" data-r="yes">${confirmLabel}</button>
        </div></div></div>`;
    const finish = (r: boolean): void => {
      if (done) return;
      done = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(r);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish(false);
    };
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) finish(false);
    });
    overlay.querySelector('.modal-close')?.addEventListener('click', () => finish(false));
    overlay.querySelectorAll<HTMLElement>('[data-r]').forEach((b) =>
      b.addEventListener('click', () => finish(b.dataset.r === 'yes')),
    );
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  });
}

/** Close a document, prompting to save first if it has unsaved changes (the
 *  doc is only marked dirty by edits — navigation after a save won't prompt).
 *  Returns false if the user cancelled. */
async function requestCloseDocument(docId: string): Promise<boolean> {
  const doc = getState().documents.find((d) => d.id === docId);
  if (!doc) return true;
  if (doc.dirty) {
    const choice = await askSaveBeforeClose(`"${doc.filename}" has unsaved changes.`);
    if (choice === 'cancel') return false;
    if (choice === 'save') {
      try {
        await saveDocument(docId);
      } catch {
        return false; // save dialog cancelled — keep the document open
      }
      if (getState().documents.find((d) => d.id === docId)?.dirty) return false;
    }
  }
  closeDocument(docId);
  return true;
}

/** Close every open document, prompting per dirty document. Stops on cancel. */
async function closeAllDocuments(): Promise<void> {
  for (const id of getState().documents.map((d) => d.id)) {
    const ok = await requestCloseDocument(id);
    if (!ok) return;
  }
}

/** New blank document: paper size, page count, orientation. */
const NEW_FILE_SIZES: { key: string; label: string }[] = [
  { key: '8.5 x 11', label: '8.5 × 11 (Letter)' },
  { key: '11 x 17', label: '11 × 17 (Tabloid)' },
  { key: 'ARCH C', label: 'ARCH C (18 × 24)' },
  { key: 'ARCH D', label: 'ARCH D (24 × 36)' },
  { key: 'ARCH E1', label: 'ARCH E1 (30 × 42)' },
  { key: 'ARCH E', label: 'ARCH E (36 × 48)' },
];

function showNewFileDialog(): void {
  const overlay = openModal(
    'New document',
    `<label class="modal-field">Paper size
      <select class="nf-size">${NEW_FILE_SIZES.map((s) => `<option value="${s.key}">${s.label}</option>`).join('')}</select></label>
    <label class="modal-field">Orientation
      <select class="nf-orient"><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
    <label class="modal-field">Pages
      <input type="number" class="nf-pages" min="1" max="500" step="1" value="1"></label>
    <div class="modal-actions"><button class="modal-btn nf-create">Create</button></div>`,
  );
  overlay.querySelector('.nf-create')?.addEventListener('click', async () => {
    const size = (overlay.querySelector('.nf-size') as HTMLSelectElement).value;
    const landscape = (overlay.querySelector('.nf-orient') as HTMLSelectElement).value === 'landscape';
    const pages = Number((overlay.querySelector('.nf-pages') as HTMLInputElement).value) || 1;
    overlay.remove();
    await createBlankDocument(size, pages, landscape);
  });
}

/** The full illustrated user guide (mirrors the README). */
function showHelpDialog(): void {
  const fig = (src: string, alt: string): string =>
    `<figure class="help-fig"><img src="${src}" alt="${alt}"></figure>`;

  const body = `
    <p class="help-intro">Markup Studio is a browser PDF viewer &amp; markup tool for architectural and engineering drawings. Open or create a PDF, pick a tool from the glass ribbon, and draw on the sheet — then File ▸ Save writes the markups back into the PDF. Everything runs locally: your drawings never leave your machine.</p>

    <div class="help-section"><h4>The workspace</h4>
      ${fig(guideWorkspace, 'The Markup Studio workspace')}
      <ol class="help-legend">
        <li><strong>Menu bar</strong> — File / Edit / View / Markup / Help, document tabs (the highlighted tab with the green dot is the current file), Save</li>
        <li><strong>Canvas</strong> — the sheet fills the window and scrolls under the glass chrome</li>
        <li><strong>Glass ribbon</strong> — every tool plus the per-page defaults</li>
        <li><strong>Document rail</strong> — page thumbnails and bookmarks</li>
        <li><strong>Inspector</strong> — properties of the selected markup, totals, markups list</li>
        <li><strong>Canvas HUD</strong> — scale chip · page navigation · fit / zoom</li>
        <li><strong>Status bar</strong> — active tool, calibration, cursor position, markup count, sheet size</li>
      </ol>
      <p>The toolbar up close — tool groups on the left; page defaults (text size, line weight, line style, scale, and the Line / Fill / Text colors applied to new markups) on the right:</p>
      ${fig(guideToolbar, 'The toolbar')}
    </div>

    <div class="help-section"><h4>Navigate</h4>
      ${fig(guideNavigate, 'Navigation tools: Flip, Pan, Zoom, Select')}
      <ul>
        <li><strong>Flip (F)</strong> pages through the set — the scroll wheel turns pages.</li>
        <li><strong>Pan (H)</strong> grabs the sheet; middle-drag (or Alt-drag) pans on <em>any</em> tool.</li>
        <li><strong>Zoom Page (Z)</strong> zooms with the wheel at the cursor; a double middle-click snaps back to 100%.</li>
        <li><strong>Select</strong> is the editing tool: click a markup to select it, drag its body to move, drag the 8 handles to resize, and drag the corner-outside handles to rotate rectangles and ellipses. Double-click text markups to edit them.</li>
      </ul>
      <p>After you finish drawing a markup, the app automatically returns to the last navigation tool you used.</p>
    </div>

    <div class="help-section"><h4>Shapes</h4>
      ${fig(guideShapes, 'Shape tools: rectangle, ellipse, polygon, revision cloud, line, polyline, highlighter')}
      <ul>
        <li><strong>Rectangle (R) / Ellipse (O)</strong> — two clicks place opposite corners, with live preview. Both support infill, rotation, and line weight/style.</li>
        <li><strong>Polygon (Shift+P)</strong> — click each vertex; double-click or click the start point to close. Toggle a centered <strong>area label</strong> in the inspector.</li>
        <li><strong>Revision cloud</strong> — hold Shift when closing a polygon to turn its edges into arc scallops.</li>
        <li><strong>Line (L) / Polyline (P)</strong> — Shift locks segments orthogonal. Start/end arrowheads are 1:1 triangles adjustable from 25% to 800% of line weight.</li>
        <li><strong>Highlighter</strong> — over PDF text it snaps line-by-line to the text run; over blank drawing areas it free-draws a fat translucent marker.</li>
      </ul>
      <p>All shapes pick up the page defaults (color, weight, line style) from the ribbon, and each one can be overridden afterwards in the inspector.</p>
    </div>

    <div class="help-section"><h4>Annotate</h4>
      ${fig(guideAnnotate, 'Annotation tools: text box, callout, sticky note')}
      <ul>
        <li><strong>Text (T)</strong> — two clicks size the box, then type directly on the sheet. The box <strong>border</strong> uses the Line color, the glyphs use the <strong>Text</strong> color, and the background uses the <strong>Infill</strong> color — all three independent.</li>
        <li><strong>Callout (Q)</strong> — two clicks: arrow tip → text box, then type. The leader exits the box horizontally (default 25pt flat run) and bends at the elbow, which keeps its own drag handle for adjusting the distance.</li>
        <li><strong>Sticky note</strong> — a folded-corner note icon whose comment text stays off the drawing; double-click to edit.</li>
      </ul>
    </div>

    <div class="help-section"><h4>Measure</h4>
      ${fig(guideMeasure, 'Measurement tools: calibrate, dimension, angle')}
      <ul>
        <li><strong>Calibrate</strong> — click two points across a known distance and type its real-world length; this sets the page <strong>scale</strong>. You can also pick a preset (architectural <code>1/4" = 1'-0"</code> … or engineering <code>1" = 100'</code>) in the ribbon.</li>
        <li><strong>Dimension (D)</strong> — click the two measured points, then a third click pulls the dimension line away to an offset. Architectural slash ticks or arrows, optional round-up (¼", 1", 6", 1'), and the value always reads parallel to the line.</li>
        <li><strong>Angle</strong> — three clicks measure and label an angle.</li>
        <li>Per-page <strong>Totals</strong> (linear, polyline, area) accumulate in the inspector.</li>
      </ul>
    </div>

    <div class="help-section"><h4>Properties &amp; organizing</h4>
      ${fig(guideOrganize, 'Inspector: per-markup properties, markups list with drag reordering, editing shortcuts')}
      <ul>
        <li>Selecting a markup opens its properties: <strong>Line / Infill / Text colors</strong> (each overriding the page defaults independently), weight, line style, opacity, rotation, arrows, fonts, and measurement options.</li>
        <li>The <strong>Markups list</strong> shows every markup on the page — color dot, type, and the markup's text abbreviated to its first and last letters. Click to select; <strong>drag rows to change the draw order</strong>, guided by a glowing insertion line.</li>
        <li><strong>Lock</strong> — the padlock at the end of each row (or <strong>Markup ▸ Lock All…</strong>) reversibly "flattens" a markup: it stays drawn in its draw-order slot but can't be selected, moved or edited until unlocked.</li>
        <li><strong>Flatten</strong> — <strong>Markup ▸ Flatten All on Current Page / in Current File</strong> permanently embeds markups into the PDF. They disappear from the markups list and cannot be recovered, so a confirmation is asked first.</li>
        <li>Full editing everywhere: undo/redo history, cut/copy/paste, paste-in-place, duplicate — every gesture is exactly one undo step.</li>
      </ul>
    </div>

    <div class="help-section"><h4>Documents: open → save → reopen</h4>
      ${fig(guideDocuments, 'Document lifecycle: open, mark up, save, reopen editable, or flatten')}
      <p>Saving writes the markups into the PDF itself — both as visible vector content and as recoverable metadata — so a saved file <strong>reopens with every markup still editable</strong>. Use <strong>Markup ▸ Flatten All…</strong> to bake markups permanently into the page instead. Saving writes in place where the browser allows it (with Save As and download fallbacks). Images (JPG/PNG) open wrapped in a single PDF page.</p>
    </div>

    <div class="help-section"><h4>Advanced</h4>
      ${fig(guideAdvanced, 'Advanced: split view, page overlay, snip')}
      <ul>
        <li><strong>Split view</strong> — duplicate the active page in a second pane (vertical or horizontal) with its own independent zoom; drag the divider to resize.</li>
        <li><strong>Overlay</strong> — composite up to two other pages over the current one with per-slot opacity and an optional Photoshop-style Multiply blend — ideal for comparing revisions.</li>
        <li><strong>Snip (S)</strong> — drag a region to copy that patch of page <em>plus its markups</em> to the clipboard; Ctrl+V pastes it at the cursor.</li>
        <li>Right-click a thumbnail to manage pages: <strong>Add New…</strong> (pick a paper size and orientation, insert before or after), <strong>Copy</strong> the page, <strong>Paste Before / Paste After</strong> (the copy carries the page content <em>and its markups</em> — even into another open document), <strong>Delete</strong>, or <strong>rotate</strong>.</li>
      </ul>
    </div>

    <div class="help-section"><h4>Keyboard shortcuts</h4>
      <table class="help-keys">
        <tr><td><code>F</code> <code>H</code> <code>Z</code></td><td>Flip / Pan / Zoom Page</td></tr>
        <tr><td><code>R</code> <code>O</code> <code>Shift+P</code> <code>L</code> <code>P</code></td><td>Rectangle / Ellipse / Polygon / Line / Polyline</td></tr>
        <tr><td><code>T</code> <code>Q</code> <code>D</code> <code>S</code></td><td>Text / Callout / Dimension / Snip</td></tr>
        <tr><td><code>Ctrl/⌘ S</code></td><td>Save</td></tr>
        <tr><td><code>Ctrl/⌘ Z</code> · <code>Shift+Z</code> / <code>Ctrl+Y</code></td><td>Undo · Redo</td></tr>
        <tr><td><code>Ctrl/⌘ X · C · V</code></td><td>Cut · Copy · Paste</td></tr>
        <tr><td><code>Ctrl/⌘ Shift V</code></td><td>Paste in place</td></tr>
        <tr><td><code>Enter</code> / <code>Esc</code></td><td>Finish / cancel an in-progress shape</td></tr>
        <tr><td><code>Delete</code></td><td>Remove selection</td></tr>
        <tr><td><code>Shift</code> (while drawing)</td><td>Lock orthogonal / revision cloud on close</td></tr>
      </table>
    </div>`;
  openModal('User guide', body, 720);
}

function wireRibbon(root: HTMLElement): void {
  const ribbon = root.querySelector('.ribbon')!;
  const groups: { label: string; tools: { id: ToolId; label: string; key?: string }[] }[] = [
    {
      label: 'Navigate',
      tools: [
        { id: 'flip', label: 'Flip', key: 'F' },
        { id: 'pan', label: 'Pan', key: 'H' },
        { id: 'zoom', label: 'Zoom Page', key: 'Z' },
        { id: 'select', label: 'Select' },
      ],
    },
    {
      label: 'Shapes',
      tools: [
        { id: 'rectangle', label: 'Rectangle', key: 'R' },
        { id: 'ellipse', label: 'Ellipse', key: 'O' },
        { id: 'polygon', label: 'Polygon', key: 'Shift+P' },
        { id: 'line', label: 'Line', key: 'L' },
        { id: 'polyline', label: 'Polyline', key: 'P' },
        { id: 'highlighter', label: 'Highlight' },
      ],
    },
    {
      label: 'Annotation',
      tools: [
        { id: 'text', label: 'Text', key: 'T' },
        { id: 'callout', label: 'Callout', key: 'Q' },
      ],
    },
    {
      label: 'Measure',
      tools: [
        { id: 'calibrate', label: 'Calibrate' },
        { id: 'dimension', label: 'Dimension', key: 'D' },
        { id: 'measureAngle', label: 'Angle' },
      ],
    },
  ];

  for (const g of groups) {
    const group = document.createElement('div');
    group.className = 'ribbon-group';
    group.innerHTML = `<span class="ribbon-label">${g.label}</span>`;
    const tools = document.createElement('div');
    tools.className = 'ribbon-tools';
    for (const t of g.tools) {
      const btn = document.createElement('button');
      btn.className = 'tool-btn';
      btn.dataset.tool = t.id;
      btn.dataset.tip = t.key ? `${t.label}  ·  ${t.key}` : t.label;
      btn.innerHTML = TOOL_ICONS[t.id] ?? `<span style="font-size:10px;font-weight:600">${t.label.slice(0, 2)}</span>`;
      btn.addEventListener('click', () => setActiveTool(t.id));
      tools.appendChild(btn);
    }
    group.appendChild(tools);
    ribbon.appendChild(group);
  }

  // Overlay group — Overlay + Snip icon buttons, following the Measure tools
  const editGroup = document.createElement('div');
  editGroup.className = 'ribbon-group';
  editGroup.innerHTML = `<span class="ribbon-label">Overlay</span>`;
  const editTools = document.createElement('div');
  editTools.className = 'ribbon-tools';

  const overlayBtn = document.createElement('button');
  overlayBtn.className = 'tool-btn btn-overlay';
  overlayBtn.dataset.tip = 'Toggle Overlay';
  overlayBtn.innerHTML = TOOL_ICONS.overlay ?? '';

  const snipBtn = document.createElement('button');
  snipBtn.className = 'tool-btn btn-snip';
  snipBtn.dataset.tool = 'snip';
  snipBtn.dataset.tip = 'Snip Region  ·  S';
  snipBtn.innerHTML = TOOL_ICONS.snip ?? '';

  editTools.append(overlayBtn, snipBtn);
  editGroup.appendChild(editTools);
  ribbon.appendChild(editGroup);

  const pageGroup = document.createElement('div');
  pageGroup.className = 'ribbon-group page-defaults';
  const pd = document.createElement('div');
  pd.className = 'page-default-controls';
  // Order: Text (size), Weight, Style, Scale, Line / Fill / Text colors
  pd.innerHTML = `
    <label>Text <select class="text-size">${TEXT_SIZE_OPTIONS.map((s) => `<option value="${s}" ${s === 12 ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
    <label>Weight <select class="line-weight">${LINE_WEIGHT_OPTIONS.map((w) => `<option value="${w}" ${w === 1 ? 'selected' : ''}>${w}</option>`).join('')}<option value="custom">Custom…</option></select></label>
    <label>Style <select class="line-style"><option value="solid">Solid</option><option value="dashed">Dash 1</option><option value="dotted">Dash 2</option><option value="centerline">Centerline</option><option value="cloud">Cloud</option></select></label>
    <label>Scale <select class="scale-select"><option>None</option>${ARCH_SCALES.map((s) => `<option>${s}</option>`).join('')}${ENG_SCALES.map((s) => `<option>${s}</option>`).join('')}<option value="Custom">Custom…</option></select></label>
    <label>Line <button type="button" class="color-box stroke-color" title="Line color"></button></label>
    <label>Fill <button type="button" class="color-box fill-color" title="Fill color"></button></label>
    <label>Text <button type="button" class="color-box text-color" title="Text color"></button></label>
  `;

  pageGroup.appendChild(pd);
  ribbon.appendChild(pageGroup);

  // Overlay controls live in the ribbon: on the same row after the color
  // boxes when there's room, wrapping to the next ribbon row when not.
  const overlayGroup = document.createElement('div');
  overlayGroup.className = 'ribbon-group overlay-bar hidden';
  overlayGroup.innerHTML = `<span class="ribbon-label">Overlay</span><div class="overlay-controls"></div>`;
  ribbon.appendChild(overlayGroup);

  pd.querySelector('.scale-select')?.addEventListener('change', (e) => {
    const label = (e.target as HTMLSelectElement).value;
    if (label === 'Custom') {
      const input = prompt('Enter scale factor — real-world inches per PDF inch\n(e.g. 48 for 1/4"=1\'-0", 12 for 1"=1\'-0", 120 for 1"=10\')');
      const factor = input ? Number(input) : NaN;
      if (!isNaN(factor) && factor > 0) {
        updateActiveDoc((d) => {
          const defaults = [...d.pageDefaults];
          defaults[d.currentPage] = { ...defaults[d.currentPage]!, scaleLabel: 'Custom', scaleFactor: factor };
          return { ...d, pageDefaults: defaults, dirty: true };
        });
      }
      return;
    }
    updateActiveDoc((d) => {
      const defaults = [...d.pageDefaults];
      const idx = d.currentPage;
      const factor: number | null = label === 'None' ? null : (parseArchScale(label) ?? parseEngScale(label) ?? null);
      defaults[idx] = { ...defaults[idx]!, scaleLabel: label, scaleFactor: factor };
      return { ...d, pageDefaults: defaults, dirty: true };
    });
  });

  // Page-default color boxes open a palette popup (standard swatches + native
  // "More colors…"), matching the property-panel palette.
  const setPageColor = (key: 'strokeColor' | 'fillColor' | 'textColor', color: string): void => {
    updateActiveDoc((d) => {
      const defs = [...d.pageDefaults];
      defs[d.currentPage] = { ...defs[d.currentPage]!, [key]: color };
      return { ...d, pageDefaults: defs, dirty: true };
    });
  };
  const wirePdColor = (cls: string, key: 'strokeColor' | 'fillColor' | 'textColor'): void => {
    const btn = pd.querySelector<HTMLButtonElement>(`.${cls}`);
    btn?.addEventListener('click', () => {
      const cur = getActiveDoc()?.pageDefaults[getActiveDoc()!.currentPage]?.[key] ?? DEFAULT_COLOR;
      openSwatchPopup(btn, cur ?? DEFAULT_COLOR, (color) => {
        setPageColor(key, color);
        btn.style.backgroundColor = color;
      });
    });
  };
  wirePdColor('stroke-color', 'strokeColor');
  wirePdColor('fill-color', 'fillColor');
  wirePdColor('text-color', 'textColor');

  pd.querySelector('.text-size')?.addEventListener('change', (e) => {
    const size = Number((e.target as HTMLSelectElement).value);
    if (!Number.isFinite(size) || size < 1) return;
    updateActiveDoc((d) => {
      const defs = [...d.pageDefaults];
      defs[d.currentPage] = { ...defs[d.currentPage]!, fontSize: size };
      return { ...d, pageDefaults: defs, dirty: true };
    });
  });

  pd.querySelector('.line-weight')?.addEventListener('change', (e) => {
    const sel = e.target as HTMLSelectElement;
    let weight: number;
    if (sel.value === 'custom') {
      const entered = prompt('Line weight (pt)', '1');
      weight = entered ? Number(entered) : NaN;
      if (!Number.isFinite(weight) || weight <= 0) {
        // Restore the current value on cancel/invalid input
        const cur = getActiveDoc()?.pageDefaults[getActiveDoc()!.currentPage]?.lineWeight ?? 1;
        sel.value = LINE_WEIGHT_OPTIONS.includes(cur) ? String(cur) : 'custom';
        return;
      }
    } else {
      weight = Number(sel.value);
    }
    updateActiveDoc((d) => {
      const defs = [...d.pageDefaults];
      defs[d.currentPage] = { ...defs[d.currentPage]!, lineWeight: weight };
      return { ...d, pageDefaults: defs, dirty: true };
    });
  });

  pd.querySelector('.line-style')?.addEventListener('change', (e) => {
    const style = (e.target as HTMLSelectElement).value as LineStyle;
    updateActiveDoc((d) => {
      const defs = [...d.pageDefaults];
      defs[d.currentPage] = { ...defs[d.currentPage]!, lineStyle: style };
      return { ...d, pageDefaults: defs, dirty: true };
    });
  });

  overlayBtn.addEventListener('click', () => {
    // Visibility + contents derive from state in renderChrome
    updateActiveDoc((d) => ({ ...d, overlayEnabled: !d.overlayEnabled }));
  });

  snipBtn.addEventListener('click', () => setActiveTool('snip'));
}

/* ── Bookmarks panel ───────────────────────────────────────────────────────
   User bookmarks, one level of foldable groups. Right-click adds bookmarks
   (current page) and groups; rows drag to reorder, and dropping a bookmark
   onto a group header files it inside. Saved with the PDF metadata. */

const BM_ICON = `<svg width="11" height="12" viewBox="0 0 11 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2 1.5h7v9.5L5.5 8.6 2 11z"/></svg>`;
const GROUP_ICON = `<svg width="12" height="11" viewBox="0 0 12 11" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M1.5 2.5h3l1 1.4h5v5.6h-9z"/></svg>`;

function setBookmarks(next: BookmarkItem[]): void {
  updateActiveDoc((d) => ({ ...d, bookmarks: next, dirty: true }));
}

function renameBookmark(id: string, title: string): void {
  const d = getActiveDoc();
  if (!d || !title.trim()) return;
  const t = title.trim();
  setBookmarks(
    d.bookmarks.map((b) =>
      b.id === id
        ? { ...b, title: t }
        : b.children?.some((c) => c.id === id)
          ? { ...b, children: b.children.map((c) => (c.id === id ? { ...c, title: t } : c)) }
          : b,
    ),
  );
}

/** Detects the second quick click on the same row (manual — the DOM row can
 *  be rebuilt between clicks, which resets the browser's own counter). */
let _bmLastClick = { id: '', time: 0 };

/** Swap a bookmark/group row's title for an in-place rename input. */
function startBookmarkRename(id: string): void {
  const row = document.querySelector(`.bm-row[data-id="${id}"]`) as HTMLElement | null;
  const titleEl = row?.querySelector('.bm-title') as HTMLElement | null;
  if (!row || !titleEl || row.querySelector('.bm-rename-input')) return;
  const old = titleEl.textContent ?? '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'bm-rename-input';
  input.value = old;
  titleEl.replaceWith(input);
  // Keep row drag/click and global shortcuts away from the input
  for (const ev of ['pointerdown', 'pointerup', 'pointermove', 'dblclick', 'contextmenu']) {
    input.addEventListener(ev, (e) => e.stopPropagation());
  }
  let done = false;
  const finish = (commit: boolean): void => {
    if (done) return;
    done = true;
    const value = input.value;
    // Swap the title span back FIRST — panel rebuilds are suppressed while a
    // rename input exists, so a lingering input would freeze the whole tree
    const span = document.createElement('span');
    span.className = 'bm-title';
    span.textContent = commit && value.trim() ? value.trim() : old;
    input.replaceWith(span);
    if (commit && value.trim() && value.trim() !== old) {
      renameBookmark(id, value); // state change re-renders the panel
    } else {
      _rerenderChrome?.(); // restore the plain title row
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.focus();
  input.select();
}

/** Remove `id` from the (2-level) bookmark tree. Returns [next, removed]. */
function removeBookmarkById(items: BookmarkItem[], id: string): [BookmarkItem[], BookmarkItem | null] {
  let removed: BookmarkItem | null = null;
  const next: BookmarkItem[] = [];
  for (const it of items) {
    if (it.id === id) {
      removed = it;
      continue;
    }
    if (it.children?.some((c) => c.id === id)) {
      removed = it.children.find((c) => c.id === id)!;
      next.push({ ...it, children: it.children.filter((c) => c.id !== id) });
      continue;
    }
    next.push(it);
  }
  return [next, removed];
}

function renderBookmarksPanel(content: HTMLElement, ws: Workspace): void {
  // Never rebuild the tree out from under an active in-place rename
  if (content.querySelector('.bm-rename-input')) return;
  const doc = getActiveDoc();
  content.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'bm-panel';
  content.appendChild(wrap);

  if (!doc) {
    wrap.innerHTML = '<p class="muted">Open a document to add bookmarks.</p>';
    return;
  }

  interface BmRow {
    item: BookmarkItem;
    parentId: string | null;
    el: HTMLElement;
  }
  const rows: BmRow[] = [];

  const makeRow = (item: BookmarkItem, parentId: string | null): HTMLElement => {
    const isGroup = item.pageIndex === undefined;
    const row = document.createElement('div');
    row.className = 'bm-row' + (isGroup ? ' bm-group' : '') + (parentId ? ' bm-child' : '');
    row.dataset.id = item.id;
    if (isGroup) {
      const caret = document.createElement('span');
      caret.className = 'bm-caret';
      caret.textContent = item.collapsed ? '▸' : '▾';
      row.appendChild(caret);
    }
    const icon = document.createElement('span');
    icon.className = 'bm-icon';
    icon.innerHTML = isGroup ? GROUP_ICON : BM_ICON;
    const title = document.createElement('span');
    title.className = 'bm-title';
    title.textContent = item.title;
    row.append(icon, title);
    if (!isGroup) {
      const page = document.createElement('span');
      page.className = 'bm-page';
      page.textContent = `p.${(item.pageIndex ?? 0) + 1}`;
      row.appendChild(page);
    }
    rows.push({ item, parentId, el: row });
    wireBookmarkRow(row, item, isGroup, ws, rows, wrap);
    return row;
  };

  if (!doc.bookmarks.length) {
    wrap.innerHTML = '<p class="muted bm-hint">Right-click to add a bookmark for the current page.</p>';
  }
  for (const item of doc.bookmarks) {
    wrap.appendChild(makeRow(item, null));
    if (item.children && !item.collapsed) {
      for (const child of item.children) wrap.appendChild(makeRow(child, item.id));
    }
  }

  // Right-click: on a row → item menu; on empty space → add menu
  content.oncontextmenu = (e) => {
    e.preventDefault();
    const rowEl = (e.target as HTMLElement).closest('.bm-row') as HTMLElement | null;
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    if (rowEl) {
      menu.innerHTML = `
        <button data-action="rename">Rename…</button>
        <button data-action="delete">Delete</button>`;
    } else {
      menu.innerHTML = `
        <button data-action="add-bookmark">Add Bookmark to Current Page</button>
        <button data-action="add-group">Add Group</button>`;
    }
    document.body.appendChild(menu);
    const close = (): void => menu.remove();
    menu.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action!;
        const d = getActiveDoc();
        if (!d) return close();
        if (action === 'add-bookmark') {
          setBookmarks([
            ...d.bookmarks,
            { id: uid(), title: `Page ${d.currentPage + 1}`, pageIndex: d.currentPage },
          ]);
        } else if (action === 'add-group') {
          const n = d.bookmarks.filter((b) => b.pageIndex === undefined).length + 1;
          setBookmarks([...d.bookmarks, { id: uid(), title: `Group ${n}`, children: [], collapsed: false }]);
        } else if (rowEl) {
          const id = rowEl.dataset.id!;
          if (action === 'rename') {
            // In-place rename — start it after the menu has closed
            close();
            requestAnimationFrame(() => startBookmarkRename(id));
            return;
          } else if (action === 'delete') {
            const [next] = removeBookmarkById(d.bookmarks, id);
            setBookmarks(next);
          }
        }
        close();
      });
    });
    setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
  };
}

/** Row interactions: click navigates / folds; drag reorders, and dropping a
 *  page bookmark onto a group header files it into that group. */
function wireBookmarkRow(
  row: HTMLElement,
  item: BookmarkItem,
  isGroup: boolean,
  ws: Workspace,
  rows: { item: BookmarkItem; parentId: string | null; el: HTMLElement }[],
  container: HTMLElement,
): void {
  row.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const startY = e.clientY;
    let dragging = false;
    let clone: HTMLElement | null = null;
    let line: HTMLElement | null = null;
    let hoverGroup: HTMLElement | null = null;

    const others = (): typeof rows =>
      rows.filter((r) => r.item.id !== item.id && !(isGroup && r.parentId === item.id));

    /** Insertion anchor (the row the drag would land before) + line position. */
    const updateDrop = (clientY: number): { anchor: (typeof rows)[number] | null; intoGroup: string | null } => {
      hoverGroup?.classList.remove('bm-drop-target');
      hoverGroup = null;
      const list = others();
      const cRect = container.getBoundingClientRect();
      // Hovering the middle of a group header files the bookmark inside it
      if (!isGroup) {
        for (const r of list) {
          if (r.item.pageIndex !== undefined) continue;
          const rr = r.el.getBoundingClientRect();
          if (clientY > rr.top + rr.height * 0.3 && clientY < rr.bottom - rr.height * 0.3) {
            hoverGroup = r.el;
            r.el.classList.add('bm-drop-target');
            if (line) line.style.display = 'none';
            return { anchor: null, intoGroup: r.item.id };
          }
        }
      }
      let anchor: (typeof rows)[number] | null = null;
      let top = 0;
      for (const r of list) {
        const rr = r.el.getBoundingClientRect();
        if (clientY < rr.top + rr.height / 2) {
          anchor = r;
          top = rr.top - cRect.top + container.scrollTop;
          break;
        }
      }
      if (!anchor && list.length) {
        const last = list[list.length - 1]!.el.getBoundingClientRect();
        top = last.bottom - cRect.top + container.scrollTop;
      }
      if (line) {
        line.style.display = '';
        line.style.top = `${top}px`;
      }
      return { anchor, intoGroup: null };
    };

    const onMove = (ev: PointerEvent): void => {
      if (!dragging && Math.abs(ev.clientY - startY) > 5) {
        dragging = true;
        row.classList.add('bm-dragging');
        clone = row.cloneNode(true) as HTMLElement;
        clone.classList.add('bm-clone');
        clone.style.width = `${row.offsetWidth}px`;
        document.body.appendChild(clone);
        line = document.createElement('div');
        line.className = 'bm-drop-line';
        container.appendChild(line);
      }
      if (dragging && clone) {
        const r = row.getBoundingClientRect();
        clone.style.left = `${r.left}px`;
        clone.style.top = `${ev.clientY - r.height / 2}px`;
        updateDrop(ev.clientY);
      }
    };

    const onUp = (ev: PointerEvent): void => {
      try { row.releasePointerCapture(ev.pointerId); } catch { /* best effort */ }
      row.removeEventListener('pointermove', onMove);
      row.removeEventListener('pointerup', onUp);
      hoverGroup?.classList.remove('bm-drop-target');
      if (!dragging) {
        // Second quick click on the same row → rename in place (manual
        // double-click detection: the row DOM may rebuild between clicks)
        const now = performance.now();
        const isDouble = _bmLastClick.id === item.id && now - _bmLastClick.time < 400;
        _bmLastClick = { id: item.id, time: now };
        if (isDouble) {
          startBookmarkRename(item.id);
          return;
        }
        // Plain click: navigate to a bookmark, fold/unfold a group
        const d = getActiveDoc();
        if (!d) return;
        if (isGroup) {
          setBookmarks(d.bookmarks.map((b) => (b.id === item.id ? { ...b, collapsed: !b.collapsed } : b)));
        } else if (item.pageIndex !== undefined) {
          ws.goToPage(Math.min(item.pageIndex, d.pageCount - 1));
        }
        return;
      }
      const target = updateDrop(ev.clientY);
      row.classList.remove('bm-dragging');
      clone?.remove();
      line?.remove();
      const d = getActiveDoc();
      if (!d) return;
      let [next, moved] = removeBookmarkById(d.bookmarks, item.id);
      if (!moved) return;
      if (target.intoGroup) {
        next = next.map((b) =>
          b.id === target.intoGroup ? { ...b, collapsed: false, children: [...(b.children ?? []), moved!] } : b,
        );
      } else if (!target.anchor) {
        next = [...next, moved];
      } else {
        // Groups always land at the top level; bookmarks join the anchor's level
        const parentId = isGroup ? null : target.anchor.parentId;
        const anchorId = parentId === target.anchor.parentId ? target.anchor.item.id : null;
        if (parentId) {
          next = next.map((b) => {
            if (b.id !== parentId) return b;
            const kids = [...(b.children ?? [])];
            const at = anchorId ? kids.findIndex((c) => c.id === anchorId) : kids.length;
            kids.splice(at === -1 ? kids.length : at, 0, moved!);
            return { ...b, children: kids };
          });
        } else {
          // Anchor may live inside a group — insert before that group instead
          const topAnchorId = target.anchor.parentId ?? target.anchor.item.id;
          const at = next.findIndex((b) => b.id === topAnchorId);
          next.splice(at === -1 ? next.length : at, 0, moved);
        }
      }
      setBookmarks(next);
    };

    try { row.setPointerCapture(e.pointerId); } catch { /* best effort */ }
    row.addEventListener('pointermove', onMove);
    row.addEventListener('pointerup', onUp);
  });
}

/* ── Document text search (right-panel Search tab) ─────────────────────── */
let _searchSeq = 0;

function wireSearch(root: HTMLElement, ws: Workspace): void {
  const input = root.querySelector('.search-input') as HTMLInputElement | null;
  const status = root.querySelector('.search-status') as HTMLElement | null;
  const list = root.querySelector('.search-results') as HTMLElement | null;
  if (!input || !status || !list) return;

  let debounce: number | null = null;
  const run = async (): Promise<void> => {
    const doc = getActiveDoc();
    const query = input.value.trim();
    const seq = ++_searchSeq;
    list.innerHTML = '';
    if (!doc?.pdfDoc || query.length < 2) {
      status.textContent = query.length === 1 ? 'Type at least 2 characters' : '';
      return;
    }
    const pdfDoc = doc.pdfDoc;
    const { searchDocument } = await import('../pdf/search');
    const hits = await searchDocument(pdfDoc, query, (page, total) => {
      if (seq === _searchSeq) status.textContent = `Searching page ${page} / ${total}…`;
    });
    if (seq !== _searchSeq) return; // superseded by newer input
    status.textContent = hits.length
      ? `${hits.length}${hits.length >= 300 ? '+' : ''} result${hits.length === 1 ? '' : 's'}`
      : 'No results';
    for (const hit of hits) {
      const li = document.createElement('li');
      const page = document.createElement('span');
      page.className = 'sr-page';
      page.textContent = `p.${hit.pageIndex + 1}`;
      const snippet = document.createElement('span');
      snippet.className = 'sr-snippet';
      const mark = document.createElement('mark');
      mark.textContent = hit.match;
      snippet.append(document.createTextNode(hit.before), mark, document.createTextNode(hit.after));
      li.append(page, snippet);
      li.addEventListener('click', () => ws.revealPageRect(hit.pageIndex, hit.rect));
      list.appendChild(li);
    }
  };

  input.addEventListener('input', () => {
    if (debounce !== null) clearTimeout(debounce);
    debounce = window.setTimeout(() => void run(), 350);
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep tool hotkeys away while typing
    if (e.key === 'Enter') {
      if (debounce !== null) clearTimeout(debounce);
      void run();
    }
  });
}

const PANEL_MIN = 160;
const PANEL_MAX = 480;
/** Margin around the floating glass chrome (ribbon / panels) — keep in sync
 *  with the corresponding inset values in main.css. */
const GLASS_GAP = 8;

function wirePanels(root: HTMLElement, _ws: Workspace): void {
  root.querySelector('.main-area')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.left-toggle')) {
      peekCancel('left'); // the arrow pins/unpins — drop any transient peek
      setState({ leftPanelVisible: !getState().leftPanelVisible });
      return;
    }
    if (target.closest('.right-toggle')) {
      peekCancel('right');
      setState({ rightPanelVisible: !getState().rightPanelVisible });
      return;
    }
  });

  // Hover peek: brushing the canvas edge slides a folded panel out; leaving
  // the panel folds it back after a beat. Pinned panels are unaffected.
  for (const side of ['left', 'right'] as const) {
    const zone = root.querySelector(`.panel-peek-zone.${side}`) as HTMLElement | null;
    const panel = root.querySelector(`.${side}-panel`) as HTMLElement | null;
    const visible = () => (side === 'left' ? getState().leftPanelVisible : getState().rightPanelVisible);
    zone?.addEventListener('pointerenter', () => {
      if (!visible()) peekShow(side);
    });
    zone?.addEventListener('pointerleave', () => peekHideSoon(side));
    panel?.addEventListener('pointerenter', () => {
      if (_peek[side]) peekShow(side); // cancel a pending fold while inside
    });
    panel?.addEventListener('pointerleave', () => {
      if (!visible()) peekHideSoon(side);
    });
  }

  wirePanelResize(root);

  root.querySelectorAll('.left-panel .panel-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      setState({ leftPanelTab: (btn as HTMLElement).dataset.tab as 'bookmarks' | 'thumbnails' });
    });
  });

  root.querySelectorAll('.right-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      setState({ rightPanelTab: (btn as HTMLElement).dataset.rtab as 'properties' | 'search' });
    });
  });

  root.querySelector('.pane-close')?.addEventListener('click', () => {
    updateActiveDoc((d) => ({ ...d, splitMode: 'none' }));
  });
}

function wirePanelResize(root: HTMLElement): void {
  const mainArea = root.querySelector('.main-area') as HTMLElement;
  const leftResizer = root.querySelector('.left-resizer') as HTMLElement;
  const rightResizer = root.querySelector('.right-resizer') as HTMLElement;

  let leftDragging = false;
  let rightDragging = false;

  leftResizer?.addEventListener('pointerdown', (e) => {
    leftDragging = true;
    leftResizer.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  leftResizer?.addEventListener('pointermove', (e) => {
    if (!leftDragging) return;
    const rect = mainArea.getBoundingClientRect();
    const width = Math.max(PANEL_MIN, Math.min(PANEL_MAX, e.clientX - rect.left - GLASS_GAP));
    setState({ leftPanelWidth: width, leftPanelVisible: true });
  });
  leftResizer?.addEventListener('pointerup', () => {
    leftDragging = false;
  });

  rightResizer?.addEventListener('pointerdown', (e) => {
    rightDragging = true;
    rightResizer.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  rightResizer?.addEventListener('pointermove', (e) => {
    if (!rightDragging) return;
    const rect = mainArea.getBoundingClientRect();
    const width = Math.max(PANEL_MIN, Math.min(PANEL_MAX, rect.right - e.clientX - GLASS_GAP));
    setState({ rightPanelWidth: width, rightPanelVisible: true });
  });
  rightResizer?.addEventListener('pointerup', () => {
    rightDragging = false;
  });
}

function wireHUDs(root: HTMLElement, ws: Workspace): void {
  root.querySelector('.page-prev')?.addEventListener('click', () => {
    const doc = getActiveDoc();
    if (doc) ws.goToPage(Math.max(0, doc.currentPage - 1));
  });
  root.querySelector('.page-next')?.addEventListener('click', () => {
    const doc = getActiveDoc();
    if (doc) ws.goToPage(Math.min(doc.pageCount - 1, doc.currentPage + 1));
  });
  root.querySelector('[data-zoom="fit"]')?.addEventListener('click', () => ws.fitPage());
  root.querySelector('[data-zoom="in"]')?.addEventListener('click', () => {
    const doc = getActiveDoc();
    if (doc) ws.setZoom(doc.zoom * 1.2);
  });
  root.querySelector('[data-zoom="out"]')?.addEventListener('click', () => {
    const doc = getActiveDoc();
    if (doc) ws.setZoom(doc.zoom / 1.2);
  });
}

function renderChrome(root: HTMLElement, ws: Workspace, secondaryWs: Workspace): void {
  const state = getState();
  const doc = getActiveDoc();

  const leftPanel = root.querySelector('.left-panel') as HTMLElement | null;
  const rightPanel = root.querySelector('.right-panel') as HTMLElement | null;
  const leftToggle = root.querySelector('.left-toggle') as HTMLButtonElement | null;
  const rightToggle = root.querySelector('.right-toggle') as HTMLButtonElement | null;

  // The ribbon floats over the canvas: the glass panels start just below it.
  // GLASS_GAP must match the panel/ribbon margins in main.css.
  const ribbonEl = root.querySelector('.ribbon') as HTMLElement | null;
  const panelTop = (ribbonEl?.offsetHeight ?? 0) + 2 * GLASS_GAP;

  // A panel shows when pinned open (state) OR while hover-peeking
  const leftOut = state.leftPanelVisible || _peek.left;
  const rightOut = state.rightPanelVisible || _peek.right;
  if (leftPanel) {
    leftPanel.classList.toggle('collapsed', !leftOut);
    leftPanel.style.width = leftOut ? `${state.leftPanelWidth}px` : '0';
    leftPanel.style.top = `${panelTop}px`;
  }
  if (rightPanel) {
    rightPanel.classList.toggle('collapsed', !rightOut);
    rightPanel.style.width = rightOut ? `${state.rightPanelWidth}px` : '0';
    rightPanel.style.top = `${panelTop}px`;
  }
  // Peek hot zones arm only while the corresponding panel is folded
  (root.querySelector('.panel-peek-zone.left') as HTMLElement | null)?.classList.toggle(
    'active',
    !state.leftPanelVisible,
  );
  (root.querySelector('.panel-peek-zone.right') as HTMLElement | null)?.classList.toggle(
    'active',
    !state.rightPanelVisible,
  );
  if (leftToggle) {
    leftToggle.textContent = state.leftPanelVisible ? '◀' : '▶';
    leftToggle.title = state.leftPanelVisible ? 'Hide left panel' : 'Show left panel';
    leftToggle.classList.toggle('panel-collapsed', !state.leftPanelVisible);
    leftToggle.classList.toggle('inside-panel', state.leftPanelVisible);
    if (state.leftPanelVisible) {
      // Tuck the button inside the panel (right edge just left of the resizer)
      leftToggle.style.left = `${GLASS_GAP + state.leftPanelWidth - 4}px`;
      leftToggle.style.transform = 'translate(-100%, -50%)';
    } else {
      leftToggle.style.left = '0px';
      leftToggle.style.transform = 'translateY(-50%)';
    }
  }
  if (rightToggle) {
    rightToggle.textContent = state.rightPanelVisible ? '▶' : '◀';
    rightToggle.title = state.rightPanelVisible ? 'Hide right panel' : 'Show right panel';
    rightToggle.classList.toggle('panel-collapsed', !state.rightPanelVisible);
    rightToggle.classList.toggle('inside-panel', state.rightPanelVisible);
    if (state.rightPanelVisible) {
      rightToggle.style.right = `${GLASS_GAP + state.rightPanelWidth - 4}px`;
      rightToggle.style.transform = 'translate(100%, -50%)';
    } else {
      rightToggle.style.right = '0px';
      rightToggle.style.transform = 'translateY(-50%)';
    }
  }

  renderDocTabs(root);
  renderLeftPanel(root, ws);
  renderRightPanel(root);
  renderStatusBar(root);
  renderSplit(root, secondaryWs);

  // Right-panel tab (Properties / Search)
  const rtab = state.rightPanelTab;
  root.querySelectorAll('.right-tabs button').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.rtab === rtab);
  });
  root.querySelector('.right-tab-properties')?.classList.toggle('hidden', rtab !== 'properties');
  root.querySelector('.right-tab-search')?.classList.toggle('hidden', rtab !== 'search');

  const tool = state.activeTool;
  root.querySelectorAll('.tool-btn').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.tool === tool);
  });

  // Overlay button reflects overlayEnabled state, not the activeTool
  const overlayBtn = root.querySelector('.btn-overlay') as HTMLElement | null;
  if (overlayBtn) overlayBtn.classList.toggle('active', doc?.overlayEnabled ?? false);

  // Overlay controls (in the ribbon): visibility + contents derive from state.
  // Rebuild the selects only when the document or its page count changes so
  // an open dropdown isn't yanked out from under the user.
  const overlayOn = doc?.overlayEnabled ?? false;
  root.querySelector('.overlay-bar')?.classList.toggle('hidden', !overlayOn);
  // Rebuild when the page changes too — the controls edit the CURRENT page's
  // overlay slots, so they must reflect the page being viewed
  const overlayBarKey = overlayOn && doc ? `${doc.id}:${doc.pageCount}:${doc.currentPage}` : '';
  if (overlayBarKey !== _overlayBarKey) {
    _overlayBarKey = overlayBarKey;
    if (overlayOn) renderOverlayBar(root);
  }

  if (doc) {
    const defaults = doc.pageDefaults[doc.currentPage];
    root.querySelector('.hud-scale')!.textContent = `Scale: ${defaults?.scaleLabel ?? 'None'}`;
    root.querySelector('.page-label')!.textContent = `${doc.currentPage + 1} / ${doc.pageCount}`;
    root.querySelector('.zoom-label')!.textContent = `${Math.round(doc.zoom * 100)}%`;
    // Sync ribbon Page Default controls with the active page's values
    if (defaults) {
      const scSel = root.querySelector('.scale-select') as HTMLSelectElement | null;
      if (scSel && document.activeElement !== scSel) scSel.value = defaults.scaleLabel;
      const sc = root.querySelector('.stroke-color') as HTMLElement | null;
      if (sc) sc.style.backgroundColor = defaults.strokeColor;
      const fc = root.querySelector('.fill-color') as HTMLElement | null;
      if (fc) fc.style.backgroundColor = defaults.fillColor ?? DEFAULT_COLOR;
      const tc = root.querySelector('.text-color') as HTMLElement | null;
      if (tc) tc.style.backgroundColor = defaults.textColor;
      const ts = root.querySelector('.text-size') as HTMLSelectElement | null;
      if (ts && document.activeElement !== ts) ts.value = String(defaults.fontSize ?? 12);
      const lw = root.querySelector('.line-weight') as HTMLSelectElement | null;
      if (lw && document.activeElement !== lw) {
        lw.value = LINE_WEIGHT_OPTIONS.includes(defaults.lineWeight)
          ? String(defaults.lineWeight)
          : 'custom';
      }
      const ls = root.querySelector('.line-style') as HTMLSelectElement | null;
      if (ls && document.activeElement !== ls) ls.value = defaults.lineStyle;
    }
  }
}

function renderDocTabs(root: HTMLElement): void {
  const tabs = root.querySelector('.doc-tabs')!;
  tabs.innerHTML = '';
  for (const doc of getState().documents) {
    const active = doc.id === getState().activeDocId;
    const tab = document.createElement('button');
    tab.className = 'doc-tab' + (active ? ' active' : '');
    tab.title = doc.filename + (doc.dirty ? ' — unsaved changes' : '');
    // Green dot marks the CURRENT file (hollow when its changes are saved)
    if (active) {
      const dot = document.createElement('span');
      dot.className = 'tab-dot' + (doc.dirty ? '' : ' saved');
      tab.appendChild(dot);
    }
    tab.appendChild(document.createTextNode(doc.filename));
    tab.addEventListener('click', () => setState({ activeDocId: doc.id }));
    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      void requestCloseDocument(doc.id);
    });
    tab.appendChild(close);
    tabs.appendChild(tab);
  }
}

/** The whole menubar accepts dropped PDF / JPEG / PNG files, opening each as
 *  a new document (no hint text — the header itself is the drop target). */
function wireDropZone(root: HTMLElement): void {
  const zone = root.querySelector('.menubar') as HTMLElement | null;
  if (!zone) return;
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', (e) => {
    if (e.target === zone) zone.classList.remove('drag-over');
  });
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (const f of Array.from(files)) await openDroppedFile(f);
  });
}

/** Internal render resolution of thumbnails (px). They DISPLAY at the panel's
 *  width via CSS (width:100%), so this only governs crispness. */
const THUMB_W = 220;
/** Per-doc thumbnail cache: docId → Map<pageIndex, dataURL>. */
const _thumbCache = new Map<string, Map<number, string>>();
/** Currently active IntersectionObserver for the thumbnail panel. */
let _thumbObserver: IntersectionObserver | null = null;
/** Doc ID for which the thumbnail list was last built. */
let _thumbDocId: string | null = null;
/** Signature (docId:pageCount) of the last-built overlay controls. */
let _overlayBarKey = '';

/* ── Collapsed-panel hover peek ────────────────────────────────────────────
   When a side panel is folded, brushing the canvas edge slides it out
   temporarily; it stays while the cursor is over it and folds back
   PEEK_HIDE_MS after the cursor leaves. Manually opened panels (the arrow
   buttons) are unaffected — they stay pinned. */
const PEEK_HIDE_MS = 1000;
const _peek = { left: false, right: false };
const _peekTimers: { left: number | null; right: number | null } = { left: null, right: null };
/** Re-runs renderChrome — set in buildAppShell where the deps live. */
let _rerenderChrome: (() => void) | null = null;

function peekShow(side: 'left' | 'right'): void {
  const t = _peekTimers[side];
  if (t !== null) clearTimeout(t);
  _peekTimers[side] = null;
  if (_peek[side]) return;
  _peek[side] = true;
  _rerenderChrome?.();
}

function peekHideSoon(side: 'left' | 'right'): void {
  if (!_peek[side]) return;
  const t = _peekTimers[side];
  if (t !== null) clearTimeout(t);
  _peekTimers[side] = window.setTimeout(() => {
    _peekTimers[side] = null;
    _peek[side] = false;
    _rerenderChrome?.();
  }, PEEK_HIDE_MS);
}

function peekCancel(side: 'left' | 'right'): void {
  const t = _peekTimers[side];
  if (t !== null) clearTimeout(t);
  _peekTimers[side] = null;
  _peek[side] = false;
}
/** The pdfDoc proxy the thumbnails were rendered from — page insert / delete /
 *  paste / rotate replace it, and the cached thumbs (keyed by index) go stale. */
let _thumbPdfDoc: unknown = null;

function renderLeftPanel(root: HTMLElement, ws: Workspace): void {
  const content = root.querySelector('.left-panel .panel-content') as HTMLElement | null;
  if (!content) return;
  const state = getState();
  const doc = getActiveDoc();

  if (state.leftPanelTab !== 'thumbnails') {
    // Tear down any running observer and render the bookmarks tree
    _thumbObserver?.disconnect();
    _thumbObserver = null;
    _thumbDocId = null;
    renderBookmarksPanel(content, ws);
    return;
  }

  if (!doc?.pdfDoc) {
    content.innerHTML = '';
    return;
  }

  // Only rebuild the DOM when the document (or its pdfDoc, after a page
  // insert/delete/paste/rotate) changes; otherwise just update the highlight
  if (
    doc.id !== _thumbDocId ||
    doc.pdfDoc !== _thumbPdfDoc ||
    content.querySelectorAll('.thumb-item').length !== doc.pageCount
  ) {
    _thumbObserver?.disconnect();
    content.innerHTML = '';
    _thumbDocId = doc.id;

    if (!_thumbCache.has(doc.id)) _thumbCache.set(doc.id, new Map());
    const cache = _thumbCache.get(doc.id)!;
    // A new pdfDoc proxy means the cached thumbnails (keyed by page index)
    // no longer match the pages — flush and re-render them
    if (doc.pdfDoc !== _thumbPdfDoc) cache.clear();
    _thumbPdfDoc = doc.pdfDoc;
    const pdfDoc = doc.pdfDoc;

    _thumbObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const item = entry.target as HTMLElement;
          const i = Number(item.dataset.page);
          _thumbObserver?.unobserve(item);
          _renderThumb(item, i, pdfDoc, cache);
        }
      },
      { root: content, rootMargin: '200px' },
    );

    for (let i = 0; i < doc.pageCount; i++) {
      const pageInfo = doc.pages[i];
      const thumbH = pageInfo
        ? Math.round((pageInfo.height / pageInfo.width) * THUMB_W)
        : Math.round(THUMB_W * 1.29);

      const item = document.createElement('div');
      item.className = 'thumb-item' + (i === doc.currentPage ? ' active' : '');
      item.dataset.page = String(i);

      const canvas = document.createElement('canvas');
      canvas.className = 'thumb-canvas';
      canvas.width = THUMB_W;
      canvas.height = thumbH;

      const label = document.createElement('div');
      label.className = 'thumb-label';
      label.textContent = `Page ${i + 1}`;
      item.appendChild(canvas);
      item.appendChild(label);
      item.addEventListener('click', () => ws.goToPage(i));
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showPageContextMenu(e, i, doc.id);
      });
      content.appendChild(item);
      _thumbObserver.observe(item);
    }
  } else {
    // Fast path: only update the active-page highlight
    content.querySelectorAll('.thumb-item').forEach((el, i) => {
      el.classList.toggle('active', i === doc.currentPage);
    });
  }
}

function _renderThumb(
  item: HTMLElement,
  i: number,
  pdfDoc: PDFDocumentProxy,
  cache: Map<number, string>,
): void {
  const canvas = item.querySelector('.thumb-canvas') as HTMLCanvasElement | null;
  if (!canvas) return;

  if (cache.has(i)) {
    // Restore from cache without hitting the PDF worker again
    const img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')?.drawImage(img, 0, 0);
    };
    img.src = cache.get(i)!;
    return;
  }

  pdfDoc.getPage(i + 1).then((page) => {
    const nativeVp = page.getViewport({ scale: 1 });
    const scale = THUMB_W / nativeVp.width;
    const vp = page.getViewport({ scale });
    canvas.width = vp.width;
    canvas.height = vp.height;
    const ctx = canvas.getContext('2d')!;
    page
      .render({ canvasContext: ctx, viewport: vp, canvas })
      .promise.then(() => {
        // Cache as JPEG (smaller than PNG, good enough for thumbnails)
        cache.set(i, canvas.toDataURL('image/jpeg', 0.75));
      })
      .catch(() => {});
  });
}

function showPageContextMenu(e: MouseEvent, pageIndex: number, docId: string): void {
  const doc = getState().documents.find((d) => d.id === docId);
  const canPaste = hasPageClipboard();
  const canDelete = (doc?.pageCount ?? 0) > 1;

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  menu.innerHTML = `
    <button data-action="add-new">Add New…</button>
    <button data-action="copy">Copy</button>
    <button data-action="paste-before" ${canPaste ? '' : 'disabled'}>Paste Before</button>
    <button data-action="paste-after" ${canPaste ? '' : 'disabled'}>Paste After</button>
    <button data-action="delete" ${canDelete ? '' : 'disabled'} title="${canDelete ? '' : 'The last page cannot be deleted'}">Delete</button>
    <div class="ctx-sep"></div>
    <button data-action="rotate-90">Rotate 90°</button>
    <button data-action="rotate-180">Rotate 180°</button>
  `;
  document.body.appendChild(menu);
  const close = () => menu.remove();
  menu.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = (btn as HTMLElement).dataset.action!;
      close();
      switch (action) {
        case 'add-new':
          showInsertPageDialog(docId, pageIndex);
          break;
        case 'copy':
          copyPage(docId, pageIndex);
          break;
        case 'paste-before':
          await pastePage(docId, pageIndex);
          break;
        case 'paste-after':
          await pastePage(docId, pageIndex + 1);
          break;
        case 'delete':
          await deletePage(docId, pageIndex);
          break;
        case 'rotate-90':
          await rotatePage(docId, pageIndex, 90);
          break;
        case 'rotate-180':
          await rotatePage(docId, pageIndex, 180);
          break;
      }
    });
  });
  setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
}

/** "Add New…" from a thumbnail: pick paper size + orientation, then insert
 *  the blank page before or after the right-clicked page. */
function showInsertPageDialog(docId: string, pageIndex: number): void {
  const overlay = openModal(
    'Add new page',
    `<label class="modal-field">Paper size
      <select class="np-size">${NEW_FILE_SIZES.map((s) => `<option value="${s.key}">${s.label}</option>`).join('')}</select></label>
    <label class="modal-field">Orientation
      <select class="np-orient"><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
    <div class="modal-actions">
      <button class="modal-btn-ghost np-before">Insert before</button>
      <button class="modal-btn np-after">Insert after</button>
    </div>`,
  );
  const doInsert = async (at: number): Promise<void> => {
    const sizeKey = (overlay.querySelector('.np-size') as HTMLSelectElement).value;
    const landscape = (overlay.querySelector('.np-orient') as HTMLSelectElement).value === 'landscape';
    overlay.remove();
    await insertBlankPage(docId, at, sizeKey, landscape);
  };
  overlay.querySelector('.np-before')?.addEventListener('click', () => void doInsert(pageIndex));
  overlay.querySelector('.np-after')?.addEventListener('click', () => void doInsert(pageIndex + 1));
}

function renderRightPanel(root: HTMLElement): void {
  const doc = getActiveDoc();
  const state = getState();
  const props = root.querySelector('.properties-panel')!;
  const totalsBlock = root.querySelector('.totals-block')!;
  const list = root.querySelector('.markups-list ul')!;

  props.innerHTML = renderProperties(doc, state.selectedMarkupIds);
  wireProperties(props as HTMLElement, state.selectedMarkupIds[0]);
  // Totals always live at the bottom of the panel (above the Markups list)
  totalsBlock.innerHTML = renderTotals(doc, state.selectedMarkupIds[0]);

  list.innerHTML = '';
  if (!doc) return;
  // Most-recent markup at the top, oldest at the bottom — i.e. the list runs
  // front (top of draw order) → back. Markups are stored back→front.
  const pageMarkups = doc.markups.filter((mk) => mk.pageIndex === doc.currentPage);
  const selectedSet = new Set(state.selectedMarkupIds);
  for (let i = pageMarkups.length - 1; i >= 0; i--) {
    const m = pageMarkups[i]!;
    const li = document.createElement('li');
    li.dataset.id = m.id;
    if (selectedSet.has(m.id)) li.classList.add('selected');
    if (m.locked) li.classList.add('mk-locked');
    // Colored identity dot (the markup's resolved stroke color)
    const dot = document.createElement('span');
    dot.className = 'mk-dot';
    dot.style.backgroundColor =
      m.overrides?.strokeColor ?? doc.pageDefaults[m.pageIndex]?.strokeColor ?? DEFAULT_COLOR;
    // Item name prominent; the info text (markup text content when there is
    // one, else the description/id) abbreviated to "ab…yz" on the right
    const name = document.createElement('span');
    name.className = 'mk-name';
    name.textContent = m.type;
    const idSpan = document.createElement('span');
    idSpan.className = 'mk-id';
    // Right-hand info: the measurement value for measure markups, the text
    // content for text-bearing ones, and the id ONLY when neither exists.
    // CSS ellipsizes the span when (and only when) it doesn't fit the row.
    const sf = doc.pageDefaults[m.pageIndex]?.scaleFactor ?? null;
    let info = '';
    if (m.type === 'dimension') {
      info = formatLength(dist({ x: m.x1, y: m.y1 }, { x: m.x2, y: m.y2 }), sf, m.roundTo);
    } else if (m.type === 'polyline') {
      info = formatLength(polylineLength(m.points), sf);
    } else if (m.type === 'polygon' && m.points.length >= 3) {
      info = formatArea(polygonArea(m.points), sf, m.decimals);
    } else if (m.type === 'measureAngle') {
      info = formatAngle(angleDegrees(m.p1, m.vertex, m.p2));
    } else if ('content' in m && m.content) {
      info = m.content;
    }
    if (!info) info = m.description ?? m.id;
    info = info.replace(/\s+/g, ' ').trim();
    idSpan.textContent = info;
    idSpan.title = info;
    // Padlock: unlocked by default; click to lock (= reversible flatten —
    // drawn in place but not selectable/editable until unlocked)
    const lockBtn = document.createElement('button');
    lockBtn.className = 'mk-lock' + (m.locked ? ' locked' : '');
    lockBtn.title = m.locked ? 'Locked — click to unlock' : 'Click to lock';
    lockBtn.innerHTML = m.locked ? LOCK_ICON : UNLOCK_ICON;
    lockBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    lockBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMarkupLock(m.id);
    });
    li.append(dot, name, idSpan, lockBtn);
    wireMarkupRowDrag(li, m.id, list as HTMLElement, !!m.locked);
    list.appendChild(li);
  }
}

/** Padlock icons for the markups list (12px, stroke = currentColor). */
const UNLOCK_ICON = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5.4" width="8" height="5.1" rx="1.1"/><path d="M4 5.4V3.6a2 2 0 0 1 3.9-.6"/></svg>`;
const LOCK_ICON = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5.4" width="8" height="5.1" rx="1.1"/><path d="M4 5.4V3.9a2 2 0 0 1 4 0v1.5"/></svg>`;

/** Toggle a markup's lock (reversible flatten) — one undo step. Locking a
 *  selected markup deselects it. */
function toggleMarkupLock(id: string): void {
  const doc = getActiveDoc();
  const m = doc?.markups.find((mk) => mk.id === id);
  if (!doc || !m) return;
  const locking = !m.locked;
  const next = doc.markups.map((mk) => (mk.id === id ? { ...mk, locked: locking } : mk));
  import('../state/undo').then(({ applyMarkupChange }) =>
    applyMarkupChange(locking ? 'Lock markup' : 'Unlock markup', next),
  );
  if (locking && getState().selectedMarkupIds.includes(id)) {
    setState({ selectedMarkupIds: getState().selectedMarkupIds.filter((s) => s !== id) });
  }
}

/** Drag a row up/down to reorder draw order, with a floating clone and a drop
 *  line. A plain click (no drag) selects the markup. Locked rows are inert —
 *  a locked markup is "flattened" in place, so it can't be selected or
 *  restacked until unlocked. */
function wireMarkupRowDrag(li: HTMLElement, id: string, list: HTMLElement, locked = false): void {
  li.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || locked) return;
    const startY = e.clientY;
    let dragging = false;
    let clone: HTMLElement | null = null;
    let line: HTMLElement | null = null;

    const rowsExcludingDragged = (): HTMLElement[] =>
      ([...list.querySelectorAll('li')] as HTMLElement[]).filter((el) => el.dataset.id !== id);

    /** Insertion index (into the rows-excluding-dragged list) + place the line. */
    const updateDropLine = (clientY: number): number => {
      const rows = rowsExcludingDragged();
      const ulRect = list.getBoundingClientRect();
      let idx = rows.length;
      let top = 0;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!.getBoundingClientRect();
        if (clientY < r.top + r.height / 2) {
          idx = i;
          top = r.top - ulRect.top + list.scrollTop;
          break;
        }
      }
      if (idx === rows.length && rows.length) {
        const r = rows[rows.length - 1]!.getBoundingClientRect();
        top = r.bottom - ulRect.top + list.scrollTop;
      }
      if (line) line.style.top = `${top}px`;
      return idx;
    };

    const onMove = (ev: PointerEvent): void => {
      if (!dragging && Math.abs(ev.clientY - startY) > 4) {
        dragging = true;
        li.classList.add('mk-dragging');
        clone = li.cloneNode(true) as HTMLElement;
        clone.classList.add('mk-clone');
        clone.style.width = `${li.offsetWidth}px`;
        document.body.appendChild(clone);
        line = document.createElement('div');
        line.className = 'mk-drop-line';
        list.appendChild(line);
      }
      if (dragging && clone) {
        const r = li.getBoundingClientRect();
        clone.style.left = `${r.left}px`;
        clone.style.top = `${ev.clientY - r.height / 2}px`;
        updateDropLine(ev.clientY);
      }
    };

    const onUp = (ev: PointerEvent): void => {
      try { li.releasePointerCapture(ev.pointerId); } catch { /* best effort */ }
      li.removeEventListener('pointermove', onMove);
      li.removeEventListener('pointerup', onUp);
      if (!dragging) {
        selectMarkupsById(id);
        return;
      }
      const idx = updateDropLine(ev.clientY);
      li.classList.remove('mk-dragging');
      clone?.remove();
      line?.remove();
      // Rebuild the visual (front→back) order with the row moved to idx
      const visual = rowsExcludingDragged().map((el) => el.dataset.id!);
      visual.splice(idx, 0, id);
      applyDrawOrder(visual);
    };

    try { li.setPointerCapture(e.pointerId); } catch { /* best effort */ }
    li.addEventListener('pointermove', onMove);
    li.addEventListener('pointerup', onUp);
  });
}

function selectMarkupsById(id: string): void {
  import('../state/store').then(({ selectMarkups }) => selectMarkups([id]));
}

/** Apply a new visual (front→back) order to the current page's markups. */
function applyDrawOrder(visualFrontToBack: string[]): void {
  const doc = getActiveDoc();
  if (!doc) return;
  const backToFront = [...visualFrontToBack].reverse();
  const next = applyPageOrder(doc.markups, doc.currentPage, backToFront);
  import('../state/undo').then(({ applyMarkupChange }) => applyMarkupChange('Reorder', next));
}

const ROUND_TO_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Exact' },
  { value: '0.25', label: '1/4"' },
  { value: '1', label: '1"' },
  { value: '6', label: '6"' },
  { value: '12', label: `1'` },
];

/** Markup type → TOOL_ICONS key, for the properties-panel header icon. */
const PROP_ICON: Record<string, string> = {
  rectangle: 'rectangle',
  highlighter: 'highlighter',
  inkHighlight: 'highlighter',
  ellipse: 'ellipse',
  polygon: 'polygon',
  cloud: 'polygon',
  line: 'line',
  polyline: 'polyline',
  text: 'text',
  callout: 'callout',
  sticky: 'sticky',
  dimension: 'dimension',
  measureAngle: 'measureAngle',
  snipImage: 'snip',
};

/** Markups that put text or numbers on the page → get Text Size + Font. */
const TEXT_BEARING_TYPES = [
  'text',
  'callout',
  'sticky',
  'dimension',
  'polyline',
  'polygon',
  'measureAngle',
];

/** Markups that enclose an area → get an infill color control. */
const FILL_BEARING_TYPES = ['rectangle', 'ellipse', 'polygon', 'cloud', 'text', 'callout'];

/** Markups that get start/end arrow controls. */
const ARROW_BEARING_TYPES = ['line', 'polyline', 'callout'];

/* ── Color palette popup (toolbar color boxes) ─────────────────────────── */
function closeSwatchPopup(): void {
  document.removeEventListener('pointerdown', onSwatchDocDown, true);
  document.querySelector('.color-popup')?.remove();
}

function onSwatchDocDown(e: Event): void {
  const pop = document.querySelector('.color-popup');
  if (pop && !pop.contains(e.target as Node)) closeSwatchPopup();
}

/** Show a small palette popup anchored under `anchor`: the standard swatches
 *  plus a native "More colors…" picker. Calls `onPick` with the chosen hex. */
function openSwatchPopup(anchor: HTMLElement, current: string, onPick: (color: string) => void): void {
  closeSwatchPopup();
  const pop = document.createElement('div');
  pop.className = 'color-popup';

  const grid = document.createElement('div');
  grid.className = 'color-popup-grid';
  for (const c of SWATCH_COLORS) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'swatch' + (c.toLowerCase() === current.toLowerCase() ? ' active' : '');
    sw.style.background = c;
    sw.title = c;
    sw.addEventListener('click', () => {
      onPick(c);
      closeSwatchPopup();
    });
    grid.appendChild(sw);
  }
  pop.appendChild(grid);

  const native = document.createElement('input');
  native.type = 'color';
  native.value = /^#[0-9a-fA-F]{6}$/.test(current) ? current : DEFAULT_COLOR;
  native.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none;';
  native.addEventListener('input', () => onPick(native.value));
  native.addEventListener('change', () => closeSwatchPopup());

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'color-popup-more';
  more.textContent = 'More colors…';
  more.addEventListener('click', () => native.click());

  pop.append(more, native);
  document.body.appendChild(pop);

  const r = anchor.getBoundingClientRect();
  // Keep the popup on-screen horizontally
  const left = Math.min(Math.round(r.left), window.innerWidth - 150);
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${Math.round(r.bottom + 4)}px`;

  setTimeout(() => document.addEventListener('pointerdown', onSwatchDocDown, true), 0);
}

function renderProperties(doc: ReturnType<typeof getActiveDoc>, selected: string[]): string {
  if (!doc || !selected.length) return '<p class="muted">Select a markup to edit properties.</p>';
  const m = doc.markups.find((mk) => mk.id === selected[0]);
  if (!m) return '';
  const defaults = doc.pageDefaults[m.pageIndex];
  const stroke = m.overrides?.strokeColor ?? defaults?.strokeColor ?? DEFAULT_COLOR;
  const weight = m.overrides?.lineWeight ?? defaults?.lineWeight ?? 1;
  const lineStyle = m.overrides?.lineStyle ?? defaults?.lineStyle ?? 'solid';
  const opacity = m.overrides?.opacity ?? 1;
  const styleOptions = (['solid', 'dashed', 'dotted', 'centerline'] as const)
    .map((s) => `<option value="${s}" ${s === lineStyle ? 'selected' : ''}>${s}</option>`)
    .join('');

  // Infill control (rectangle/ellipse/polygon/text/callout/area)
  let fillSection = '';
  if (FILL_BEARING_TYPES.includes(m.type)) {
    const fillResolved = m.overrides?.fillColor !== undefined ? m.overrides.fillColor : (defaults?.fillColor ?? null);
    const fillOn = !!fillResolved;
    const fillVal = fillResolved ?? DEFAULT_COLOR;
    fillSection = `
    <label>Infill <span class="prop-color-pair"><input type="checkbox" data-fill-enable ${fillOn ? 'checked' : ''}><button type="button" class="color-box pp-color" data-cprop="fillColor" style="background:${fillOn ? fillVal : 'transparent'}" title="Fill color"></button></span></label>`;
  }
  const weightOptions =
    LINE_WEIGHT_OPTIONS.map(
      (w) => `<option value="${w}" ${w === weight ? 'selected' : ''}>${w}</option>`,
    ).join('') +
    (LINE_WEIGHT_OPTIONS.includes(weight) ? '' : `<option value="${weight}" selected>${weight}</option>`) +
    `<option value="custom">Custom…</option>`;

  let textSection = '';
  if (TEXT_BEARING_TYPES.includes(m.type)) {
    const fontSize = m.overrides?.fontSize ?? defaults?.fontSize ?? 12;
    const fontFamily = m.overrides?.fontFamily ?? defaults?.fontFamily ?? 'Arial';
    const textColor = m.overrides?.textColor ?? defaults?.textColor ?? DEFAULT_COLOR;
    const sizeOpts = TEXT_SIZE_OPTIONS.map((s) => `<option value="${s}" ${s === fontSize ? 'selected' : ''}>${s}</option>`).join('') +
      (TEXT_SIZE_OPTIONS.includes(fontSize) ? '' : `<option value="${fontSize}" selected>${fontSize}</option>`);
    textSection = `
    <hr>
    <label>Text color <button type="button" class="color-box pp-color" data-cprop="textColor" style="background:${textColor}" title="Text color"></button></label>
    <label>Text size <select data-prop="fontSize">${sizeOpts}</select></label>
    <label>Font <select data-prop="fontFamily">
      ${FONT_FAMILIES.map((f) => `<option value="${f}" ${f === fontFamily ? 'selected' : ''}>${f}</option>`).join('')}
    </select></label>`;
    if (m.type === 'text' || m.type === 'callout') {
      const lineSpacing = m.overrides?.lineSpacing ?? 1.35;
      textSection += `
    <label>Line spacing <select data-prop="lineSpacing">
      ${LINE_SPACING_OPTIONS.map((s) => `<option value="${s}" ${s === lineSpacing ? 'selected' : ''}>${s === 1 ? 'Single' : s === 2 ? 'Double' : s}</option>`).join('')}
    </select></label>`;
    }
  }

  // Arrow controls (line / polyline / callout)
  let arrowSection = '';
  if (ARROW_BEARING_TYPES.includes(m.type)) {
    const startOn = (m.arrowStart ?? 'none') !== 'none';
    const endOn = (m.arrowEnd ?? 'none') !== 'none';
    // The style of whichever end is on (default filled)
    const arrowStyle: ArrowHead = m.arrowStart && m.arrowStart !== 'none'
      ? m.arrowStart
      : m.arrowEnd && m.arrowEnd !== 'none'
        ? m.arrowEnd
        : 'filled';
    const arrowSize = m.arrowSize ?? 1;
    const isCallout = m.type === 'callout';
    arrowSection = `
    <hr>
    ${isCallout ? '' : `<label>Arrow start <input type="checkbox" data-arrow="start" ${startOn ? 'checked' : ''}></label>`}
    <label>Arrow ${isCallout ? 'on' : 'end'} <input type="checkbox" data-arrow="end" ${endOn ? 'checked' : ''}></label>
    <label>Arrow style <select data-arrow-style>
      <option value="filled" ${arrowStyle === 'filled' ? 'selected' : ''}>Filled</option>
      <option value="open" ${arrowStyle === 'open' ? 'selected' : ''}>Open</option>
    </select></label>
    <label>Arrow size <select data-arrow-size>
      ${ARROW_SIZE_OPTIONS.map((o) => `<option value="${o.value}" ${o.value === arrowSize ? 'selected' : ''}>${o.label}</option>`).join('')}
    </select></label>`;
  }

  // Polyline → optional total length; Polygon → optional enclosed area
  let measureToggle = '';
  if (m.type === 'polyline') {
    const on = m.showLength ?? false;
    measureToggle = `<hr><label>Total length <input type="checkbox" data-flag="showLength" ${on ? 'checked' : ''}></label>`;
  } else if (m.type === 'polygon') {
    const on = m.showArea ?? false;
    const decimals = m.decimals ?? 2;
    measureToggle =
      `<hr><label>Show area <input type="checkbox" data-flag="showArea" ${on ? 'checked' : ''}></label>` +
      (on
        ? `<label>Decimals <select data-prop="decimals">${AREA_DECIMAL_OPTIONS.map((n) => `<option value="${n}" ${n === decimals ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`
        : '');
  }

  // Rotation (rectangle / ellipse): type-in degrees + drag the corner-outside handles
  let rotationSection = '';
  if (m.type === 'rectangle' || m.type === 'ellipse') {
    const rot = Math.round(m.rotation ?? 0);
    rotationSection = `<label>Rotation <input type="number" class="rot-input" data-prop="rotation" min="-360" max="360" step="1" value="${rot}"><span class="rot-unit">°</span></label>`;
  }

  let dimSection = '';
  if (m.type === 'dimension') {
    const tick = m.tickStyle ?? 'slash';
    const roundTo = m.roundTo !== undefined ? String(m.roundTo) : '';
    dimSection = `
    <hr>
    <label>End style <select data-prop="tickStyle">
      <option value="slash" ${tick === 'slash' ? 'selected' : ''}>Slash tick</option>
      <option value="arrow" ${tick === 'arrow' ? 'selected' : ''}>Arrow</option>
    </select></label>
    <label>Round up to <select data-prop="roundTo">
      ${ROUND_TO_OPTIONS.map((o) => `<option value="${o.value}" ${o.value === roundTo ? 'selected' : ''}>${o.label}</option>`).join('')}
    </select></label>`;
  }

  return `<div class="prop-block">
    <div class="prop-head">
      <span class="prop-head-icon">${TOOL_ICONS[PROP_ICON[m.type] ?? ''] ?? ''}</span>
      <div class="prop-head-text"><strong>${m.type}</strong><p>Page ${m.pageIndex + 1}</p></div>
    </div>
    <div class="prop-section-label">Appearance</div>
    <label>Line <button type="button" class="color-box pp-color" data-cprop="strokeColor" style="background:${stroke}" title="Line color"></button></label>
    ${fillSection}
    <label>Weight <select data-prop="lineWeight">${weightOptions}</select></label>
    <label>Style <select data-prop="lineStyle">${styleOptions}</select></label>
    ${rotationSection}
    <label class="opacity-row">Opacity <input type="range" class="opacity-range" data-prop="opacity" min="0.05" max="1" step="0.05" value="${opacity}"><span class="opacity-val">${Math.round(opacity * 100)}%</span></label>
    ${arrowSection}
    ${textSection}
    ${measureToggle}
    ${dimSection}
  </div>`;
}

/** Attach change handlers for the data-prop inputs of the selected markup. */
function wireProperties(props: HTMLElement, selectedId: string | undefined): void {
  if (!selectedId) return;
  props.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-prop]').forEach((input) => {
    input.addEventListener('change', () => {
      const doc = getActiveDoc();
      const m = doc?.markups.find((mk) => mk.id === selectedId);
      if (!doc || !m) return;
      const prop = input.dataset.prop!;

      // "Custom…" line weight prompts for a free value. Don't write it back
      // into the select — there is no matching <option>, which would blank
      // the value; the panel re-renders with the custom option after apply.
      let rawValue = input.value;
      if (prop === 'lineWeight' && rawValue === 'custom') {
        const entered = prompt('Line weight (pt)', '1');
        const w = entered ? Number(entered) : NaN;
        if (!Number.isFinite(w) || w <= 0) {
          input.value = String(m.overrides?.lineWeight ?? doc.pageDefaults[m.pageIndex]?.lineWeight ?? 1);
          return;
        }
        rawValue = String(w);
      }

      const next = doc.markups.map((mk) => {
        if (mk.id !== selectedId) return mk;
        if (prop === 'tickStyle' && mk.type === 'dimension') {
          return { ...mk, tickStyle: rawValue as 'slash' | 'arrow' };
        }
        if (prop === 'roundTo' && mk.type === 'dimension') {
          return { ...mk, roundTo: rawValue === '' ? undefined : Number(rawValue) };
        }
        if (prop === 'decimals' && mk.type === 'polygon') {
          return { ...mk, decimals: Number(rawValue) };
        }
        if (prop === 'rotation' && (mk.type === 'rectangle' || mk.type === 'ellipse')) {
          return { ...mk, rotation: Number(rawValue) || 0 };
        }
        // Appearance overrides
        const numeric = ['lineWeight', 'opacity', 'fontSize', 'lineSpacing'];
        const value = numeric.includes(prop) ? Number(rawValue) : rawValue;
        return { ...mk, overrides: { ...mk.overrides, [prop]: value } };
      });
      import('../state/undo').then(({ applyMarkupChange }) =>
        applyMarkupChange('Edit properties', next),
      );
    });
  });

  // Live opacity percentage readout while dragging the slider
  const opRange = props.querySelector<HTMLInputElement>('.opacity-range');
  const opVal = props.querySelector<HTMLElement>('.opacity-val');
  opRange?.addEventListener('input', () => {
    if (opVal) opVal.textContent = `${Math.round(Number(opRange.value) * 100)}%`;
  });

  const setFill = (value: string | null): void => {
    const doc = getActiveDoc();
    const m = doc?.markups.find((mk) => mk.id === selectedId);
    if (!doc || !m) return;
    const next = doc.markups.map((mk) =>
      mk.id === selectedId ? { ...mk, overrides: { ...mk.overrides, fillColor: value } } : mk,
    );
    import('../state/undo').then(({ applyMarkupChange }) => applyMarkupChange('Edit fill', next));
  };

  // Line / Infill / Text color wells open the standard swatch palette popup
  // (plus "More colors…"), exactly like the page-default color boxes
  props.querySelectorAll<HTMLButtonElement>('.pp-color').forEach((btn) => {
    btn.addEventListener('click', () => {
      const prop = btn.dataset.cprop as 'strokeColor' | 'fillColor' | 'textColor';
      const doc = getActiveDoc();
      const m = doc?.markups.find((mk) => mk.id === selectedId);
      if (!doc || !m) return;
      const defaults = doc.pageDefaults[m.pageIndex];
      const cur =
        prop === 'fillColor'
          ? (m.overrides?.fillColor !== undefined ? m.overrides.fillColor : defaults?.fillColor) ?? DEFAULT_COLOR
          : m.overrides?.[prop] ??
            (prop === 'strokeColor' ? defaults?.strokeColor : defaults?.textColor) ??
            DEFAULT_COLOR;
      openSwatchPopup(btn, cur ?? DEFAULT_COLOR, (color) => {
        if (prop === 'fillColor') {
          setFill(color);
        } else {
          const fresh = getActiveDoc();
          if (!fresh) return;
          const next = fresh.markups.map((mk) =>
            mk.id === selectedId ? { ...mk, overrides: { ...mk.overrides, [prop]: color } } : mk,
          );
          import('../state/undo').then(({ applyMarkupChange }) =>
            applyMarkupChange('Edit properties', next),
          );
        }
        btn.style.background = color;
      });
    });
  });

  // Infill enable/disable toggle
  const fillEnable = props.querySelector<HTMLInputElement>('[data-fill-enable]');
  fillEnable?.addEventListener('change', () => {
    if (!fillEnable.checked) {
      setFill(null);
      return;
    }
    const doc = getActiveDoc();
    const m = doc?.markups.find((mk) => mk.id === selectedId);
    const cur =
      m?.overrides?.fillColor ?? doc?.pageDefaults[m?.pageIndex ?? 0]?.fillColor ?? DEFAULT_COLOR;
    setFill(cur ?? DEFAULT_COLOR);
  });

  // Boolean flag checkboxes (polyline total length, polygon area)
  props.querySelectorAll<HTMLInputElement>('[data-flag]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const doc = getActiveDoc();
      const m = doc?.markups.find((mk) => mk.id === selectedId);
      if (!doc || !m) return;
      const flag = cb.dataset.flag!;
      const next = doc.markups.map((mk) =>
        mk.id === selectedId ? ({ ...mk, [flag]: cb.checked } as typeof mk) : mk,
      );
      import('../state/undo').then(({ applyMarkupChange }) =>
        applyMarkupChange('Edit properties', next),
      );
    });
  });

  // Arrow controls (line / polyline / callout): start/end checkboxes + style + size
  const applyArrow = (patch: Partial<Pick<Markup, 'arrowStart' | 'arrowEnd' | 'arrowSize'>>): void => {
    const doc = getActiveDoc();
    if (!doc?.markups.some((mk) => mk.id === selectedId)) return;
    const next = doc.markups.map((mk) => (mk.id === selectedId ? { ...mk, ...patch } : mk));
    import('../state/undo').then(({ applyMarkupChange }) => applyMarkupChange('Edit arrow', next));
  };
  const arrowStyleSel = props.querySelector<HTMLSelectElement>('[data-arrow-style]');
  const currentStyle = (): ArrowHead => (arrowStyleSel?.value as ArrowHead) || 'filled';

  props.querySelectorAll<HTMLInputElement>('[data-arrow]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const head: ArrowHead = cb.checked ? currentStyle() : 'none';
      applyArrow(cb.dataset.arrow === 'start' ? { arrowStart: head } : { arrowEnd: head });
    });
  });

  arrowStyleSel?.addEventListener('change', () => {
    const m = getActiveDoc()?.markups.find((mk) => mk.id === selectedId);
    if (!m) return;
    const style = currentStyle();
    const patch: Partial<Pick<Markup, 'arrowStart' | 'arrowEnd'>> = {};
    if ((m.arrowStart ?? 'none') !== 'none') patch.arrowStart = style;
    if ((m.arrowEnd ?? 'none') !== 'none') patch.arrowEnd = style;
    applyArrow(patch);
  });

  props.querySelector<HTMLSelectElement>('[data-arrow-size]')?.addEventListener('change', (e) => {
    applyArrow({ arrowSize: Number((e.target as HTMLSelectElement).value) });
  });
}

/** Measurement readout for the SELECTED markup only — hidden when nothing is
 *  selected or the selection has nothing measurable. Which rows appear
 *  depends on the markup: linear for dimensions/lines, length for polylines,
 *  perimeter + area for enclosing shapes, degrees for angles. */
function renderTotals(doc: ReturnType<typeof getActiveDoc>, selectedId?: string): string {
  if (!doc || !selectedId) return '';
  const m = doc.markups.find((mk) => mk.id === selectedId);
  if (!m) return '';
  const sf = doc.pageDefaults[m.pageIndex]?.scaleFactor ?? null;
  const rows: [string, string][] = [];
  switch (m.type) {
    case 'dimension':
      rows.push(['Linear', formatLength(dist({ x: m.x1, y: m.y1 }, { x: m.x2, y: m.y2 }), sf, m.roundTo)]);
      break;
    case 'line':
      rows.push(['Length', formatLength(dist({ x: m.x1, y: m.y1 }, { x: m.x2, y: m.y2 }), sf)]);
      break;
    case 'polyline':
      rows.push(['Length', formatLength(polylineLength(m.points), sf)]);
      break;
    case 'polygon':
    case 'cloud': {
      if (m.points.length < 2) return '';
      rows.push(['Perimeter', formatLength(polylineLength([...m.points, m.points[0]!]), sf)]);
      if (m.points.length >= 3) rows.push(['Area', formatArea(polygonArea(m.points), sf, m.decimals ?? 2)]);
      break;
    }
    case 'rectangle':
      rows.push(['Perimeter', formatLength(2 * (m.width + m.height), sf)]);
      rows.push(['Area', formatArea(m.width * m.height, sf)]);
      break;
    case 'ellipse': {
      // Ramanujan's perimeter approximation
      const per = Math.PI * (3 * (m.rx + m.ry) - Math.sqrt((3 * m.rx + m.ry) * (m.rx + 3 * m.ry)));
      rows.push(['Perimeter', formatLength(per, sf)]);
      rows.push(['Area', formatArea(Math.PI * m.rx * m.ry, sf)]);
      break;
    }
    case 'measureAngle':
      rows.push(['Angle', formatAngle(angleDegrees(m.p1, m.vertex, m.p2))]);
      break;
    default:
      return '';
  }
  return `<h4>Measurement</h4><div class="totals">${rows
    .map(([k, v]) => `<p>${k}: ${v}</p>`)
    .join('')}</div>`;
}

function renderStatusBar(root: HTMLElement): void {
  const doc = getActiveDoc();
  const state = getState();
  const bar = root.querySelector('.status-bar .status-text')!;
  const p = state.cursorPagePoint;
  const page = doc?.pages[doc.currentPage];
  bar.textContent = [
    `Tool: ${state.activeTool}`,
    `Calibration: ${doc?.pageDefaults[doc.currentPage]?.scaleLabel ?? 'None'}`,
    p ? `Cursor: ${Math.round(p.x)}, ${Math.round(p.y)} pt` : 'Cursor: —',
    `Markups: ${doc?.markups.length ?? 0}`,
    page ? `Sheet: ${Math.round(page.width)}×${Math.round(page.height)} pt` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function renderSplit(root: HTMLElement, secondaryWs: Workspace): void {
  const doc = getActiveDoc();
  const stack = root.querySelector('.viewer-stack') as HTMLElement;
  const divider = root.querySelector('.split-divider') as HTMLElement;
  const secondary = root.querySelector('.viewer-pane.secondary') as HTMLElement;
  if (!doc || doc.splitMode === 'none') {
    stack.classList.remove('split-v', 'split-h');
    divider.classList.add('hidden');
    secondary.classList.add('hidden');
    stack.style.gridTemplateColumns = '';
    stack.style.gridTemplateRows = '';
    // Tear down the duplicate viewer
    if (secondary.dataset.mounted) {
      secondaryWs.unmount();
      delete secondary.dataset.mounted;
    }
    return;
  }
  stack.classList.toggle('split-v', doc.splitMode === 'vertical');
  stack.classList.toggle('split-h', doc.splitMode === 'horizontal');
  divider.classList.remove('hidden');
  secondary.classList.remove('hidden');

  const ratio = doc.splitRatio;
  if (doc.splitMode === 'vertical') {
    stack.style.display = 'grid';
    stack.style.gridTemplateColumns = `${ratio}fr 4px ${1 - ratio}fr`;
  } else {
    stack.style.display = 'grid';
    stack.style.gridTemplateRows = `${ratio}fr 4px ${1 - ratio}fr`;
  }

  // Mount the duplicate viewer once when the split opens; it renders the same
  // active page as the primary viewer (shared doc/zoom, independent scroll).
  if (!secondary.dataset.mounted) {
    secondaryWs.mount(secondary);
    secondary.dataset.mounted = '1';
    requestAnimationFrame(() => secondaryWs.centerView());
  }

  if (!divider.dataset.wired) {
    divider.dataset.wired = '1';
    let dragging = false;
    divider.addEventListener('pointerdown', (e) => {
      dragging = true;
      divider.setPointerCapture(e.pointerId);
    });
    divider.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const d = getActiveDoc();
      if (!d) return;
      const rect = stack.getBoundingClientRect();
      let ratio = 0.5;
      if (d.splitMode === 'vertical') {
        ratio = (e.clientX - rect.left) / rect.width;
      } else {
        ratio = (e.clientY - rect.top) / rect.height;
      }
      ratio = Math.max(0.15, Math.min(0.85, ratio));
      updateActiveDoc((doc) => ({ ...doc, splitRatio: ratio }));
    });
    divider.addEventListener('pointerup', () => {
      dragging = false;
    });
  }
}

function renderOverlayBar(root: HTMLElement): void {
  const doc = getActiveDoc();
  const bar = root.querySelector('.overlay-bar .overlay-controls');
  if (!bar || !doc?.overlayEnabled) return;
  bar.innerHTML = '';
  // Overlays are configured PER PAGE: these controls edit the slots of the
  // page being viewed right now
  const hostPage = doc.currentPage;
  const slots = doc.overlaysByPage[hostPage] ?? [null, null];
  const writeSlot = (slot: number, value: OverlaySlot | null): void => {
    updateActiveDoc((d) => {
      const cur = d.overlaysByPage[hostPage] ?? [null, null];
      const next: [OverlaySlot | null, OverlaySlot | null] = [cur[0], cur[1]];
      next[slot] = value;
      const overlaysByPage = { ...d.overlaysByPage };
      if (next[0] === null && next[1] === null) delete overlaysByPage[hostPage];
      else overlaysByPage[hostPage] = next;
      return { ...d, overlaysByPage };
    });
  };
  for (let slot = 0; slot < 2; slot++) {
    const row = document.createElement('div');
    row.className = 'overlay-slot';
    const select = document.createElement('select');
    select.innerHTML = `<option value="">— Page —</option>${Array.from({ length: doc.pageCount }, (_, i) => `<option value="${i}">Page ${i + 1}</option>`).join('')}`;
    const opacity = document.createElement('select');
    opacity.innerHTML = Array.from({ length: 11 }, (_, i) => i * 10)
      .map((v) => `<option value="${v}" ${v === 100 ? 'selected' : ''}>${v}%</option>`)
      .join('');
    const current = slots[slot];
    if (current) {
      select.value = String(current.pageIndex);
      opacity.value = String(Math.round(current.opacity * 100));
    }
    select.addEventListener('change', () => {
      // '' (the "— Page —" placeholder) must clear the slot; Number('') is 0,
      // which would wrongly select page 1, so check for empty string first.
      const cleared = select.value === '';
      const pageIndex = Number(select.value);
      writeSlot(
        slot,
        !cleared && Number.isFinite(pageIndex) ? { pageIndex, opacity: Number(opacity.value) / 100 } : null,
      );
    });
    opacity.addEventListener('change', () => {
      const cur = (getActiveDoc()?.overlaysByPage[hostPage] ?? [null, null])[slot];
      if (cur) writeSlot(slot, { ...cur, opacity: Number(opacity.value) / 100 });
    });
    row.append(select, opacity);
    bar.appendChild(row);
  }

  // Photoshop-style Multiply blend of the overlay pages onto the base page
  const multiplyLabel = document.createElement('label');
  multiplyLabel.className = 'overlay-multiply';
  const multiplyCb = document.createElement('input');
  multiplyCb.type = 'checkbox';
  multiplyCb.checked = doc.overlayMultiply;
  multiplyCb.addEventListener('change', () => {
    updateActiveDoc((d) => ({ ...d, overlayMultiply: multiplyCb.checked }));
  });
  multiplyLabel.append(multiplyCb, document.createTextNode('Multiply'));
  bar.appendChild(multiplyLabel);
}
