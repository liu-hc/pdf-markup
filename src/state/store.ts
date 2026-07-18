import type { AppState, Markup, PageDefaults, PdfDocumentState, Point, ToolId } from './types';
import { DEFAULT_PAGE_DEFAULTS } from './types';

type Listener = () => void;

let state: AppState = {
  documents: [],
  activeDocId: null,
  activeTool: 'flip',
  lastNavTool: 'select',
  selectedMarkupIds: [],
  cursorPagePoint: null,
  leftPanelVisible: true,
  rightPanelVisible: true,
  leftPanelWidth: 220,
  rightPanelWidth: 220,
  leftPanelTab: 'thumbnails',
  rightPanelTab: 'properties',
};

const listeners = new Set<Listener>();

export function getState(): AppState {
  return state;
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setState(partial: Partial<AppState>): void {
  state = { ...state, ...partial };
  listeners.forEach((fn) => fn());
}

export function getActiveDoc(): PdfDocumentState | null {
  if (!state.activeDocId) return null;
  return state.documents.find((d) => d.id === state.activeDocId) ?? null;
}

export function updateActiveDoc(updater: (doc: PdfDocumentState) => PdfDocumentState): void {
  const id = state.activeDocId;
  if (!id) return;
  setState({
    documents: state.documents.map((d) => (d.id === id ? updater(d) : d)),
  });
}

export function updateDoc(docId: string, updater: (doc: PdfDocumentState) => PdfDocumentState): void {
  setState({
    documents: state.documents.map((d) => (d.id === docId ? updater(d) : d)),
  });
}

export function createEmptyDoc(id: string, filename: string): PdfDocumentState {
  return {
    id,
    filename,
    fileHandle: null,
    pdfDoc: null,
    pdfBytes: null,
    pageCount: 0,
    pages: [],
    pageDefaults: [],
    markups: [],
    currentPage: 0,
    zoom: 1,
    viewMode: 'single',
    dirty: false,
    flattened: false,
    splitMode: 'none',
    splitRatio: 0.5,
    overlayEnabled: false,
    overlaysByPage: {},
    // Multiply is the default blend — linework composites like tracing paper
    overlayMultiply: true,
    clipboard: null,
    bookmarks: [],
  };
}

export function setActiveTool(tool: ToolId): void {
  setState({
    activeTool: tool,
    selectedMarkupIds: [],
    // Remember the Navigate tool so markup tools can return to it when done
    ...(tool === 'select' || tool === 'zoom' ? { lastNavTool: tool } : {}),
  });
}

/** Restore the Navigate tool (select or zoom) that was active before a
 *  markup tool was picked. Called whenever a markup tool finishes. */
export function returnToNavTool(): void {
  setActiveTool(state.lastNavTool);
}

const NAV_TOOLS: readonly ToolId[] = ['select', 'flip', 'zoom', 'pan'];

export function selectMarkups(ids: string[]): void {
  // Selecting from a drawing tool switches to Select; selecting while on a
  // navigation tool (flip/zoom/pan) keeps that tool — markups are clickable
  // and editable from every navigation mode.
  const keepTool = NAV_TOOLS.includes(state.activeTool);
  setState({
    selectedMarkupIds: ids,
    activeTool: ids.length && !keepTool ? 'select' : state.activeTool,
    ...(ids.length && !keepTool ? { lastNavTool: 'select' as const } : {}),
  });
}

export function setCursorPagePoint(p: Point | null): void {
  setState({ cursorPagePoint: p });
}

export function addMarkup(markup: Markup, markDirty = true): void {
  updateActiveDoc((doc) => ({
    ...doc,
    markups: [...doc.markups, markup],
    dirty: markDirty ? true : doc.dirty,
  }));
}

export function updateMarkup(id: string, updater: (m: Markup) => Markup): void {
  updateActiveDoc((doc) => ({
    ...doc,
    markups: doc.markups.map((m) => (m.id === id ? updater(m) : m)),
    dirty: true,
  }));
}

export function removeMarkups(ids: string[]): void {
  updateActiveDoc((doc) => ({
    ...doc,
    markups: doc.markups.filter((m) => !ids.includes(m.id)),
    dirty: true,
  }));
  setState({ selectedMarkupIds: state.selectedMarkupIds.filter((id) => !ids.includes(id)) });
}

export function replaceMarkups(markups: Markup[]): void {
  updateActiveDoc((doc) => ({ ...doc, markups, dirty: true }));
}

export function ensurePageDefaults(doc: PdfDocumentState): PageDefaults[] {
  const defaults = [...doc.pageDefaults];
  while (defaults.length < doc.pageCount) {
    defaults.push({ ...DEFAULT_PAGE_DEFAULTS });
  }
  return defaults;
}

export function uid(): string {
  return crypto.randomUUID();
}

export function markSaved(): void {
  updateActiveDoc((doc) => ({ ...doc, dirty: false }));
}

export function closeDocument(docId: string): void {
  const docs = state.documents.filter((d) => d.id !== docId);
  let activeDocId = state.activeDocId;
  if (activeDocId === docId) {
    activeDocId = docs.length ? docs[docs.length - 1]!.id : null;
  }
  setState({ documents: docs, activeDocId });
}
