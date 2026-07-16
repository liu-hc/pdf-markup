import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { PDFFont } from 'pdf-lib';
import type { PdfDocumentState, Markup, PageDefaults } from '../state/types';
import { META_KEY } from './importMarkups';

/** Map UI font families onto the 14 PDF standard fonts. Arial is the default. */
const FONT_MAP: Record<string, { regular: StandardFonts; bold: StandardFonts }> = {
  Arial: { regular: StandardFonts.Helvetica, bold: StandardFonts.HelveticaBold },
  Helvetica: { regular: StandardFonts.Helvetica, bold: StandardFonts.HelveticaBold },
  Verdana: { regular: StandardFonts.Helvetica, bold: StandardFonts.HelveticaBold },
  'Times New Roman': { regular: StandardFonts.TimesRoman, bold: StandardFonts.TimesRomanBold },
  Georgia: { regular: StandardFonts.TimesRoman, bold: StandardFonts.TimesRomanBold },
  'Courier New': { regular: StandardFonts.Courier, bold: StandardFonts.CourierBold },
};

type FontCache = Map<StandardFonts, PDFFont>;

/** Wrap text to `maxWidth` using the embedded font's metrics — same behavior
 *  as the canvas renderer (word wrap, and words wider than a line are broken
 *  mid-word). pdf-lib's drawText only breaks at \n, never wraps on its own. */
function wrapPdfLines(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const width = (s: string): number => font.widthOfTextAtSize(s, size);
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (let word of para.split(' ')) {
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
  }
  return lines;
}

async function getFont(pdf: PDFDocument, cache: FontCache, family?: string, bold = false): Promise<PDFFont> {
  const entry = FONT_MAP[family ?? 'Arial'] ?? FONT_MAP.Arial!;
  const std = bold ? entry.bold : entry.regular;
  let font = cache.get(std);
  if (!font) {
    font = await pdf.embedFont(std);
    cache.set(std, font);
  }
  return font;
}

/** One indent step in page points — keep in sync with INDENT_STEP in draw.ts. */
const PDF_INDENT_STEP = 12;

interface TextFormatting {
  underline: boolean;
  indent: number;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
}

/** Wrapped, aligned text inside a box (PDF coords, y-up; box.y = bottom edge).
 *  Drawn line by line so horizontal/vertical alignment and underline match
 *  the on-screen rendering. */
function drawFormattedText(
  page: ReturnType<PDFDocument['getPage']>,
  font: PDFFont,
  content: string,
  box: { x: number; y: number; w: number; h: number },
  pad: number,
  fontSize: number,
  lineSpacing: number,
  color: ReturnType<typeof rgb>,
  fmt: TextFormatting,
): void {
  const indent = fmt.indent * PDF_INDENT_STEP;
  const availW = Math.max(20, box.w - pad * 2 - indent);
  const lines = wrapPdfLines(font, content, fontSize, availW);
  const lineH = fontSize * lineSpacing;
  const blockH = lines.length * lineH;
  const boxTop = box.y + box.h;
  // Top edge of the text block per vertical alignment (never above the pad)
  const blockTop =
    fmt.valign === 'middle'
      ? Math.min(boxTop - pad, box.y + (box.h + blockH) / 2)
      : fmt.valign === 'bottom'
        ? Math.min(boxTop - pad, box.y + pad + blockH)
        : boxTop - pad;
  const left = box.x + pad + indent;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lw = font.widthOfTextAtSize(line, fontSize);
    const lx =
      fmt.align === 'center' ? left + (availW - lw) / 2 : fmt.align === 'right' ? left + availW - lw : left;
    const baseline = blockTop - fontSize * 0.85 - i * lineH;
    page.drawText(line, { x: lx, y: baseline, size: fontSize, font, color });
    if (fmt.underline && line.trim()) {
      page.drawLine({
        start: { x: lx, y: baseline - fontSize * 0.12 },
        end: { x: lx + lw, y: baseline - fontSize * 0.12 },
        thickness: Math.max(0.5, fontSize * 0.06),
        color,
      });
    }
  }
}

export async function exportPdf(doc: PdfDocumentState): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(doc.pdfBytes!);
  pdf.setSubject(`${META_KEY}:${JSON.stringify({ markups: doc.markups, bookmarks: doc.bookmarks })}`);
  const fonts: FontCache = new Map();

  for (const markup of doc.markups) {
    const page = pdf.getPage(markup.pageIndex);
    const defaults = doc.pageDefaults[markup.pageIndex] ?? doc.pageDefaults[0]!;
    await embedMarkup(pdf, page, markup, defaults, fonts);
  }

  return new Uint8Array(await pdf.save());
}

export async function flattenPdf(doc: PdfDocumentState): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(doc.pdfBytes!);
  const fonts: FontCache = new Map();

  for (let i = 0; i < pdf.getPageCount(); i++) {
    const page = pdf.getPage(i);
    const pageMarkups = doc.markups.filter((m) => m.pageIndex === i);
    const defaults = doc.pageDefaults[i] ?? doc.pageDefaults[0]!;

    for (const m of pageMarkups) {
      await embedMarkup(pdf, page, m, defaults, fonts);
    }
  }

  pdf.setSubject('');
  return new Uint8Array(await pdf.save());
}

async function embedMarkup(
  pdf: PDFDocument,
  page: ReturnType<PDFDocument['getPage']>,
  markup: Markup,
  defaults: PageDefaults,
  fonts: FontCache,
): Promise<void> {
  const stroke = parseColor(markup.overrides?.strokeColor ?? defaults.strokeColor);
  const fill = markup.overrides?.fillColor ?? defaults.fillColor;
  const lineWeight = markup.overrides?.lineWeight ?? defaults.lineWeight;
  const fontSize = markup.overrides?.fontSize ?? defaults.fontSize ?? 12;
  const fontFamily = markup.overrides?.fontFamily ?? defaults.fontFamily ?? 'Arial';
  const lineSpacing = markup.overrides?.lineSpacing ?? 1.35;

  switch (markup.type) {
    case 'rectangle':
    case 'highlighter': {
      const isHl = markup.type === 'highlighter';
      page.drawRectangle({
        x: markup.x,
        y: markup.y,
        width: markup.width,
        height: markup.height,
        // Highlighter is a borderless translucent yellow fill
        borderColor: isHl ? undefined : stroke,
        borderWidth: isHl ? 0 : lineWeight,
        color: isHl
          ? parseColor(markup.overrides?.fillColor ?? '#f5c542')
          : fill
            ? parseColor(fill)
            : undefined,
        opacity: isHl ? 0.35 : 1,
      });
      break;
    }
    case 'ellipse': {
      page.drawEllipse({
        x: markup.cx - markup.rx,
        y: markup.cy - markup.ry,
        xScale: markup.rx,
        yScale: markup.ry,
        borderColor: stroke,
        borderWidth: lineWeight,
        color: fill ? parseColor(fill) : undefined,
      });
      break;
    }
    case 'line':
    case 'dimension': {
      page.drawLine({
        start: { x: markup.x1, y: markup.y1 },
        end: { x: markup.x2, y: markup.y2 },
        thickness: lineWeight,
        color: stroke,
      });
      break;
    }
    case 'inkHighlight': {
      // Fat translucent yellow pen — one round-capped segment per step
      if (!markup.points.length) break;
      const inkColor = parseColor(markup.overrides?.strokeColor ?? '#f5c542');
      const { LineCapStyle } = await import('pdf-lib');
      for (let i = 1; i < markup.points.length; i++) {
        page.drawLine({
          start: markup.points[i - 1]!,
          end: markup.points[i]!,
          thickness: markup.penWidth,
          color: inkColor,
          opacity: 0.35,
          lineCap: LineCapStyle.Round,
        });
      }
      break;
    }
    case 'text': {
      // Box (fill + border) matching the on-screen rendering
      page.drawRectangle({
        x: markup.x,
        y: markup.y,
        width: markup.width,
        height: markup.height,
        borderColor: stroke,
        borderWidth: lineWeight,
        color: fill ? parseColor(fill) : undefined,
      });
      const font = await getFont(pdf, fonts, fontFamily, markup.overrides?.bold ?? false);
      drawFormattedText(
        page,
        font,
        markup.content,
        { x: markup.x, y: markup.y, w: markup.width, h: markup.height },
        3,
        fontSize,
        lineSpacing,
        parseColor(markup.overrides?.textColor ?? defaults.textColor),
        {
          underline: markup.overrides?.underline ?? false,
          indent: markup.overrides?.indent ?? 0,
          align: markup.overrides?.align ?? 'left',
          valign: markup.overrides?.valign ?? 'top',
        },
      );
      break;
    }
    case 'sticky': {
      const font = await getFont(pdf, fonts, fontFamily);
      page.drawText('*', { x: markup.x, y: markup.y, size: 14, font, color: rgb(0.96, 0.77, 0.26) });
      break;
    }
    case 'polyline':
    case 'polygon':
    case 'cloud': {
      if (markup.points.length < 2) break;
      for (let i = 1; i < markup.points.length; i++) {
        page.drawLine({
          start: markup.points[i - 1]!,
          end: markup.points[i]!,
          thickness: lineWeight,
          color: stroke,
        });
      }
      // Close polygon and cloud paths
      if (markup.type === 'polygon' || markup.type === 'cloud') {
        page.drawLine({
          start: markup.points[markup.points.length - 1]!,
          end: markup.points[0]!,
          thickness: lineWeight,
          color: stroke,
        });
      }
      break;
    }
    case 'callout': {
      page.drawLine({
        start: { x: markup.textX, y: markup.textY },
        end: { x: markup.anchorX, y: markup.anchorY },
        thickness: lineWeight,
        color: stroke,
      });
      // Text box (cream default fill, like the canvas) + wrapped text
      page.drawRectangle({
        x: markup.textX,
        y: markup.textY,
        width: markup.textWidth,
        height: markup.textHeight,
        borderColor: stroke,
        borderWidth: lineWeight,
        color: fill ? parseColor(fill) : rgb(1, 0.996, 0.96),
      });
      const calloutFont = await getFont(pdf, fonts, fontFamily, markup.overrides?.bold ?? false);
      drawFormattedText(
        page,
        calloutFont,
        markup.content,
        { x: markup.textX, y: markup.textY, w: markup.textWidth, h: markup.textHeight },
        4,
        fontSize,
        lineSpacing,
        parseColor(markup.overrides?.textColor ?? defaults.textColor),
        {
          underline: markup.overrides?.underline ?? false,
          indent: markup.overrides?.indent ?? 0,
          align: markup.overrides?.align ?? 'left',
          valign: markup.overrides?.valign ?? 'top',
        },
      );
      break;
    }
    case 'measureAngle': {
      page.drawLine({
        start: { x: markup.vertex.x, y: markup.vertex.y },
        end: { x: markup.p1.x, y: markup.p1.y },
        thickness: lineWeight,
        color: stroke,
      });
      page.drawLine({
        start: { x: markup.vertex.x, y: markup.vertex.y },
        end: { x: markup.p2.x, y: markup.p2.y },
        thickness: lineWeight,
        color: stroke,
      });
      break;
    }
    case 'snipImage': {
      try {
        const b64 = markup.imageData.replace(/^data:image\/\w+;base64,/, '');
        const imgBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const embeddedImg = await pdf.embedPng(imgBytes);
        page.drawImage(embeddedImg, {
          x: markup.x,
          y: markup.y,
          width: markup.width,
          height: markup.height,
        });
      } catch {
        // skip if PNG embedding fails
      }
      break;
    }
  }
}

function parseColor(hex: string) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return rgb(r, g, b);
}
