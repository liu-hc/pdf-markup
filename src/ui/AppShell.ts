import {
  getState,
  subscribe,
  getActiveDoc,
  setState,
  setActiveTool,
  updateActiveDoc,
  closeDocument,
} from '../state/store';
import type { ToolId, LineStyle, Markup } from '../state/types';
import { applyPageOrder } from '../markups/order';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { ARCH_SCALES, ENG_SCALES, SWATCH_COLORS, PAGE_SIZES, FONT_FAMILIES, LINE_SPACING_OPTIONS, LINE_WEIGHT_OPTIONS, TEXT_SIZE_OPTIONS, AREA_DECIMAL_OPTIONS, ARROW_SIZE_OPTIONS, DEFAULT_COLOR } from '../state/types';
import type { ArrowHead } from '../state/types';
import { openFilePicker, saveDocument, flattenDocument, insertBlankPage, rotatePage, createBlankDocument, openDroppedFile } from '../pdf/loader';
import { handleEditAction } from '../tools/controller';
import { parseArchScale, parseEngScale } from '../util/geometry';
import { formatLength, formatArea } from '../util/units';
import { polygonArea, polylineLength, dist } from '../util/geometry';
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
      <div class="app-mark"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="2" y="1.5" width="10" height="13" rx="1.2" stroke="rgba(216,212,227,0.25)" stroke-width="1.3"/><rect x="8" y="5.5" width="10" height="13" rx="1.2" fill="#2a2635" stroke="rgba(216,212,227,0.25)" stroke-width="1.3"/><path d="M10 13.5l4.5-4.5 1.5 1.5-4.5 4.5L10 16z" fill="#6b6280"/></svg></div>
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
          <li class="sep"></li>
          <li data-action="flatten">Flatten</li>
        </ul></div>
        <div class="menu-item" data-menu="view">View<ul class="dropdown">
          <li data-action="continuous">Continuous</li>
          <li data-action="single">Single Page</li>
          <li class="sep"></li>
          <li data-action="split-v">Split Vertical</li>
          <li data-action="split-h">Split Horizontal</li>
          <li data-action="split-none">Close Split</li>
        </ul></div>
        <div class="menu-item" data-menu="help">Help<ul class="dropdown">
          <li data-action="help">User Guide</li>
        </ul></div>
      </nav>
      <div class="file-chip"><span class="filename">Untitled</span><span class="dirty-dot"></span></div>
      <button class="btn-save" title="Save (Ctrl+S)">Save</button>
    </header>
    <div class="doc-tabs"></div>
    <div class="ribbon"></div>
    <div class="overlay-bar hidden"></div>
    <div class="main-area">
      <aside class="left-panel">
        <div class="panel-inner">
          <div class="panel-tabs"><button data-tab="bookmarks">Bookmarks</button><button data-tab="thumbnails" class="active">Thumbnails</button></div>
          <div class="panel-content"></div>
        </div>
        <div class="panel-resizer left-resizer" title="Drag to resize"></div>
      </aside>
      <div class="center-column">
        <div class="viewer-stack">
          <div class="viewer-pane primary"></div>
          <div class="split-divider hidden"></div>
          <div class="viewer-pane secondary hidden">
            <button class="pane-close" title="Close viewer">✕</button>
          </div>
        </div>
        <div class="hud-scale">Scale: None</div>
        <div class="hud-page"><button class="page-prev">‹</button><span class="page-label">0/0</span><button class="page-next">›</button></div>
        <div class="hud-zoom"><button data-zoom="fit">Fit</button><button data-zoom="out">−</button><span class="zoom-label">100%</span><button data-zoom="in">+</button></div>
      </div>
      <aside class="right-panel">
        <div class="panel-resizer right-resizer" title="Drag to resize"></div>
        <div class="panel-inner">
          <div class="panel-content properties-panel"></div>
          <div class="totals-block"></div>
          <div class="markups-list"><h4>Markups</h4><ul></ul></div>
        </div>
      </aside>
      <div class="panel-edge-controls" aria-hidden="false">
        <button class="panel-toggle left-toggle" title="Toggle left panel">◀</button>
        <button class="panel-toggle right-toggle" title="Toggle right panel">▶</button>
      </div>
    </div>
    <footer class="status-bar"></footer>
  `;

  wireMenus(root, workspace);
  wireRibbon(root);
  wirePanels(root, workspace);
  wireHUDs(root, workspace);
  wireDropZone(root);
  subscribe(() => renderChrome(root, workspace, secondaryWorkspace));
  renderChrome(root, workspace, secondaryWorkspace);
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
        case 'flatten':
          if (doc) await flattenDocument(doc.id);
          ws.redrawAllMarkups();
          break;
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

const HELP_SECTIONS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Navigate',
    items: [
      ['Flip', 'Page through the document; scroll wheel turns pages.'],
      ['Zoom Page', 'Scroll to zoom; middle-drag (or Alt-drag) to pan. Double middle-click = 100%.'],
      ['Select', 'Click a markup to select, drag to move, drag handles to resize. Drag the corner-outside handles to rotate a rectangle/ellipse.'],
    ],
  },
  {
    title: 'Shapes',
    items: [
      ['Rectangle / Ellipse', 'Click two opposite corners. Add infill, rotation, line weight & style in Properties.'],
      ['Polygon', 'Click each vertex; double-click or click the start point to close. Toggle "Show area" in Properties.'],
      ['Line', 'Click two points. Hold Shift for horizontal/vertical. Add start/end arrows in Properties.'],
      ['Polyline', 'Click each vertex, double-click to finish. Toggle "Total length" in Properties.'],
      ['Highlighter', 'Drag to free-draw a fat marker; over text the cursor becomes an I-beam to highlight a text run.'],
    ],
  },
  {
    title: 'Annotation',
    items: [
      ['Text', 'Click two corners to size a box, then type in place.'],
      ['Callout', 'Three clicks — arrow tip, elbow, then the text box — then type. The leader runs horizontally out of the box.'],
    ],
  },
  {
    title: 'Measure',
    items: [
      ['Calibrate', 'Draw a line over a known length and enter the real-world distance to set the page Scale.'],
      ['Dimension', 'Click two points to dimension a length; the third click pulls the dimension line to an offset.'],
      ['Angle', 'Click three points to measure an angle.'],
    ],
  },
  {
    title: 'Page tools',
    items: [
      ['Overlay', 'Composite up to two other pages over the current one (with optional Multiply blend).'],
      ['Snip', 'Drag a region to copy it to the clipboard; paste places it with its lower-left at the cursor.'],
      ['Page Default bar', 'Sets the scale, colors, line weight/style and text size applied to new markups on the current page.'],
    ],
  },
];

function showHelpDialog(): void {
  const body = `
    <p class="help-intro">Markup Studio is a browser PDF viewer &amp; markup tool. Open or create a PDF, pick a tool from the ribbon, and draw on the page. Selected markups are edited in the Properties panel on the right; measurement totals appear below it. Use File ▸ Save to write your markups back into the PDF.</p>
    ${HELP_SECTIONS.map(
      (s) => `<div class="help-section"><h4>${s.title}</h4>${s.items
        .map(([name, desc]) => `<p><strong>${name}</strong> — ${desc}</p>`)
        .join('')}</div>`,
    ).join('')}
    <div class="help-section"><h4>Shortcuts</h4>
      <p>Ctrl/⌘ Z undo · Shift+Z redo · Ctrl/⌘ S save · Ctrl/⌘ C/V copy/paste · Delete removes · Esc cancels a draw or clears the selection.</p>
    </div>`;
  openModal('User guide', body, 560);
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

  const pageGroup = document.createElement('div');
  pageGroup.className = 'ribbon-group page-defaults';
  const pd = document.createElement('div');
  pd.className = 'page-default-controls';
  // Order: (Overlay, Snip prepended below) → Text Size, Line Weight, Line
  // Style, Scale, Stroke, Fill, Text
  pd.innerHTML = `
    <label>Text Size <select class="text-size">${TEXT_SIZE_OPTIONS.map((s) => `<option value="${s}" ${s === 12 ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
    <label>Line Weight <select class="line-weight">${LINE_WEIGHT_OPTIONS.map((w) => `<option value="${w}" ${w === 1 ? 'selected' : ''}>${w}</option>`).join('')}<option value="custom">Custom…</option></select></label>
    <label>Line Style <select class="line-style"><option value="solid">Solid</option><option value="dashed">Dash 1</option><option value="dotted">Dash 2</option><option value="centerline">Centerline</option><option value="cloud">Cloud</option></select></label>
    <label>Scale <select class="scale-select"><option>None</option>${ARCH_SCALES.map((s) => `<option>${s}</option>`).join('')}${ENG_SCALES.map((s) => `<option>${s}</option>`).join('')}<option value="Custom">Custom…</option></select></label>
    <label>Line <button type="button" class="color-box stroke-color" title="Line color"></button></label>
    <label>Fill <button type="button" class="color-box fill-color" title="Fill color"></button></label>
    <label>Text <button type="button" class="color-box text-color" title="Text color"></button></label>
  `;
  // Overlay + Snip icon buttons go first (left), following the Measure tools
  const overlayBtn = document.createElement('button');
  overlayBtn.className = 'tool-btn btn-overlay';
  overlayBtn.dataset.tip = 'Toggle Overlay';
  overlayBtn.innerHTML = TOOL_ICONS.overlay ?? '';

  const snipBtn = document.createElement('button');
  snipBtn.className = 'tool-btn btn-snip';
  snipBtn.dataset.tool = 'snip';
  snipBtn.dataset.tip = 'Snip Region  ·  S';
  snipBtn.innerHTML = TOOL_ICONS.snip ?? '';

  pd.prepend(snipBtn);
  pd.prepend(overlayBtn);

  pageGroup.appendChild(pd);
  ribbon.appendChild(pageGroup);

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

  pd.querySelector('.btn-overlay')?.addEventListener('click', () => {
    updateActiveDoc((d) => ({ ...d, overlayEnabled: !d.overlayEnabled }));
    // Derive visibility from state (not a blind toggle) so it can't drift
    const bar = root.querySelector('.overlay-bar')!;
    bar.classList.toggle('hidden', !(getActiveDoc()?.overlayEnabled ?? false));
    renderOverlayBar(root);
  });

  pd.querySelector('.btn-snip')?.addEventListener('click', () => setActiveTool('snip'));
}

const PANEL_MIN = 160;
const PANEL_MAX = 480;

function wirePanels(root: HTMLElement, _ws: Workspace): void {
  root.querySelector('.main-area')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.left-toggle')) {
      setState({ leftPanelVisible: !getState().leftPanelVisible });
      return;
    }
    if (target.closest('.right-toggle')) {
      setState({ rightPanelVisible: !getState().rightPanelVisible });
      return;
    }
  });

  wirePanelResize(root);

  root.querySelectorAll('.left-panel .panel-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      setState({ leftPanelTab: (btn as HTMLElement).dataset.tab as 'bookmarks' | 'thumbnails' });
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
    const width = Math.max(PANEL_MIN, Math.min(PANEL_MAX, e.clientX - rect.left));
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
    const width = Math.max(PANEL_MIN, Math.min(PANEL_MAX, rect.right - e.clientX));
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

  if (leftPanel) {
    leftPanel.classList.toggle('collapsed', !state.leftPanelVisible);
    leftPanel.style.width = state.leftPanelVisible ? `${state.leftPanelWidth}px` : '0';
  }
  if (rightPanel) {
    rightPanel.classList.toggle('collapsed', !state.rightPanelVisible);
    rightPanel.style.width = state.rightPanelVisible ? `${state.rightPanelWidth}px` : '0';
  }
  if (leftToggle) {
    leftToggle.textContent = state.leftPanelVisible ? '◀' : '▶';
    leftToggle.title = state.leftPanelVisible ? 'Hide left panel' : 'Show left panel';
    leftToggle.classList.toggle('panel-collapsed', !state.leftPanelVisible);
    leftToggle.classList.toggle('inside-panel', state.leftPanelVisible);
    if (state.leftPanelVisible) {
      // Tuck the button inside the panel (right edge just left of the resizer)
      leftToggle.style.left = `${state.leftPanelWidth - 4}px`;
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
      rightToggle.style.right = `${state.rightPanelWidth - 4}px`;
      rightToggle.style.transform = 'translate(100%, -50%)';
    } else {
      rightToggle.style.right = '0px';
      rightToggle.style.transform = 'translateY(-50%)';
    }
  }

  const filename = root.querySelector('.filename')!;
  filename.textContent = doc?.filename ?? 'Untitled';
  root.querySelector('.dirty-dot')?.classList.toggle('saved', !doc?.dirty);

  renderDocTabs(root);
  renderLeftPanel(root, ws);
  renderRightPanel(root);
  renderStatusBar(root);
  renderSplit(root, secondaryWs);

  const tool = state.activeTool;
  root.querySelectorAll('.tool-btn').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.tool === tool);
  });

  // Overlay button reflects overlayEnabled state, not the activeTool
  const overlayBtn = root.querySelector('.btn-overlay') as HTMLElement | null;
  if (overlayBtn) overlayBtn.classList.toggle('active', doc?.overlayEnabled ?? false);

  if (doc) {
    const defaults = doc.pageDefaults[doc.currentPage];
    root.querySelector('.hud-scale')!.textContent = `Scale: ${defaults?.scaleLabel ?? 'None'}`;
    root.querySelector('.page-label')!.textContent = `${doc.currentPage + 1}/${doc.pageCount}`;
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
    const tab = document.createElement('button');
    tab.className = 'doc-tab' + (doc.id === getState().activeDocId ? ' active' : '');
    tab.textContent = doc.filename;
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
  // Hint that this strip is a drop target for new files
  const hint = document.createElement('span');
  hint.className = 'drop-hint';
  hint.textContent = 'Drop PDF / JPG / PNG to open';
  tabs.appendChild(hint);
}

/** The doc-tab strip (below the menu, above the ribbon) accepts dropped PDF /
 *  JPEG / PNG files, opening each as a new document. */
function wireDropZone(root: HTMLElement): void {
  const zone = root.querySelector('.doc-tabs') as HTMLElement | null;
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

function renderLeftPanel(root: HTMLElement, ws: Workspace): void {
  const content = root.querySelector('.left-panel .panel-content') as HTMLElement | null;
  if (!content) return;
  const state = getState();
  const doc = getActiveDoc();

  if (state.leftPanelTab !== 'thumbnails') {
    // Tear down any running observer and clear
    _thumbObserver?.disconnect();
    _thumbObserver = null;
    _thumbDocId = null;
    content.innerHTML = '<p class="muted">PDF outline bookmarks appear here when available.</p>';
    return;
  }

  if (!doc?.pdfDoc) {
    content.innerHTML = '';
    return;
  }

  // Only rebuild the DOM when the document changes; otherwise just update active highlight
  if (doc.id !== _thumbDocId || content.querySelectorAll('.thumb-item').length !== doc.pageCount) {
    _thumbObserver?.disconnect();
    content.innerHTML = '';
    _thumbDocId = doc.id;

    if (!_thumbCache.has(doc.id)) _thumbCache.set(doc.id, new Map());
    const cache = _thumbCache.get(doc.id)!;
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
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  menu.innerHTML = `
    <label class="ctx-row">Size <select class="ctx-size-select">${Object.keys(PAGE_SIZES).map((k) => `<option value="${k}">${k}</option>`).join('')}</select></label>
    <button data-action="insert-before">Insert page before</button>
    <button data-action="insert-after">Insert page after</button>
    <button data-action="rotate-90">Rotate 90°</button>
    <button data-action="rotate-180">Rotate 180°</button>
  `;
  document.body.appendChild(menu);
  const close = () => menu.remove();
  menu.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = (btn as HTMLElement).dataset.action!;
      const sizeKey = (menu.querySelector('.ctx-size-select') as HTMLSelectElement | null)?.value ?? 'ARCH D';
      if (action === 'insert-before') await insertBlankPage(docId, pageIndex, sizeKey);
      if (action === 'insert-after') await insertBlankPage(docId, pageIndex + 1, sizeKey);
      if (action === 'rotate-90') await rotatePage(docId, pageIndex, 90);
      if (action === 'rotate-180') await rotatePage(docId, pageIndex, 180);
      close();
    });
  });
  setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
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
  totalsBlock.innerHTML = renderTotals(doc);

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
    // Item name prominent; the id/description dimmed so it doesn't compete
    const name = document.createElement('span');
    name.className = 'mk-name';
    name.textContent = m.type;
    const idSpan = document.createElement('span');
    idSpan.className = 'mk-id';
    idSpan.textContent = m.description ?? m.id.slice(0, 6);
    li.append(name, document.createTextNode(' '), idSpan);
    wireMarkupRowDrag(li, m.id, list as HTMLElement);
    list.appendChild(li);
  }
}

/** Drag a row up/down to reorder draw order, with a floating clone and a drop
 *  line. A plain click (no drag) selects the markup. */
function wireMarkupRowDrag(li: HTMLElement, id: string, list: HTMLElement): void {
  li.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
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
  // Standard palette swatches + the color input as "More Colors…"
  const swatches = `<div class="prop-swatches">${SWATCH_COLORS.map(
    (c) => `<button class="swatch ${c === stroke ? 'active' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`,
  ).join('')}</div>`;

  // Infill control (rectangle/ellipse/polygon/text/callout/area)
  let fillSection = '';
  if (FILL_BEARING_TYPES.includes(m.type)) {
    const fillResolved = m.overrides?.fillColor !== undefined ? m.overrides.fillColor : (defaults?.fillColor ?? null);
    const fillOn = !!fillResolved;
    const fillVal = fillResolved ?? DEFAULT_COLOR;
    const fillSwatches = `<div class="prop-swatches" data-fill-swatches ${fillOn ? '' : 'style="display:none"'}>${SWATCH_COLORS.map(
      (c) => `<button class="swatch ${c === fillResolved ? 'active' : ''}" data-fill-color="${c}" style="background:${c}" title="${c}"></button>`,
    ).join('')}</div>`;
    fillSection = `
    <label>Infill <input type="checkbox" data-fill-enable ${fillOn ? 'checked' : ''}> <input type="color" class="prop-color" data-prop="fillColor" value="${fillVal}" ${fillOn ? '' : 'disabled'} title="Fill color"></label>
    ${fillSwatches}`;
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
    const sizeOpts = TEXT_SIZE_OPTIONS.map((s) => `<option value="${s}" ${s === fontSize ? 'selected' : ''}>${s}</option>`).join('') +
      (TEXT_SIZE_OPTIONS.includes(fontSize) ? '' : `<option value="${fontSize}" selected>${fontSize}</option>`);
    textSection = `
    <hr>
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

  return `<div class="prop-block"><strong>${m.type}</strong><p>Page ${m.pageIndex + 1}</p>
    <label>Color <input type="color" class="prop-color" data-prop="strokeColor" value="${stroke}" title="More colors…"></label>
    ${swatches}
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

  // Standard-palette swatches set the stroke color (skip the fill swatches)
  props.querySelectorAll<HTMLButtonElement>('.prop-swatches:not([data-fill-swatches]) .swatch[data-color]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const doc = getActiveDoc();
      const m = doc?.markups.find((mk) => mk.id === selectedId);
      if (!doc || !m) return;
      const color = btn.dataset.color!;
      const next = doc.markups.map((mk) =>
        mk.id === selectedId ? { ...mk, overrides: { ...mk.overrides, strokeColor: color } } : mk,
      );
      import('../state/undo').then(({ applyMarkupChange }) =>
        applyMarkupChange('Edit properties', next),
      );
    });
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

  // Infill enable/disable toggle
  const fillEnable = props.querySelector<HTMLInputElement>('[data-fill-enable]');
  fillEnable?.addEventListener('change', () => {
    const colorInput = props.querySelector<HTMLInputElement>('[data-prop="fillColor"]');
    setFill(fillEnable.checked ? (colorInput?.value || DEFAULT_COLOR) : null);
  });

  // Infill palette swatches
  props.querySelectorAll<HTMLButtonElement>('[data-fill-color]').forEach((btn) => {
    btn.addEventListener('click', () => setFill(btn.dataset.fillColor!));
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

function renderTotals(doc: ReturnType<typeof getActiveDoc>): string {
  if (!doc) return '';
  const page = doc.currentPage;
  const defaults = doc.pageDefaults[page];
  const markups = doc.markups.filter((m) => m.pageIndex === page);
  let linear = 0;
  let polyLen = 0;
  let area = 0;
  for (const m of markups) {
    if (m.type === 'dimension') linear += dist({ x: m.x1, y: m.y1 }, { x: m.x2, y: m.y2 });
    if (m.type === 'polyline' && m.showLength) polyLen += polylineLength(m.points);
    if (m.type === 'polygon' && m.showArea) area += polygonArea(m.points);
  }
  const sf = defaults?.scaleFactor ?? null;
  return `<h4>Totals</h4><div class="totals">
    <p>Linear: ${formatLength(linear, sf)}</p>
    <p>Polyline: ${formatLength(polyLen, sf)}</p>
    <p>Area: ${formatArea(area, sf)}</p>
  </div>`;
}

function renderStatusBar(root: HTMLElement): void {
  const doc = getActiveDoc();
  const state = getState();
  const bar = root.querySelector('.status-bar')!;
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
  const bar = root.querySelector('.overlay-bar')!;
  if (!doc?.overlayEnabled) return;
  bar.innerHTML = '';
  for (let slot = 0; slot < 2; slot++) {
    const row = document.createElement('div');
    row.className = 'overlay-slot';
    const select = document.createElement('select');
    select.innerHTML = `<option value="">— Page —</option>${Array.from({ length: doc.pageCount }, (_, i) => `<option value="${i}">Page ${i + 1}</option>`).join('')}`;
    const opacity = document.createElement('select');
    opacity.innerHTML = ['20', '40', '60', '80'].map((v) => `<option value="${v}">${v}%</option>`).join('');
    const current = doc.overlays[slot];
    if (current) {
      select.value = String(current.pageIndex);
      opacity.value = String(Math.round(current.opacity * 100));
    }
    select.addEventListener('change', () => {
      // '' (the "— Page —" placeholder) must clear the slot; Number('') is 0,
      // which would wrongly select page 1, so check for empty string first.
      const cleared = select.value === '';
      const pageIndex = Number(select.value);
      updateActiveDoc((d) => {
        const overlays = [...d.overlays] as typeof d.overlays;
        overlays[slot] = !cleared && Number.isFinite(pageIndex)
          ? { pageIndex, opacity: Number(opacity.value) / 100 }
          : null;
        return { ...d, overlays };
      });
    });
    opacity.addEventListener('change', () => {
      updateActiveDoc((d) => {
        const overlays = [...d.overlays] as typeof d.overlays;
        const cur = overlays[slot];
        if (cur) overlays[slot] = { ...cur, opacity: Number(opacity.value) / 100 };
        return { ...d, overlays };
      });
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

export { SWATCH_COLORS, PAGE_SIZES };
