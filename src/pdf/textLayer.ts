import type { PDFDocumentProxy } from 'pdfjs-dist';

/** A run of text on a page, in page coordinates (y-up, points) — matching the
 *  markup coordinate space. Built lazily from PDF.js getTextContent(). */
export interface TextBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** docId → pageIndex → text boxes (in reading / content-stream order). */
const cache = new Map<string, Map<number, TextBox[]>>();
const loading = new Set<string>();

function key(docId: string, pageIndex: number): string {
  return `${docId}:${pageIndex}`;
}

/** Synchronous read — returns null until the page's text has been loaded. */
export function getTextBoxesSync(docId: string, pageIndex: number): TextBox[] | null {
  return cache.get(docId)?.get(pageIndex) ?? null;
}

/** Lazily extract and cache the text boxes for one page. Safe to call often;
 *  concurrent calls for the same page coalesce. */
export async function ensureTextBoxes(
  docId: string,
  pdfDoc: PDFDocumentProxy,
  pageIndex: number,
): Promise<TextBox[]> {
  const existing = cache.get(docId)?.get(pageIndex);
  if (existing) return existing;
  const lk = key(docId, pageIndex);
  if (loading.has(lk)) return [];
  loading.add(lk);
  try {
    const page = await pdfDoc.getPage(pageIndex + 1);
    const content = await page.getTextContent();
    const boxes: TextBox[] = [];
    for (const item of content.items as Array<Record<string, unknown>>) {
      if (!Array.isArray(item.transform)) continue;
      const str = (item.str as string) ?? '';
      if (!str.trim()) continue;
      const t = item.transform as number[];
      const h = (item.height as number) || Math.abs(t[3]!) || 10;
      const w = (item.width as number) || 0;
      if (w <= 0) continue;
      // transform translation (t[4], t[5]) is the glyph-run baseline origin in
      // PDF user space (points, y-up) — the same space as our page coords.
      boxes.push({ x: t[4]!, y: t[5]! - 0.2 * h, w, h });
    }
    let docMap = cache.get(docId);
    if (!docMap) {
      docMap = new Map();
      cache.set(docId, docMap);
    }
    docMap.set(pageIndex, boxes);
    return boxes;
  } catch {
    return [];
  } finally {
    loading.delete(lk);
  }
}

/** Drop a document's cached text (e.g. on flatten / close). */
export function clearTextBoxes(docId: string): void {
  cache.delete(docId);
}
