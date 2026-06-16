import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Markup } from '../state/types';

const META_KEY = 'MarkupStudioData';

export async function parseMarkupsFromMetadata(bytes: Uint8Array): Promise<Markup[]> {
  try {
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.load(bytes);
    const subject = pdf.getSubject();
    if (!subject?.startsWith(META_KEY + ':')) return [];
    const json = subject.slice(META_KEY.length + 1);
    return JSON.parse(json) as Markup[];
  } catch {
    return [];
  }
}

export async function parseMarkupsFromAnnotations(pdfDoc: PDFDocumentProxy): Promise<Markup[]> {
  const markups: Markup[] = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const annotations = await page.getAnnotations();
    for (const ann of annotations) {
      const m = annotationToMarkup(ann, i - 1);
      if (m) markups.push(m);
    }
  }
  return markups;
}

function annotationToMarkup(ann: Record<string, unknown>, pageIndex: number): Markup | null {
  const subtype = ann.subtype as string | undefined;
  const rect = ann.rect as number[] | undefined;
  if (!rect || rect.length < 4) return null;
  const id = crypto.randomUUID();
  const [x1, y1, x2, y2] = rect;
  const x = Math.min(x1!, x2!);
  const y = Math.min(y1!, y2!);
  const width = Math.abs(x2! - x1!);
  const height = Math.abs(y2! - y1!);

  if (subtype === 'Square') {
    return {
      id,
      type: 'rectangle',
      pageIndex,
      x,
      y,
      width,
      height,
    };
  }
  if (subtype === 'Circle') {
    return {
      id,
      type: 'ellipse',
      pageIndex,
      cx: x + width / 2,
      cy: y + height / 2,
      rx: width / 2,
      ry: height / 2,
    };
  }
  if (subtype === 'Line') {
    return {
      id,
      type: 'line',
      pageIndex,
      x1: x1!,
      y1: y1!,
      x2: x2!,
      y2: y2!,
    };
  }
  if (subtype === 'FreeText') {
    return {
      id,
      type: 'text',
      pageIndex,
      x,
      y,
      width,
      height,
      content: (ann.contents as string) ?? '',
    };
  }
  if (subtype === 'Text') {
    return {
      id,
      type: 'sticky',
      pageIndex,
      x,
      y,
      content: (ann.contents as string) ?? '',
    };
  }
  return null;
}

export { META_KEY };
