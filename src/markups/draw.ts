import type {
  Markup,
  PageDefaults,
  Point,
  ArrowHead,
  LineStyle,
  TextParagraph,
} from '../state/types';
import {
  polygonArea,
  polylineLength,
  polygonCentroid,
  polylineMidpoint,
  angleDegrees,
  dist,
  dimensionGeometry,
  leaderPath,
  leadersOf,
  arrowBarbs,
  arrowBodyInset,
  dashPattern,
  shortenToward,
  CLOUD_ARC_R,
} from '../util/geometry';
import { formatLength, formatArea, formatAngle } from '../util/units';
import {
  alignOffset,
  blockTop,
  layoutParagraphs,
  paragraphsFromText,
  resolveMargin,
  resolveParagraphs,
  type BlockStyle,
} from './textLayout';

export interface DrawStyle {
  stroke: string;
  fill: string | null;
  textColor: string;
  lineWeight: number;
  lineStyle: LineStyle;
  /** Linework + text alpha. */
  opacity: number;
  /** Infill alpha — independent of the linework alpha. */
  fillOpacity: number;
  /** Composite the infill with Multiply instead of painting over. */
  fillMultiply: boolean;
  /** Text / callout: paint the box border. */
  border: boolean;
  fontSize: number;
  fontFamily: string;
  lineSpacing: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** Block left indent, in steps of INDENT_STEP pt. */
  indent: number;
  /** Inner padding of a text/callout box, in points. */
  margin: number;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
}

export { INDENT_STEP } from './textLayout';

/** Fallback highlighter colour, shared with the tool that creates them. */
export const HIGHLIGHT_COLOR = '#f5c542';

export function resolveStyle(markup: Markup, defaults: PageDefaults): DrawStyle {
  return {
    stroke: markup.overrides?.strokeColor ?? defaults.strokeColor,
    fill: markup.overrides?.fillColor !== undefined ? markup.overrides.fillColor : defaults.fillColor,
    textColor: markup.overrides?.textColor ?? defaults.textColor,
    lineWeight: markup.overrides?.lineWeight ?? defaults.lineWeight,
    lineStyle: markup.overrides?.lineStyle ?? defaults.lineStyle,
    opacity: markup.overrides?.opacity ?? 1,
    // Falls back to the line opacity so markups made before the two were
    // split keep the single-alpha look they were drawn with.
    fillOpacity: markup.overrides?.fillOpacity ?? markup.overrides?.opacity ?? 1,
    fillMultiply: markup.overrides?.fillMultiply ?? false,
    border: markup.overrides?.border ?? true,
    fontSize: markup.overrides?.fontSize ?? defaults.fontSize ?? 12,
    fontFamily: markup.overrides?.fontFamily ?? defaults.fontFamily ?? 'Arial',
    lineSpacing: markup.overrides?.lineSpacing ?? 1.35,
    bold: markup.overrides?.bold ?? false,
    italic: markup.overrides?.italic ?? false,
    underline: markup.overrides?.underline ?? false,
    margin: resolveMargin(markup.overrides?.margin),
    indent: markup.overrides?.indent ?? 0,
    align: markup.overrides?.align ?? 'left',
    valign: markup.overrides?.valign ?? 'top',
  };
}

/** Canvas font shorthand — quoted family with a sans-serif fallback. */
function canvasFont(sizePx: number, family: string, bold = false, italic = false): string {
  return `${italic ? 'italic ' : ''}${bold ? '700 ' : ''}${sizePx}px "${family}", sans-serif`;
}

/** Markup types that paint an enclosed infill (the only ones the multiply
 *  pass has anything to draw for). */
const FILL_SHAPES = new Set([
  'rectangle',
  'ellipse',
  'polygon',
  'cloud',
  'text',
  'callout',
  // Both highlight kinds are a colour wash: the rect's is an infill, the
  // free-hand swipe's is its stroke. Either way it's what Multiply blends.
  'highlighter',
  'inkHighlight',
]);

/** Which pass of the two-canvas markup render this call is painting.
 *  `multiply` fills go on a separate `mix-blend-mode: multiply` canvas so they
 *  darken the PDF beneath them; that pass draws NOTHING else. */
export type DrawPhase = 'normal' | 'multiply';

/** True when this markup contributes anything to the multiply pass. */
export function hasMultiplyFill(markup: Markup, defaults: PageDefaults): boolean {
  if (!(markup.overrides?.fillMultiply ?? false)) return false;
  if (!FILL_SHAPES.has(markup.type)) return false;
  // A highlight's stroke IS its wash, so there is always something to blend
  if (markup.type === 'highlighter' || markup.type === 'inkHighlight') return true;
  const style = resolveStyle(markup, defaults);
  return !!style.fill || markup.type === 'callout';
}

export function drawMarkupOnCanvas(
  ctx: CanvasRenderingContext2D,
  markup: Markup,
  defaults: PageDefaults,
  scale: number,
  pageHeight: number,
  phase: DrawPhase = 'normal',
): void {
  const style = resolveStyle(markup, defaults);
  // The multiply pass paints only infills; the normal pass paints everything
  // except an infill that has been handed to the multiply pass.
  const multiplyPass = phase === 'multiply';
  if (multiplyPass && (!style.fillMultiply || !FILL_SHAPES.has(markup.type))) return;
  /** Should THIS pass paint the shape's infill? */
  const fillPass = style.fillMultiply === multiplyPass;
  ctx.save();
  ctx.globalAlpha = style.opacity;
  // Box (rectangular) line finish — never rounded caps/joins
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  applyLineStyle(ctx, style.lineStyle, style.lineWeight * scale);
  ctx.strokeStyle = style.stroke;
  ctx.fillStyle = style.fill ?? 'transparent';
  ctx.lineWidth = style.lineWeight * scale;

  /** Paint an infill at the fill alpha, then restore the linework alpha.
   *  A no-op when the infill belongs to the other pass. */
  const paintFill = (fn: () => void): void => {
    if (!fillPass) return;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = style.fillOpacity;
    fn();
    ctx.globalAlpha = prev;
  };

  const toScreen = (p: Point) => ({
    x: p.x * scale,
    y: (pageHeight - p.y) * scale,
  });

  switch (markup.type) {
    case 'rectangle': {
      const w = markup.width * scale;
      const h = markup.height * scale;
      const rot = (markup.rotation ?? 0) * (Math.PI / 180);
      ctx.save();
      // Rotate about the rectangle's center
      ctx.translate((markup.x + markup.width / 2) * scale, (pageHeight - markup.y - markup.height / 2) * scale);
      if (rot) ctx.rotate(rot);
      if (style.fill) paintFill(() => ctx.fillRect(-w / 2, -h / 2, w, h));
      if (!multiplyPass) ctx.strokeRect(-w / 2, -h / 2, w, h);
      ctx.restore();
      // Optional enclosed area, centred like the polygon's
      if (!multiplyPass && markup.showArea) {
        const c = toScreen({ x: markup.x + markup.width / 2, y: markup.y + markup.height / 2 });
        drawCenteredLabel(
          ctx,
          c.x,
          c.y,
          formatArea(markup.width * markup.height, defaults.scaleFactor, markup.decimals),
          style.textColor,
          scale,
          style.fontSize,
          style.fontFamily,
        );
      }
      break;
    }
    case 'highlighter': {
      // A highlight is a pen, not a filled shape: ONE colour (the Line well),
      // its own opacity and a Multiply toggle. Multiply is what makes it read
      // as a real highlighter — the drawing underneath stays legible at full
      // strength instead of being veiled by transparency.
      if (!fillPass) break;
      const x = markup.x * scale;
      const y = (pageHeight - markup.y - markup.height) * scale;
      ctx.globalAlpha = style.opacity;
      ctx.fillStyle = style.stroke || HIGHLIGHT_COLOR;
      ctx.fillRect(x, y, markup.width * scale, markup.height * scale);
      break;
    }
    case 'inkHighlight': {
      // Fat translucent marker swipe with a round pen — opacity + colour come
      // from the markup's overrides (yellow @ 0.35) set on the global above.
      if (!markup.points.length) break;
      // The swipe IS the wash, so it follows the fill pass rather than the
      // linework pass — that's what lets Multiply darken the PDF beneath it.
      if (!fillPass) break;
      ctx.globalAlpha = style.opacity;
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = markup.penWidth * scale;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([]);
      const p0 = toScreen(markup.points[0]!);
      if (markup.points.length === 1) {
        ctx.beginPath();
        ctx.fillStyle = style.stroke;
        ctx.arc(p0.x, p0.y, (markup.penWidth * scale) / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < markup.points.length; i++) {
          const pp = toScreen(markup.points[i]!);
          ctx.lineTo(pp.x, pp.y);
        }
        ctx.stroke();
      }
      break;
    }
    case 'ellipse': {
      ctx.beginPath();
      ctx.ellipse(
        markup.cx * scale,
        (pageHeight - markup.cy) * scale,
        markup.rx * scale,
        markup.ry * scale,
        (markup.rotation ?? 0) * (Math.PI / 180),
        0,
        Math.PI * 2,
      );
      if (!multiplyPass) ctx.stroke();
      if (style.fill) paintFill(() => ctx.fill());
      break;
    }
    case 'line': {
      const sFull = toScreen({ x: markup.x1, y: markup.y1 });
      const eFull = toScreen({ x: markup.x2, y: markup.y2 });
      const lineArrow = style.lineWeight * scale * (markup.arrowSize ?? 1);
      const strokeW = style.lineWeight * scale;
      // Pull the body back just enough to meet the arrowhead cleanly (filled →
      // base, open → tuck the butt behind the tip)
      const s = shortenToward(sFull, eFull, arrowBodyInset(markup.arrowStart ?? 'none', lineArrow, strokeW));
      const e = shortenToward(eFull, sFull, arrowBodyInset(markup.arrowEnd ?? 'none', lineArrow, strokeW));
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(e.x, e.y);
      ctx.stroke();
      // Arrowheads fill with the stroke color (not the shape fill); the tip
      // sits at the true endpoint
      ctx.fillStyle = style.stroke;
      drawArrow(ctx, sFull, eFull, markup.arrowStart ?? 'none', lineArrow);
      drawArrow(ctx, eFull, sFull, markup.arrowEnd ?? 'none', lineArrow);
      break;
    }
    case 'dimension': {
      // Architectural dimension. The measured points (x1,y1)/(x2,y2) stay on
      // the object; the dimension line is pulled away by `offset` along the
      // perpendicular, and the extension lines stretch to bridge the gap.
      const offset = markup.offset ?? 0;
      const g = dimensionGeometry(markup.x1, markup.y1, markup.x2, markup.y2, offset);
      const p1s = toScreen({ x: markup.x1, y: markup.y1 });
      const p2s = toScreen({ x: markup.x2, y: markup.y2 });
      const d1s = toScreen(g.d1);
      const d2s = toScreen(g.d2);
      const ddx = d2s.x - d1s.x;
      const ddy = d2s.y - d1s.y;
      const L = Math.hypot(ddx, ddy) || 1;
      const ux = ddx / L;
      const uy = ddy / L;
      const px = -uy; // unit perpendicular (screen)
      const py = ux;
      // Extension lines run from near the measured point past the dim line
      const gap = 3 * scale; // gap at the object end
      const over = 5 * scale; // overshoot past the dimension line
      const tick = 5 * scale;
      // Screen-space direction from measured point to its dim-line end
      const exts: [typeof p1s, typeof d1s][] = [
        [p1s, d1s],
        [p2s, d2s],
      ];
      ctx.beginPath();
      ctx.moveTo(d1s.x, d1s.y);
      ctx.lineTo(d2s.x, d2s.y);
      for (const [ps, ds] of exts) {
        const ex = ds.x - ps.x;
        const ey = ds.y - ps.y;
        const el = Math.hypot(ex, ey);
        if (el > 0.5) {
          const evx = ex / el;
          const evy = ey / el;
          ctx.moveTo(ps.x + evx * gap, ps.y + evy * gap);
          ctx.lineTo(ds.x + evx * over, ds.y + evy * over);
        } else {
          // offset = 0: draw a short perpendicular stick through the point
          ctx.moveTo(ds.x + px * (tick + 2 * scale), ds.y + py * (tick + 2 * scale));
          ctx.lineTo(ds.x - px * (tick + 2 * scale), ds.y - py * (tick + 2 * scale));
        }
      }
      if ((markup.tickStyle ?? 'slash') === 'slash') {
        for (const q of [d1s, d2s]) {
          // Architectural slash runs along the opposite 45° diagonal
          const tx = (ux - px) / Math.SQRT2;
          const ty = (uy - py) / Math.SQRT2;
          ctx.moveTo(q.x - tx * tick, q.y - ty * tick);
          ctx.lineTo(q.x + tx * tick, q.y + ty * tick);
        }
        ctx.stroke();
      } else {
        ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle;
        drawArrow(ctx, d1s, d2s, 'filled', style.lineWeight * scale);
        drawArrow(ctx, d2s, d1s, 'filled', style.lineWeight * scale);
      }
      const len = dist({ x: markup.x1, y: markup.y1 }, { x: markup.x2, y: markup.y2 });
      // "Override dimension" carries typed text and ignores the scale. An
      // override cleared to blank draws no label at all — that's a deliberate
      // state (a dimension line with no text), not a fallback to measured.
      const label =
        markup.customLabel !== undefined
          ? markup.customLabel
          : formatLength(len, defaults.scaleFactor, markup.roundTo);
      const loff = 11 * scale;
      // Label sits on the side of the dim line away from the measured points
      // (or the visually-upper side when offset = 0)
      let k: number;
      if (Math.abs(offset) > 0.5) {
        const awayX = d1s.x - p1s.x;
        const awayY = d1s.y - p1s.y;
        k = awayX * px + awayY * py >= 0 ? loff : -loff;
      } else {
        k = py > 0 || (py === 0 && px > 0) ? -loff : loff;
      }
      // Text always runs parallel to the dimension line (kept upright)
      let labelAngle = Math.atan2(uy, ux);
      if (labelAngle > Math.PI / 2) labelAngle -= Math.PI;
      else if (labelAngle < -Math.PI / 2) labelAngle += Math.PI;
      drawCenteredLabel(
        ctx,
        (d1s.x + d2s.x) / 2 + px * k,
        (d1s.y + d2s.y) / 2 + py * k,
        label,
        style.textColor,
        scale,
        style.fontSize,
        style.fontFamily,
        labelAngle,
      );
      break;
    }
    case 'cloud': {
      if (markup.points.length < 3) break;
      if (!multiplyPass) drawCloudPath(ctx, markup.points, scale, pageHeight);
      if (style.fill) {
        paintFill(() => {
          ctx.beginPath();
          const cf = toScreen(markup.points[0]!);
          ctx.moveTo(cf.x, cf.y);
          for (let i = 1; i < markup.points.length; i++) {
            const cp = toScreen(markup.points[i]!);
            ctx.lineTo(cp.x, cp.y);
          }
          ctx.closePath();
          ctx.fill();
        });
      }
      break;
    }
    case 'polyline':
    case 'polygon': {
      if (markup.points.length < 2) break;
      const screen = markup.points.map(toScreen);
      const sz = style.lineWeight * scale * (markup.arrowSize ?? 1);
      const last = screen.length - 1;
      // Pull the first/last path point back to meet the arrowhead (polyline only)
      if (markup.type === 'polyline') {
        const strokeW = style.lineWeight * scale;
        const insS = arrowBodyInset(markup.arrowStart ?? 'none', sz, strokeW);
        const insE = arrowBodyInset(markup.arrowEnd ?? 'none', sz, strokeW);
        if (insS) screen[0] = shortenToward(screen[0]!, screen[1]!, insS);
        if (insE) screen[last] = shortenToward(screen[last]!, screen[last - 1]!, insE);
      }
      ctx.beginPath();
      ctx.moveTo(screen[0]!.x, screen[0]!.y);
      for (let i = 1; i < screen.length; i++) {
        ctx.lineTo(screen[i]!.x, screen[i]!.y);
      }
      if (markup.type === 'polygon') {
        ctx.closePath();
        if (style.fill) paintFill(() => ctx.fill());
      }
      if (multiplyPass) break;
      ctx.stroke();
      if (markup.type === 'polyline') {
        // Optional arrowheads at the open ends — tips at the true endpoints
        const pts = markup.points;
        ctx.fillStyle = style.stroke;
        drawArrow(ctx, toScreen(pts[0]!), toScreen(pts[1]!), markup.arrowStart ?? 'none', sz);
        drawArrow(ctx, toScreen(pts[pts.length - 1]!), toScreen(pts[pts.length - 2]!), markup.arrowEnd ?? 'none', sz);
        // Optional total length, centred on the polyline (midpoint by arc length)
        if (markup.showLength) {
          const len = polylineLength(markup.points);
          const mid = toScreen(polylineMidpoint(markup.points));
          drawCenteredLabel(ctx, mid.x, mid.y - 9 * scale, formatLength(len, defaults.scaleFactor), style.textColor, scale, style.fontSize, style.fontFamily);
        }
      }
      // Polygon: optional enclosed area, centred on the geometric centroid
      if (markup.type === 'polygon' && markup.showArea) {
        const area = polygonArea(markup.points);
        const sc = toScreen(polygonCentroid(markup.points));
        drawCenteredLabel(ctx, sc.x, sc.y, formatArea(area, defaults.scaleFactor, markup.decimals), style.textColor, scale, style.fontSize, style.fontFamily);
      }
      break;
    }
    case 'text': {
      const x = markup.x * scale;
      const y = (pageHeight - markup.y - markup.height) * scale;
      // Optional infill behind the text
      if (style.fill) {
        ctx.fillStyle = style.fill;
        paintFill(() => ctx.fillRect(x, y, markup.width * scale, markup.height * scale));
      }
      if (multiplyPass) break;
      // Box border — drawn with the line color/weight/style (independent of
      // the text color, which only paints the glyphs). Turned off by
      // unchecking Border in the properties panel.
      if (style.border) ctx.strokeRect(x, y, markup.width * scale, markup.height * scale);
      ctx.fillStyle = style.textColor;
      // Clip so text can never spill outside the box
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, markup.width * scale, markup.height * scale);
      ctx.clip();
      drawTextBlock(ctx, paragraphsOf(markup), x, y, markup.width * scale, markup.height * scale, style, scale);
      ctx.restore();
      break;
    }
    case 'callout': {
      // A text box that may carry any number of leaders — each a flat run out
      // of one edge, an elbow, then a diagonal to an arrow tip. With no
      // leaders at all it is simply a box of text.
      const bx = markup.textX * scale;
      const by = (pageHeight - markup.textY - markup.textHeight) * scale;
      const bw = markup.textWidth * scale;
      const bh = markup.textHeight * scale;
      // Multiply pass: the box infill is all this markup contributes
      if (multiplyPass) {
        ctx.fillStyle = style.fill ?? 'rgba(255, 254, 245, 0.92)';
        paintFill(() => ctx.fillRect(bx, by, bw, bh));
        break;
      }
      const box = {
        x: markup.textX,
        y: markup.textY,
        w: markup.textWidth,
        h: markup.textHeight,
      };
      // Callout arrows use a 2.5x larger base than lines, scaled by the multiplier
      const calloutArrow = style.lineWeight * scale * 2.5 * (markup.arrowSize ?? 1);
      const head = markup.arrowEnd ?? 'filled';
      for (const leader of leadersOf(markup)) {
        const path = leaderPath(box, leader);
        const exitS = toScreen(path.exit);
        const elbowS = toScreen(path.elbow);
        const anchorS = toScreen(path.anchor);
        // Pull the leader back to meet the arrowhead (filled -> base, open -> tuck)
        const anchorEnd = shortenToward(
          anchorS,
          elbowS,
          arrowBodyInset(head, calloutArrow, style.lineWeight * scale),
        );
        ctx.beginPath();
        ctx.moveTo(exitS.x, exitS.y);
        ctx.lineTo(elbowS.x, elbowS.y);
        ctx.lineTo(anchorEnd.x, anchorEnd.y);
        ctx.stroke();
        ctx.fillStyle = style.stroke;
        drawArrow(ctx, anchorS, elbowS, head, calloutArrow);
      }
      // Box infill: user-chosen fill, else the cream default
      ctx.fillStyle = style.fill ?? 'rgba(255, 254, 245, 0.92)';
      paintFill(() => ctx.fillRect(bx, by, bw, bh));
      if (style.border) ctx.strokeRect(bx, by, bw, bh);
      ctx.fillStyle = style.textColor;
      // Clip so text can never spill outside the box
      ctx.save();
      ctx.beginPath();
      ctx.rect(bx, by, bw, bh);
      ctx.clip();
      drawTextBlock(ctx, paragraphsOf(markup), bx, by, bw, bh, style, scale);
      ctx.restore();
      break;
    }
    case 'sticky': {
      // Note icon with a folded corner; the comment text lives in the
      // markup and is edited via double-click (kept off the drawing).
      const p = toScreen({ x: markup.x, y: markup.y });
      const s = 18 * scale;
      const fold = s * 0.35;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + s, p.y);
      ctx.lineTo(p.x + s, p.y + s - fold);
      ctx.lineTo(p.x + s - fold, p.y + s);
      ctx.lineTo(p.x, p.y + s);
      ctx.closePath();
      ctx.fillStyle = '#f5c542';
      ctx.fill();
      ctx.strokeStyle = '#a87b14';
      ctx.lineWidth = Math.max(1, scale);
      ctx.setLineDash([]);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x + s - fold, p.y + s);
      ctx.lineTo(p.x + s - fold, p.y + s - fold);
      ctx.lineTo(p.x + s, p.y + s - fold);
      ctx.stroke();
      break;
    }
    case 'measureAngle': {
      const p1 = toScreen(markup.p1);
      const v = toScreen(markup.vertex);
      const p2 = toScreen(markup.p2);
      ctx.beginPath();
      ctx.moveTo(v.x, v.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.moveTo(v.x, v.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      const deg = angleDegrees(markup.p1, markup.vertex, markup.p2);
      drawLabel(ctx, v.x, v.y - 8, formatAngle(deg), style.textColor, scale, style.fontSize, style.fontFamily);
      break;
    }
    case 'snipImage': {
      const img = new Image();
      img.src = markup.imageData;
      const x = markup.x * scale;
      const y = (pageHeight - markup.y - markup.height) * scale;
      if (img.complete) {
        ctx.drawImage(img, x, y, markup.width * scale, markup.height * scale);
      }
      break;
    }
  }
  ctx.restore();
}

function applyLineStyle(ctx: CanvasRenderingContext2D, style: LineStyle, width: number): void {
  ctx.setLineDash(dashPattern(style, width));
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  head: ArrowHead,
  size: number,
): void {
  if (head === 'none') return;
  const [b1, b2] = arrowBarbs(from, to, size);
  const bx1 = b1.x;
  const by1 = b1.y;
  const bx2 = b2.x;
  const by2 = b2.y;

  ctx.save();
  ctx.setLineDash([]);
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';

  if (head === 'open') {
    // Two straight barbs back from the tip
    ctx.beginPath();
    ctx.moveTo(bx1, by1);
    ctx.lineTo(from.x, from.y);
    ctx.lineTo(bx2, by2);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // Filled: a single clean triangle (no extra stroked barbs)
  {
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(bx1, by1);
    ctx.lineTo(bx2, by2);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Centered label with a light halo so it stays readable over linework. */
function drawCenteredLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  color: string,
  scale: number,
  fontSize = 11,
  fontFamily = 'Arial',
  angle = 0,
): void {
  ctx.save();
  ctx.font = canvasFont(fontSize * scale, fontFamily);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.setLineDash([]);
  // Rotate the label (e.g. parallel to a dimension line) about its center
  if (angle) {
    ctx.translate(x, y);
    ctx.rotate(angle);
    x = 0;
    y = 0;
  }
  ctx.lineWidth = 3 * scale;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}


/** Formatted text block inside a box (screen px): word-wrap, block indent,
 *  horizontal + vertical alignment, bold and underline. `pad` is the inner
 *  padding on every side. */
/** Box-level fallbacks a paragraph inherits. */
export function blockStyleOf(style: DrawStyle): BlockStyle {
  return {
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
    lineSpacing: style.lineSpacing,
    bold: style.bold,
    italic: style.italic,
    underline: style.underline,
    indent: style.indent,
    align: style.align,
    valign: style.valign,
    margin: style.margin,
  };
}

/** The paragraphs a markup renders: its own when it has them, otherwise its
 *  plain text split on newlines — which is what every box made before
 *  per-paragraph formatting looks like. */
export function paragraphsOf(markup: Markup): TextParagraph[] {
  const withParas = markup as { paragraphs?: TextParagraph[]; content?: string };
  if (withParas.paragraphs?.length) return withParas.paragraphs;
  return paragraphsFromText(withParas.content ?? '');
}

/** Formatted text inside a box (screen px). Paragraph sizes, weights, slants,
 *  alignments, indents and list markers all come from the shared layout
 *  engine, so this matches the PDF exporter line for line. */
function drawTextBlock(
  ctx: CanvasRenderingContext2D,
  paras: TextParagraph[],
  bx: number,
  by: number,
  bw: number,
  bh: number,
  style: DrawStyle,
  scale: number,
): void {
  const block = blockStyleOf(style);
  const margin = style.margin * scale;
  const availW = Math.max(20, bw - margin * 2);
  const measure = (t: string, size: number, bold: boolean, italic: boolean): number => {
    ctx.font = canvasFont(size * scale, style.fontFamily, bold, italic);
    return ctx.measureText(t).width;
  };
  const resolved = resolveParagraphs(paras, block);
  const { lines, height } = layoutParagraphs(resolved, availW / scale, style.lineSpacing, measure);

  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const top = blockTop(by, bh, height * scale, margin, style.valign);
  const left = bx + margin;

  for (const line of lines) {
    const fontPx = line.size * scale;
    ctx.font = canvasFont(fontPx, style.fontFamily, line.bold, line.italic);
    const lw = ctx.measureText(line.text).width;
    const dx = alignOffset(line, lw / scale) * scale;
    const lx = left + line.x * scale + dx;
    const ly = top + line.y * scale;
    // The marker sits at the paragraph indent, outside the hanging text column
    if (line.marker) {
      const mw = ctx.measureText(line.marker).width;
      ctx.fillText(line.marker, left + line.x * scale - mw - fontPx * 0.45, ly);
    }
    ctx.fillText(line.text, lx, ly);
    if (line.underline && line.text.trim()) {
      ctx.fillRect(lx, ly + fontPx * 0.95, lw, Math.max(1, fontPx * 0.06));
    }
  }
}

let _measureCtx: CanvasRenderingContext2D | null = null;

/** Height the wrapped text needs at the given width — same wrap logic as the
 *  canvas renderer, so text/callout boxes can auto-grow to fit on commit.
 *  All values in page units (pt). */
/** Height the paragraphs need at the given width, in page points — the same
 *  layout the renderer uses, so a box auto-grown on commit fits exactly what
 *  gets drawn into it. */
export function measureParagraphHeight(
  paras: TextParagraph[],
  maxWidth: number,
  block: BlockStyle,
): number {
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
  const ctx = _measureCtx;
  if (!ctx) return block.fontSize * block.lineSpacing;
  const measure = (t: string, size: number, bold: boolean, italic: boolean): number => {
    ctx.font = canvasFont(size, block.fontFamily, bold, italic);
    return ctx.measureText(t).width;
  };
  const resolved = resolveParagraphs(paras, block);
  return layoutParagraphs(resolved, Math.max(20, maxWidth), block.lineSpacing, measure).height;
}


function drawLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  color: string,
  scale: number,
  fontSize = 11,
  fontFamily = 'Arial',
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = canvasFont(fontSize * scale, fontFamily);
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** Draw a revision-cloud outline along the polygon edges using small circular arcs. */
export function drawCloudPath(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  scale: number,
  pageHeight: number,
): void {
  if (points.length < 3) return;
  const ARC_R = CLOUD_ARC_R * scale; // arc radius in screen px
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const ax = a.x * scale;
    const ay = (pageHeight - a.y) * scale;
    const bx = b.x * scale;
    const by = (pageHeight - b.y) * scale;
    const segLen = Math.hypot(bx - ax, by - ay);
    if (segLen < 1) continue;
    const numArcs = Math.max(1, Math.round(segLen / (ARC_R * 2)));
    const angle = Math.atan2(by - ay, bx - ax);
    for (let j = 0; j < numArcs; j++) {
      const t = (j + 0.5) / numArcs;
      const cx = ax + (bx - ax) * t;
      const cy = ay + (by - ay) * t;
      ctx.arc(cx, cy, ARC_R, angle + Math.PI, angle, false);
    }
  }
  ctx.stroke();
}
