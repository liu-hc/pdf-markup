import type { PDFDocumentProxy } from 'pdfjs-dist';

/** One search match: page, context snippet split around the match, and the
 *  match's approximate rectangle in page coordinates (pt, y-up). */
export interface SearchHit {
  pageIndex: number;
  before: string;
  match: string;
  after: string;
  rect: { x: number; y: number; w: number; h: number };
}

interface PageText {
  raw: string;
  lower: string;
  spans: { start: number; end: number; x: number; y: number; w: number; h: number; len: number }[];
}

/** Per-document text index, keyed on the pdfDoc proxy itself — page edits
 *  replace the proxy, so stale indexes fall away automatically. */
const indexCache = new WeakMap<PDFDocumentProxy, (PageText | null)[]>();

async function getPageText(pdfDoc: PDFDocumentProxy, pageIndex: number): Promise<PageText> {
  let pages = indexCache.get(pdfDoc);
  if (!pages) {
    pages = new Array<PageText | null>(pdfDoc.numPages).fill(null);
    indexCache.set(pdfDoc, pages);
  }
  const cached = pages[pageIndex];
  if (cached) return cached;

  const page = await pdfDoc.getPage(pageIndex + 1);
  const tc = await page.getTextContent();
  let raw = '';
  const spans: PageText['spans'] = [];
  for (const item of tc.items as {
    str?: string;
    transform?: number[];
    width?: number;
    height?: number;
  }[]) {
    const str = item.str;
    if (!str) continue;
    const start = raw.length;
    raw += str;
    spans.push({
      start,
      end: raw.length,
      x: item.transform?.[4] ?? 0,
      y: item.transform?.[5] ?? 0,
      w: item.width ?? 0,
      h: item.height || Math.abs(item.transform?.[3] ?? 0) || 10,
      len: str.length,
    });
    raw += ' '; // joiner between runs so words don't fuse
  }
  const data: PageText = { raw, lower: raw.toLowerCase(), spans };
  pages[pageIndex] = data;
  return data;
}

const MAX_HITS = 300;
const CONTEXT = 40;

/** Case-insensitive full-document text search, results in page order. */
export async function searchDocument(
  pdfDoc: PDFDocumentProxy,
  query: string,
  onProgress?: (page: number, total: number) => void,
): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  for (let i = 0; i < pdfDoc.numPages && hits.length < MAX_HITS; i++) {
    onProgress?.(i + 1, pdfDoc.numPages);
    const d = await getPageText(pdfDoc, i);
    let idx = 0;
    while (hits.length < MAX_HITS) {
      idx = d.lower.indexOf(q, idx);
      if (idx === -1) break;
      const s0 = Math.max(0, idx - CONTEXT);
      const s1 = Math.min(d.raw.length, idx + q.length + CONTEXT);
      // Approximate the match rect from its containing text run (offsets map
      // proportionally into the run's width)
      const span = d.spans.find((sp) => idx >= sp.start && idx < sp.end) ?? d.spans.find((sp) => sp.end > idx);
      let rect = { x: 0, y: 0, w: 40, h: 12 };
      if (span) {
        const off = Math.max(0, idx - span.start);
        const frac = span.len > 0 ? off / span.len : 0;
        const wFrac = span.len > 0 ? Math.min(1, q.length / span.len) : 1;
        rect = {
          x: span.x + frac * span.w,
          y: span.y,
          w: Math.max(6, wFrac * span.w),
          h: Math.max(6, span.h),
        };
      }
      hits.push({
        pageIndex: i,
        before: (s0 > 0 ? '…' : '') + d.raw.slice(s0, idx),
        match: d.raw.slice(idx, idx + q.length),
        after: d.raw.slice(idx + q.length, s1) + (s1 < d.raw.length ? '…' : ''),
        rect,
      });
      idx += q.length;
    }
  }
  return hits;
}
