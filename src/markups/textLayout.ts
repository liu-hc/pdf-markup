/**
 * Paragraph layout for text boxes and callouts.
 *
 * One engine, two renderers. The canvas and the PDF exporter both call
 * `layoutParagraphs`, differing only in how they measure a string — so what
 * you type on screen is what lands in the saved file, list markers, mixed
 * sizes and hanging indents included. If the two ever disagree, the bug is
 * here rather than in either renderer.
 */
import type { ListStyle, TextParagraph } from '../state/types';
import { DEFAULT_TEXT_MARGIN } from '../state/types';

/** One indent step, in page points. */
export const INDENT_STEP = 12;

/** Gap between a list marker and its text, as a multiple of the font size. */
const MARKER_GAP = 0.45;

/** Box-level formatting a paragraph falls back to. */
export interface BlockStyle {
  fontSize: number;
  fontFamily: string;
  lineSpacing: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  indent: number;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
  margin: number;
}

/** A paragraph with every fallback already applied. */
export interface ResolvedParagraph {
  text: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: 'left' | 'center' | 'right';
  indent: number;
  list: ListStyle;
  /** Marker to draw before the first line, already numbered ("3.", "c.", "•"). */
  marker: string;
}

/** One laid-out line, ready to paint. */
export interface LaidOutLine {
  text: string;
  /** Marker for this line — only ever set on a paragraph's first line. */
  marker: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: 'left' | 'center' | 'right';
  /** Left offset from the text area's left edge, in points. */
  x: number;
  /** Baseline-box top, relative to the start of the block, in points. */
  y: number;
  /** Width available to this line — what alignment centres within. */
  width: number;
  /** Line box height (size x lineSpacing). */
  height: number;
}

export interface LayoutResult {
  lines: LaidOutLine[];
  /** Total height of the block, in points. */
  height: number;
}

/** Measure a string at a given size/weight/slant, in points. */
export type Measure = (text: string, size: number, bold: boolean, italic: boolean) => number;

/** The inner padding a box actually uses. */
export function resolveMargin(margin: number | undefined): number {
  return margin ?? DEFAULT_TEXT_MARGIN;
}

/** Split plain text into paragraphs — the shape used by every markup made
 *  before per-paragraph formatting existed. */
export function paragraphsFromText(text: string): TextParagraph[] {
  return text.split('\n').map((t) => ({ text: t }));
}

/** Plain text of a paragraph list, for `content`, search and the markups list. */
export function textFromParagraphs(paras: TextParagraph[]): string {
  return paras.map((p) => p.text).join('\n');
}

/** The marker for a list item: bullet, ring, 1./2./3. or a./b./c.
 *  `ordinal` is 1-based within the item's own run. */
export function listMarker(style: ListStyle, ordinal: number): string {
  switch (style) {
    case 'bullet':
      return '•';
    case 'circle':
      return '○';
    case 'number':
      return `${ordinal}.`;
    case 'letter':
      return `${letterOrdinal(ordinal)}.`;
    default:
      return '';
  }
}

/** 1 -> a, 26 -> z, 27 -> aa … so long lists keep counting. */
function letterOrdinal(n: number): string {
  let out = '';
  let v = Math.max(1, n);
  while (v > 0) {
    const r = (v - 1) % 26;
    out = String.fromCharCode(97 + r) + out;
    v = Math.floor((v - 1) / 26);
  }
  return out;
}

/** Apply the box fallbacks and number the lists.
 *
 *  Numbering restarts whenever the run breaks — a different list style, a
 *  different indent, or any non-list paragraph between items — so two separate
 *  lists in one box each start at 1 rather than continuing each other. */
export function resolveParagraphs(paras: TextParagraph[], block: BlockStyle): ResolvedParagraph[] {
  const out: ResolvedParagraph[] = [];
  let runStyle: ListStyle = 'none';
  let runIndent = -1;
  let ordinal = 0;
  for (const p of paras) {
    const list = p.list ?? 'none';
    const indent = p.indent ?? block.indent;
    if (list === 'none') {
      runStyle = 'none';
      runIndent = -1;
      ordinal = 0;
    } else if (list === runStyle && indent === runIndent) {
      ordinal += 1;
    } else {
      runStyle = list;
      runIndent = indent;
      ordinal = 1;
    }
    out.push({
      text: p.text,
      size: p.size ?? block.fontSize,
      bold: p.bold ?? block.bold,
      italic: p.italic ?? block.italic,
      underline: p.underline ?? block.underline,
      align: p.align ?? block.align,
      indent,
      list,
      marker: listMarker(list, ordinal),
    });
  }
  return out;
}

/**
 * Lay paragraphs out inside `availWidth` points.
 *
 * A list item hangs: the marker sits at the paragraph indent and every line of
 * that item, the first included, starts after it — so wrapped text lines up
 * under the text rather than under the bullet.
 */
export function layoutParagraphs(
  paras: ResolvedParagraph[],
  availWidth: number,
  lineSpacing: number,
  measure: Measure,
): LayoutResult {
  const lines: LaidOutLine[] = [];
  let y = 0;
  for (const p of paras) {
    const indentPt = p.indent * INDENT_STEP;
    const markerW = p.marker ? measure(p.marker, p.size, p.bold, p.italic) + p.size * MARKER_GAP : 0;
    const textLeft = indentPt + markerW;
    const width = Math.max(1, availWidth - textLeft);
    const height = p.size * lineSpacing;
    // An empty paragraph still occupies a line — that is how blank lines work
    const wrapped = p.text.length
      ? wrap(p.text, width, (t) => measure(t, p.size, p.bold, p.italic))
      : [''];
    wrapped.forEach((text, i) => {
      lines.push({
        text,
        marker: i === 0 ? p.marker : '',
        size: p.size,
        bold: p.bold,
        italic: p.italic,
        underline: p.underline,
        align: p.align,
        x: textLeft,
        y,
        width,
        height,
      });
      y += height;
    });
  }
  return { lines, height: y };
}

/** Word-wrap to `maxWidth`, breaking mid-word only when a single word cannot
 *  fit on a line of its own. */
function wrap(text: string, maxWidth: number, width: (s: string) => number): string[] {
  const lines: string[] = [];
  let line = '';
  for (let word of text.split(' ')) {
    while (width(word) > maxWidth && word.length > 1) {
      if (line && width(`${line} ${word[0]}`) > maxWidth) {
        lines.push(line);
        line = '';
      }
      const base = line ? `${line} ` : '';
      let lo = 1;
      let hi = word.length - 1;
      let fit = 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (width(base + word.slice(0, mid)) <= maxWidth) {
          fit = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      lines.push(base + word.slice(0, fit));
      line = '';
      word = word.slice(fit);
    }
    const candidate = line ? `${line} ${word}` : word;
    if (line && width(candidate) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  lines.push(line);
  return lines;
}

/** Where the block starts vertically inside the box, honouring valign and
 *  never letting the text push past the top margin. */
export function blockTop(
  boxTop: number,
  boxHeight: number,
  blockHeight: number,
  margin: number,
  valign: 'top' | 'middle' | 'bottom',
): number {
  if (valign === 'middle') return boxTop + Math.max(margin, (boxHeight - blockHeight) / 2);
  if (valign === 'bottom') return boxTop + Math.max(margin, boxHeight - margin - blockHeight);
  return boxTop + margin;
}

/** Left offset of a line within its available width, per its alignment. */
export function alignOffset(line: LaidOutLine, textWidth: number): number {
  if (line.align === 'center') return (line.width - textWidth) / 2;
  if (line.align === 'right') return line.width - textWidth;
  return 0;
}
