import type { PDFPageProxy } from 'pdfjs-dist';

/** Set up the canvas and start rendering. Returns the RenderTask so the caller
 *  can cancel it before starting a new render on the same canvas.
 *  NOTE: no `rotation` argument — PDF.js applies the page's native /Rotate
 *  automatically via getViewport(); passing page.rotate a second time was
 *  double-applying the rotation and caused upside-down rendering on some PDFs. */
export function renderPageToCanvas(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  scale: number,
): { task: { cancel: () => void; promise: Promise<void> }; width: number; height: number } {
  const viewport = page.getViewport({ scale }); // PDF.js applies /Rotate automatically
  const ctx = canvas.getContext('2d')!;
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  const task = page.render({ canvasContext: ctx, viewport, canvas });
  return { task, width: viewport.width, height: viewport.height };
}

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
