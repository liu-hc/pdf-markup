import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { BookmarkItem, Markup } from '../state/types';

const META_KEY = 'MarkupStudioData';

export interface StudioMetadata {
  markups: Markup[];
  bookmarks: BookmarkItem[];
}

/** Parse the Subject metadata. Old files stored a bare markups array; new
 *  files store `{ markups, bookmarks }` — both are accepted. */
export async function parseMarkupsFromMetadata(bytes: Uint8Array): Promise<StudioMetadata> {
  try {
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.load(bytes);
    const subject = pdf.getSubject();
    if (!subject?.startsWith(META_KEY + ':')) return { markups: [], bookmarks: [] };
    const json = subject.slice(META_KEY.length + 1);
    const parsed = JSON.parse(json) as Markup[] | { markups?: Markup[]; bookmarks?: BookmarkItem[] };
    if (Array.isArray(parsed)) return { markups: parsed, bookmarks: [] };
    return { markups: parsed.markups ?? [], bookmarks: parsed.bookmarks ?? [] };
  } catch {
    return { markups: [], bookmarks: [] };
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

/** PDF annotation flag bits (PDF 32000-1, table 165). */
const FLAG_HIDDEN = 2;
const FLAG_NOVIEW = 32;

/** An annotation colour array from pdf.js (0-255 RGB) as a hex string. */
function annColor(c: unknown): string | null {
  if (!c || typeof (c as ArrayLike<number>).length !== 'number') return null;
  const a = c as ArrayLike<number>;
  if (a.length < 3) return null;
  const hex = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${hex(a[0]!)}${hex(a[1]!)}${hex(a[2]!)}`;
}

/**
 * Would a PDF viewer draw anything for this annotation?
 *
 * This matters because a CAD PDF can carry hundreds of annotations that are
 * pure metadata. AutoCAD's plot driver, for one, emits a /Square per run of
 * SHX text — title "AutoCAD SHX Text", contents set to the text, but no
 * colour and a zero-width border. Nothing renders them, which is why they are
 * invisible in every other viewer; adopting them as editable markups spattered
 * the drawing with hundreds of phantom boxes that the user never drew.
 *
 * The rule is the one the spec implies: with no stroke colour and no interior
 * colour there is nothing to paint, so there is no markup to adopt.
 */
function annotationIsVisible(ann: Record<string, unknown>): boolean {
  const flags = (ann.annotationFlags as number) ?? 0;
  if (flags & FLAG_HIDDEN || flags & FLAG_NOVIEW) return false;

  const stroke = annColor(ann.color);
  const fill = annColor(ann.backgroundColor);
  const width = (ann.borderStyle as { width?: number } | undefined)?.width ?? 0;

  // Text-bearing annotations show their content even without a border
  const subtype = ann.subtype as string | undefined;
  if (subtype === 'FreeText' || subtype === 'Text') {
    const text = (ann.contentsObj as { str?: string } | undefined)?.str ?? (ann.contents as string) ?? '';
    return !!(text.trim() || stroke || fill);
  }

  // Shapes need something to draw: a stroke with width, or an interior fill
  if (fill) return true;
  return !!stroke && width > 0;
}

function annotationToMarkup(ann: Record<string, unknown>, pageIndex: number): Markup | null {
  const subtype = ann.subtype as string | undefined;
  const rect = ann.rect as number[] | undefined;
  if (!rect || rect.length < 4) return null;
  if (!annotationIsVisible(ann)) return null;

  const id = crypto.randomUUID();
  const [x1, y1, x2, y2] = rect;
  const x = Math.min(x1!, x2!);
  const y = Math.min(y1!, y2!);
  const width = Math.abs(x2! - x1!);
  const height = Math.abs(y2! - y1!);
  if (width < 0.5 && height < 0.5) return null;

  // Carry the annotation's own appearance across, so an imported markup looks
  // like it did in the source rather than taking this app's default styling.
  const stroke = annColor(ann.color);
  const fill = annColor(ann.backgroundColor);
  const lineWeight = (ann.borderStyle as { width?: number } | undefined)?.width;
  const overrides: Record<string, unknown> = {};
  if (stroke) overrides.strokeColor = stroke;
  if (fill) overrides.fillColor = fill;
  if (lineWeight && lineWeight > 0) overrides.lineWeight = lineWeight;
  const styled = Object.keys(overrides).length ? { overrides } : {};
  const text = (ann.contentsObj as { str?: string } | undefined)?.str ?? (ann.contents as string) ?? '';

  if (subtype === 'Square') {
    return { id, type: 'rectangle', pageIndex, x, y, width, height, ...styled };
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
      ...styled,
    };
  }
  if (subtype === 'Line') {
    return { id, type: 'line', pageIndex, x1: x1!, y1: y1!, x2: x2!, y2: y2!, ...styled };
  }
  if (subtype === 'FreeText') {
    return { id, type: 'text', pageIndex, x, y, width, height, content: text, ...styled };
  }
  if (subtype === 'Text') {
    return { id, type: 'sticky', pageIndex, x, y, content: text, ...styled };
  }
  return null;
}

export { META_KEY };
