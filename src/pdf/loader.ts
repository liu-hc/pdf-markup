// Use the LEGACY build: the modern build of pdfjs v6 assumes very new JS
// engine features (Math.sumPrecise, Map.getOrInsertComputed, …) and breaks
// on Chrome versions that lack them. The legacy build polyfills these.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  createEmptyDoc,
  getState,
  setState,
  updateDoc,
  ensurePageDefaults,
  uid,
} from '../state/store';
import type { PageInfo } from '../state/types';
import { DEFAULT_PAGE_DEFAULTS } from '../state/types';
import { parseMarkupsFromMetadata, parseMarkupsFromAnnotations } from './importMarkups';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export async function loadPdfFromFile(
  file: File,
  handle: FileSystemFileHandle | null = null,
): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdfDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const id = uid();
  const doc = createEmptyDoc(id, file.name);
  doc.fileHandle = handle;
  doc.pdfDoc = pdfDoc;
  doc.pdfBytes = bytes;
  doc.pageCount = pdfDoc.numPages;
  doc.pages = await loadPageInfos(pdfDoc);
  doc.pageDefaults = Array.from({ length: doc.pageCount }, () => ({ ...DEFAULT_PAGE_DEFAULTS }));

  const metaMarkups = await parseMarkupsFromMetadata(bytes);
  if (metaMarkups.length) {
    doc.markups = metaMarkups;
  } else {
    doc.markups = await parseMarkupsFromAnnotations(pdfDoc);
  }

  setState({
    documents: [...getState().documents, doc],
    activeDocId: id,
  });
  return id;
}

/** Create a blank PDF (N pages of the given paper size + orientation) and
 *  open it as a new document. Returns the new doc id. */
export async function createBlankDocument(
  sizeKey: string,
  pageCount: number,
  landscape: boolean,
): Promise<string> {
  const { PAGE_SIZES } = await import('../state/types');
  const base = PAGE_SIZES[sizeKey] ?? PAGE_SIZES['8.5 x 11']!;
  const w = landscape ? base.h : base.w;
  const h = landscape ? base.w : base.h;
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const n = Math.max(1, Math.min(500, Math.floor(pageCount) || 1));
  for (let i = 0; i < n; i++) pdf.addPage([w, h]);
  const bytes = new Uint8Array(await pdf.save());
  const file = new File([bytes], 'Untitled.pdf', { type: 'application/pdf' });
  return loadPdfFromFile(file, null);
}

/** Wrap a JPEG/PNG in a single-page PDF (page sized to the image) and open it. */
export async function openImageAsDocument(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const isPng = file.type === 'image/png' || /\.png$/i.test(file.name);
  const img = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
  const page = pdf.addPage([img.width, img.height]);
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  const out = new Uint8Array(await pdf.save());
  const name = file.name.replace(/\.(png|jpe?g)$/i, '.pdf');
  const pdfFile = new File([out], name, { type: 'application/pdf' });
  return loadPdfFromFile(pdfFile, null);
}

/** Open a dropped/selected file as a new document, if it's a supported type. */
export async function openDroppedFile(file: File): Promise<boolean> {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    await loadPdfFromFile(file, null);
    return true;
  }
  if (file.type === 'image/png' || file.type === 'image/jpeg' || /\.(png|jpe?g)$/i.test(file.name)) {
    await openImageAsDocument(file);
    return true;
  }
  return false;
}

async function loadPageInfos(pdfDoc: PDFDocumentProxy): Promise<PageInfo[]> {
  const pages: PageInfo[] = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    // Let PDF.js apply /Rotate automatically; passing page.rotate again doubles it
    const vp = page.getViewport({ scale: 1 });
    pages.push({ width: vp.width, height: vp.height, rotation: page.rotate });
  }
  return pages;
}

export async function openFilePicker(): Promise<void> {
  if (!('showOpenFilePicker' in window)) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,application/pdf';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) await loadPdfFromFile(file, null);
    };
    input.click();
    return;
  }
  const w = window as Window & {
    showOpenFilePicker: (opts: object) => Promise<FileSystemFileHandle[]>;
  };
  const [handle] = await w.showOpenFilePicker({
    types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
    multiple: false,
  });
  const file = await handle.getFile();
  await loadPdfFromFile(file, handle);
}

export async function saveDocument(docId: string, saveAs = false): Promise<void> {
  const doc = getState().documents.find((d) => d.id === docId);
  if (!doc || !doc.pdfBytes) return;

  const { exportPdf } = await import('./export');
  const bytes = await exportPdf(doc);

  let handle = doc.fileHandle;
  if (saveAs || !handle) {
    if (!('showSaveFilePicker' in window)) {
      downloadBytes(bytes, doc.filename);
      return;
    }
    const w = window as Window & {
      showSaveFilePicker: (opts: object) => Promise<FileSystemFileHandle>;
    };
    handle = await w.showSaveFilePicker({
      suggestedName: doc.filename,
      types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
    });
    updateDoc(docId, (d) => ({ ...d, fileHandle: handle, filename: handle!.name }));
  }

  const writable = await handle!.createWritable();
  await writable.write(new Blob([new Uint8Array(bytes)]));
  await writable.close();
  updateDoc(docId, (d) => ({ ...d, pdfBytes: bytes, dirty: false }));
}

export async function flattenDocument(docId: string): Promise<void> {
  const doc = getState().documents.find((d) => d.id === docId);
  if (!doc) return;
  const { flattenPdf } = await import('./export');
  const bytes = await flattenPdf(doc);
  const pdfDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  updateDoc(docId, (d) => ({
    ...d,
    pdfBytes: bytes,
    pdfDoc,
    markups: [],
    flattened: true,
    dirty: true,
  }));
}

function downloadBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function insertBlankPage(
  docId: string,
  atIndex: number,
  sizeKey: string,
): Promise<void> {
  const { PAGE_SIZES } = await import('../state/types');
  const size = PAGE_SIZES[sizeKey] ?? PAGE_SIZES['ARCH D']!;
  const doc = getState().documents.find((d) => d.id === docId);
  if (!doc) return;

  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.load(doc.pdfBytes!);
  pdf.insertPage(atIndex, [size.w, size.h]);
  const bytes = new Uint8Array(await pdf.save());
  const pdfDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const pages = await loadPageInfos(pdfDoc);
  const defaults = ensurePageDefaults(doc);
  defaults.splice(atIndex, 0, { ...DEFAULT_PAGE_DEFAULTS });

  updateDoc(docId, (d) => ({
    ...d,
    pdfBytes: bytes,
    pdfDoc,
    pageCount: pdfDoc.numPages,
    pages,
    pageDefaults: defaults,
    markups: d.markups.map((m) =>
      m.pageIndex >= atIndex ? { ...m, pageIndex: m.pageIndex + 1 } : m,
    ),
    dirty: true,
  }));
}

export async function rotatePage(docId: string, pageIndex: number, degrees: 90 | 180): Promise<void> {
  const doc = getState().documents.find((d) => d.id === docId);
  if (!doc?.pdfBytes) return;
  const { PDFDocument, degrees: deg } = await import('pdf-lib');
  const pdf = await PDFDocument.load(doc.pdfBytes);
  const page = pdf.getPage(pageIndex);
  const current = page.getRotation().angle;
  page.setRotation(deg(current + degrees));
  const bytes = new Uint8Array(await pdf.save());
  const pdfDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const pages = await loadPageInfos(pdfDoc);
  updateDoc(docId, (d) => ({
    ...d,
    pdfBytes: bytes,
    pdfDoc,
    pages,
    dirty: true,
  }));
}

export type { PDFDocumentProxy };
