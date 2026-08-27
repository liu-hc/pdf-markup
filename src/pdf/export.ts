import { PDFDocument, rgb, StandardFonts, BlendMode, LineCapStyle, degrees } from 'pdf-lib';
import type { PDFFont, Color } from 'pdf-lib';
import type { ArrowHead, PdfDocumentState, Markup, PageDefaults, Point } from '../state/types';
import { META_KEY } from './importMarkups';
import { resolveStyle } from '../markups/draw';
import {
  angleDegrees,
  arrowBarbs,
  arrowBodyInset,
  calloutLeader,
  cloudOutline,
  dashPattern,
  dimensionGeometry,
  dist,
  ellipseBezier,
  polygonArea,
  polygonCentroid,
  polylineLength,
  polylineMidpoint,
  rotatedRectCorners,
  shortenToward,
} from '../util/geometry';
import { formatAngle, formatArea, formatLength } from '../util/units';

/* ── Vector plumbing ──────────────────────────────────────────────────────
   pdf-lib's drawSvgPath translates to (x, y) and then flips the Y axis
   (scale(1, -1)), because SVG counts Y downward. Passing the origin and
   negating every Y in the path therefore puts a page-coordinate point
   exactly where it belongs — which lets one path builder serve every shape
   below, arrowheads and cloud scallops included. */

const ORIGIN = { x: 0, y: 0 };

/** SVG path data for a run of page-coordinate points. */
function pathOf(points: Point[], close = false): string {
  if (!points.length) return '';
  const d = points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${-p.y}`).join(' ');
  return close ? `${d} Z` : d;
}

interface StrokeOpts {
  color: Color;
  width: number;
  opacity: number;
  dash?: number[];
  cap?: LineCapStyle;
}

function strokePath(page: PdfPage, d: string, o: StrokeOpts): void {
  if (!d) return;
  page.drawSvgPath(d, {
    ...ORIGIN,
    borderColor: o.color,
    borderWidth: o.width,
    borderOpacity: o.opacity,
    ...(o.dash && o.dash.length ? { borderDashArray: o.dash } : {}),
    ...(o.cap !== undefined ? { borderLineCap: o.cap } : {}),
  });
}

function fillPath(
  page: PdfPage,
  d: string,
  o: { color: Color; opacity: number; multiply?: boolean },
): void {
  if (!d) return;
  page.drawSvgPath(d, {
    ...ORIGIN,
    color: o.color,
    opacity: o.opacity,
    ...(o.multiply ? { blendMode: BlendMode.Multiply } : {}),
  });
}

type PdfPage = ReturnType<PDFDocument['getPage']>;

/** Arrowhead at `tip`, pointing away from `awayFrom`. Filled heads are a solid
 *  triangle; open heads are two stroked barbs — matching the canvas. */
function drawArrowHead(
  page: PdfPage,
  tip: Point,
  awayFrom: Point,
  head: ArrowHead,
  size: number,
  color: Color,
  opacity: number,
  strokeWidth: number,
): void {
  if (head === 'none') return;
  const [b1, b2] = arrowBarbs(tip, awayFrom, size);
  if (head === 'open') {
    strokePath(page, pathOf([b1, tip, b2]), { color, width: strokeWidth, opacity });
  } else {
    fillPath(page, pathOf([tip, b1, b2], true), { color, opacity });
  }
}

/** A measurement label centred on (cx, cy) and rotated by `angle` radians,
 *  with the same white backing the canvas paints so it stays readable over
 *  linework. */
function drawCenteredLabel(
  page: PdfPage,
  font: PDFFont,
  text: string,
  cx: number,
  cy: number,
  size: number,
  color: Color,
  opacity: number,
  angle = 0,
): void {
  if (!text) return;
  const w = font.widthOfTextAtSize(text, size);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Text runs along u and stands up along n; drop the baseline so the glyph
  // body straddles the centre point rather than sitting on it.
  const u = { x: cos, y: sin };
  const n = { x: -sin, y: cos };
  const pad = size * 0.18;
  const halfW = w / 2 + pad;
  const halfH = size * 0.62;
  const corner = (su: number, sn: number): Point => ({
    x: cx + u.x * su * halfW + n.x * sn * halfH,
    y: cy + u.y * su * halfW + n.y * sn * halfH,
  });
  fillPath(page, pathOf([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], true), {
    color: rgb(1, 1, 1),
    opacity: opacity * 0.85,
  });
  const originX = cx - u.x * (w / 2) - n.x * size * 0.35;
  const originY = cy - u.y * (w / 2) - n.y * size * 0.35;
  page.drawText(text, {
    x: originX,
    y: originY,
    size,
    font,
    color,
    opacity,
    rotate: degrees((angle * 180) / Math.PI),
  });
}

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

/** Render one markup into the page, matching markups/draw.ts.
 *
 *  Everything the canvas draws is drawn here: dimension extension lines,
 *  ticks and labels; callout elbow leaders; arrowheads; cloud scallops;
 *  dashed styles; polyline length and polygon area labels; angle arcs;
 *  rotation; and separate line/fill opacity with the Multiply blend. If the
 *  two ever disagree, the shared geometry in util/geometry.ts is the thing to
 *  fix — both sides read their shapes from there. */
async function embedMarkup(
  pdf: PDFDocument,
  page: PdfPage,
  markup: Markup,
  defaults: PageDefaults,
  fonts: FontCache,
): Promise<void> {
  const style = resolveStyle(markup, defaults);
  const stroke = parseColor(style.stroke);
  const textColor = parseColor(style.textColor);
  const lineWeight = style.lineWeight;
  const lineOpacity = style.opacity;
  const fillOpacity = style.fillOpacity;
  const multiply = style.fillMultiply;
  const dash = dashPattern(style.lineStyle, lineWeight);
  const fontSize = style.fontSize;
  const labelFont = await getFont(pdf, fonts, style.fontFamily);

  /** Stroke in the markup's own colour, weight and line style. */
  const line = (pts: Point[], close = false): void =>
    strokePath(page, pathOf(pts, close), {
      color: stroke,
      width: lineWeight,
      opacity: lineOpacity,
      ...(dash.length ? { dash } : {}),
    });
  /** Fill in the markup's own infill colour/alpha, honouring Multiply. */
  const fill = (d: string): void => {
    if (!style.fill) return;
    fillPath(page, d, { color: parseColor(style.fill), opacity: fillOpacity, multiply });
  };
  const label = (text: string, x: number, y: number, angle = 0): void =>
    drawCenteredLabel(page, labelFont, text, x, y, fontSize, textColor, lineOpacity, angle);

  switch (markup.type) {
    case 'rectangle':
    case 'highlighter': {
      const corners = rotatedRectCorners(
        markup.x,
        markup.y,
        markup.width,
        markup.height,
        markup.type === 'rectangle' ? markup.rotation ?? 0 : 0,
      );
      const d = pathOf(corners, true);
      if (markup.type === 'highlighter') {
        // Borderless translucent swipe — its own fixed alpha, like on screen
        fillPath(page, d, {
          color: parseColor(style.fill ?? '#f5c542'),
          opacity: 0.35,
          multiply,
        });
        break;
      }
      fill(d);
      line(corners, true);
      break;
    }

    case 'ellipse': {
      const { start, curves } = ellipseBezier(
        markup.cx,
        markup.cy,
        markup.rx,
        markup.ry,
        markup.rotation ?? 0,
      );
      const d =
        `M ${start.x} ${-start.y} ` +
        curves
          .map(([c1, c2, e]) => `C ${c1.x} ${-c1.y} ${c2.x} ${-c2.y} ${e.x} ${-e.y}`)
          .join(' ') +
        ' Z';
      fill(d);
      strokePath(page, d, {
        color: stroke,
        width: lineWeight,
        opacity: lineOpacity,
        ...(dash.length ? { dash } : {}),
      });
      break;
    }

    case 'line': {
      const s = { x: markup.x1, y: markup.y1 };
      const e = { x: markup.x2, y: markup.y2 };
      const size = lineWeight * (markup.arrowSize ?? 1);
      const head1 = markup.arrowStart ?? 'none';
      const head2 = markup.arrowEnd ?? 'none';
      // Pull the body back so a thick stroke can't blunt the arrow tip
      line([
        shortenToward(s, e, arrowBodyInset(head1, size, lineWeight)),
        shortenToward(e, s, arrowBodyInset(head2, size, lineWeight)),
      ]);
      drawArrowHead(page, s, e, head1, size, stroke, lineOpacity, lineWeight);
      drawArrowHead(page, e, s, head2, size, stroke, lineOpacity, lineWeight);
      break;
    }

    case 'dimension': {
      // Offset dimension line + extension lines + end ticks + the value,
      // mirroring the canvas exactly (see the 'dimension' case in draw.ts).
      const offset = markup.offset ?? 0;
      const p1 = { x: markup.x1, y: markup.y1 };
      const p2 = { x: markup.x2, y: markup.y2 };
      const g = dimensionGeometry(p1.x, p1.y, p2.x, p2.y, offset);
      const ux = g.ux;
      const uy = g.uy;
      const px = g.nx;
      const py = g.ny;
      const gap = 3;
      const over = 5;
      const tick = 5;

      line([g.d1, g.d2]);
      for (const [ps, ds] of [
        [p1, g.d1],
        [p2, g.d2],
      ] as [Point, Point][]) {
        const ex = ds.x - ps.x;
        const ey = ds.y - ps.y;
        const el = Math.hypot(ex, ey);
        if (el > 0.5) {
          const evx = ex / el;
          const evy = ey / el;
          line([
            { x: ps.x + evx * gap, y: ps.y + evy * gap },
            { x: ds.x + evx * over, y: ds.y + evy * over },
          ]);
        } else {
          // offset 0: a short perpendicular stick through the measured point
          line([
            { x: ds.x + px * (tick + 2), y: ds.y + py * (tick + 2) },
            { x: ds.x - px * (tick + 2), y: ds.y - py * (tick + 2) },
          ]);
        }
      }

      if ((markup.tickStyle ?? 'slash') === 'slash') {
        // Architectural slash on the opposite 45 degree diagonal
        const tx = (ux - px) / Math.SQRT2;
        const ty = (uy - py) / Math.SQRT2;
        for (const q of [g.d1, g.d2]) {
          line([
            { x: q.x - tx * tick, y: q.y - ty * tick },
            { x: q.x + tx * tick, y: q.y + ty * tick },
          ]);
        }
      } else {
        drawArrowHead(page, g.d1, g.d2, 'filled', lineWeight, stroke, lineOpacity, lineWeight);
        drawArrowHead(page, g.d2, g.d1, 'filled', lineWeight, stroke, lineOpacity, lineWeight);
      }

      const text =
        markup.customLabel !== undefined
          ? markup.customLabel
          : formatLength(dist(p1, p2), defaults.scaleFactor, markup.roundTo);
      // Label sits clear of the measured points, reading along the dim line
      const loff = 11;
      let k: number;
      if (Math.abs(offset) > 0.5) {
        k = (g.d1.x - p1.x) * px + (g.d1.y - p1.y) * py >= 0 ? loff : -loff;
      } else {
        k = py < 0 || (py === 0 && px > 0) ? -loff : loff;
      }
      let a = Math.atan2(uy, ux);
      if (a > Math.PI / 2) a -= Math.PI;
      else if (a < -Math.PI / 2) a += Math.PI;
      label(text, g.mid.x + px * k, g.mid.y + py * k, a);
      break;
    }

    case 'cloud': {
      if (markup.points.length < 3) break;
      fill(pathOf(markup.points, true));
      strokePath(page, pathOf(cloudOutline(markup.points), false), {
        color: stroke,
        width: lineWeight,
        opacity: lineOpacity,
      });
      break;
    }

    case 'polygon': {
      if (markup.points.length < 2) break;
      fill(pathOf(markup.points, true));
      line(markup.points, true);
      if (markup.showArea) {
        const c = polygonCentroid(markup.points);
        label(formatArea(polygonArea(markup.points), defaults.scaleFactor, markup.decimals), c.x, c.y);
      }
      break;
    }

    case 'polyline': {
      if (markup.points.length < 2) break;
      const pts = markup.points;
      const size = lineWeight * (markup.arrowSize ?? 1);
      const head1 = markup.arrowStart ?? 'none';
      const head2 = markup.arrowEnd ?? 'none';
      const body = pts.map((p) => ({ ...p }));
      const last = body.length - 1;
      const insS = arrowBodyInset(head1, size, lineWeight);
      const insE = arrowBodyInset(head2, size, lineWeight);
      if (insS) body[0] = shortenToward(body[0]!, body[1]!, insS);
      if (insE) body[last] = shortenToward(body[last]!, body[last - 1]!, insE);
      line(body);
      drawArrowHead(page, pts[0]!, pts[1]!, head1, size, stroke, lineOpacity, lineWeight);
      drawArrowHead(page, pts[last]!, pts[last - 1]!, head2, size, stroke, lineOpacity, lineWeight);
      if (markup.showLength) {
        const mid = polylineMidpoint(pts);
        label(formatLength(polylineLength(pts), defaults.scaleFactor), mid.x, mid.y + 9);
      }
      break;
    }

    case 'inkHighlight': {
      if (markup.points.length < 2) break;
      strokePath(page, pathOf(markup.points), {
        color: stroke,
        width: markup.penWidth,
        opacity: lineOpacity,
        cap: LineCapStyle.Round,
      });
      break;
    }

    case 'text': {
      const box = { x: markup.x, y: markup.y, w: markup.width, h: markup.height };
      const d = pathOf(
        [
          { x: box.x, y: box.y },
          { x: box.x + box.w, y: box.y },
          { x: box.x + box.w, y: box.y + box.h },
          { x: box.x, y: box.y + box.h },
        ],
        true,
      );
      fill(d);
      if (style.border) line([
        { x: box.x, y: box.y },
        { x: box.x + box.w, y: box.y },
        { x: box.x + box.w, y: box.y + box.h },
        { x: box.x, y: box.y + box.h },
      ], true);
      const font = await getFont(pdf, fonts, style.fontFamily, style.bold);
      drawFormattedText(page, font, markup.content, box, 3, fontSize, style.lineSpacing, textColor, {
        underline: style.underline,
        indent: style.indent,
        align: style.align,
        valign: style.valign,
      });
      break;
    }

    case 'callout': {
      const box = { x: markup.textX, y: markup.textY, w: markup.textWidth, h: markup.textHeight };
      const leader = calloutLeader(
        box.x,
        box.y,
        box.w,
        box.h,
        markup.anchorX,
        markup.anchorY,
        markup.kinkX,
        markup.kinkY,
      );
      const anchor = { x: markup.anchorX, y: markup.anchorY };
      const head = markup.arrowEnd ?? 'filled';
      // Callout heads use a 2.5x larger base than plain lines
      const size = lineWeight * 2.5 * (markup.arrowSize ?? 1);
      // Elbow leader: out of the box edge, to the kink, then on to the anchor
      line([
        leader.exit,
        leader.kink,
        shortenToward(anchor, leader.kink, arrowBodyInset(head, size, lineWeight)),
      ]);
      drawArrowHead(page, anchor, leader.kink, head, size, stroke, lineOpacity, lineWeight);

      const corners = [
        { x: box.x, y: box.y },
        { x: box.x + box.w, y: box.y },
        { x: box.x + box.w, y: box.y + box.h },
        { x: box.x, y: box.y + box.h },
      ];
      // Box infill: the user's colour, else the cream default the canvas uses
      fillPath(page, pathOf(corners, true), {
        color: style.fill ? parseColor(style.fill) : rgb(1, 0.996, 0.96),
        opacity: fillOpacity,
        multiply,
      });
      if (style.border) line(corners, true);
      const font = await getFont(pdf, fonts, style.fontFamily, style.bold);
      drawFormattedText(page, font, markup.content, box, 4, fontSize, style.lineSpacing, textColor, {
        underline: style.underline,
        indent: style.indent,
        align: style.align,
        valign: style.valign,
      });
      break;
    }

    case 'sticky': {
      // Folded-corner note icon, matching the canvas glyph
      const s = 18;
      const fold = s * 0.35;
      const x = markup.x;
      const y = markup.y;
      const body = [
        { x, y },
        { x: x + s, y },
        { x: x + s, y: y + s - fold },
        { x: x + s - fold, y: y + s },
        { x, y: y + s },
      ];
      fillPath(page, pathOf(body, true), { color: rgb(0.96, 0.77, 0.26), opacity: lineOpacity });
      strokePath(page, pathOf(body, true), {
        color: rgb(0.66, 0.48, 0.08),
        width: 1,
        opacity: lineOpacity,
      });
      strokePath(
        page,
        pathOf([
          { x: x + s - fold, y: y + s },
          { x: x + s - fold, y: y + s - fold },
          { x: x + s, y: y + s - fold },
        ]),
        { color: rgb(0.66, 0.48, 0.08), width: 1, opacity: lineOpacity },
      );
      break;
    }

    case 'measureAngle': {
      line([markup.p1, markup.vertex, markup.p2]);
      const deg = angleDegrees(markup.p1, markup.vertex, markup.p2);
      label(formatAngle(deg), markup.vertex.x, markup.vertex.y + 8);
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
          opacity: lineOpacity,
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
