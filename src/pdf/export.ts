import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { PDFFont } from 'pdf-lib';
import type { PdfDocumentState, Markup, PageDefaults } from '../state/types';
import { META_KEY } from './importMarkups';

/** Map UI font families onto the 14 PDF standard fonts. Arial is the default. */
const FONT_MAP: Record<string, StandardFonts> = {
  Arial: StandardFonts.Helvetica,
  Helvetica: StandardFonts.Helvetica,
  Verdana: StandardFonts.Helvetica,
  'Times New Roman': StandardFonts.TimesRoman,
  Georgia: StandardFonts.TimesRoman,
  'Courier New': StandardFonts.Courier,
};

type FontCache = Map<StandardFonts, PDFFont>;

async function getFont(pdf: PDFDocument, cache: FontCache, family?: string): Promise<PDFFont> {
  const std = FONT_MAP[family ?? 'Arial'] ?? StandardFonts.Helvetica;
  let font = cache.get(std);
  if (!font) {
    font = await pdf.embedFont(std);
    cache.set(std, font);
  }
  return font;
}

export async function exportPdf(doc: PdfDocumentState): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(doc.pdfBytes!);
  pdf.setSubject(`${META_KEY}:${JSON.stringify(doc.markups)}`);
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
      const font = await getFont(pdf, fonts, fontFamily);
      page.drawText(markup.content, {
        x: markup.x,
        y: markup.y,
        size: fontSize,
        lineHeight: fontSize * lineSpacing,
        font,
        color: parseColor(markup.overrides?.textColor ?? defaults.textColor),
      });
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
      const calloutFont = await getFont(pdf, fonts, fontFamily);
      page.drawText(markup.content, {
        x: markup.textX,
        y: markup.textY,
        size: fontSize,
        lineHeight: fontSize * lineSpacing,
        font: calloutFont,
        color: parseColor(markup.overrides?.textColor ?? defaults.textColor),
      });
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
