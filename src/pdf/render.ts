import type { PDFPageProxy } from 'pdfjs-dist';

/* NOTE: page rendering happens inside PageView (offscreen render + blit with
   a capped base bitmap and a visible-region detail pass). PDF.js applies the
   page's native /Rotate automatically via getViewport() — never pass
   page.rotate again, it double-applies and flips some CAD exports. */

export async function renderThumbnail(
  page: PDFPageProxy,
  maxWidth: number,
): Promise<string> {
  const baseVp = page.getViewport({ scale: 1 });
  const scale = maxWidth / baseVp.width;
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = vp.width;
  canvas.height = vp.height;
  const ctx = canvas.getContext('2d')!;
  await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
  return canvas.toDataURL();
}

export async function getOutline(pdfDoc: { getOutline: () => Promise<unknown> }): Promise<
  { title: string; pageIndex: number; children: unknown[] }[]
> {
  try {
    const outline = await pdfDoc.getOutline();
    if (!outline || !Array.isArray(outline)) return [];
    return flattenOutline(outline);
  } catch {
    return [];
  }
}

async function flattenOutline(
  items: unknown[],
  depth = 0,
): Promise<{ title: string; pageIndex: number; children: unknown[] }[]> {
  const result: { title: string; pageIndex: number; children: unknown[] }[] = [];
  for (const item of items) {
    const o = item as { title: string; dest?: unknown; items?: unknown[] };
    result.push({
      title: o.title,
      pageIndex: 0,
      children: o.items ? await flattenOutline(o.items, depth + 1) : [],
    });
  }
  return result;
}
