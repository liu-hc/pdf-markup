import type {
  Markup,
  PageDefaults,
  Point,
  ArrowHead,
  LineStyle,
} from '../state/types';
import {
  polygonArea,
  polylineLength,
  polygonCentroid,
  polylineMidpoint,
  angleDegrees,
  dist,
  dimensionGeometry,
  calloutLeader,
} from '../util/geometry';
import { formatLength, formatArea, formatAngle } from '../util/units';

export interface DrawStyle {
  stroke: string;
  fill: string | null;
  textColor: string;
  lineWeight: number;
  lineStyle: LineStyle;
  opacity: number;
  fontSize: number;
  fontFamily: string;
  lineSpacing: number;
  bold: boolean;
  underline: boolean;
  /** Block left indent, in steps of INDENT_STEP pt. */
  indent: number;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
}

/** One indent step in page points. */
export const INDENT_STEP = 12;

export function resolveStyle(markup: Markup, defaults: PageDefaults): DrawStyle {
  return {
    stroke: markup.overrides?.strokeColor ?? defaults.strokeColor,
    fill: markup.overrides?.fillColor !== undefined ? markup.overrides.fillColor : defaults.fillColor,
    textColor: markup.overrides?.textColor ?? defaults.textColor,
    lineWeight: markup.overrides?.lineWeight ?? defaults.lineWeight,
    lineStyle: markup.overrides?.lineStyle ?? defaults.lineStyle,
    opacity: markup.overrides?.opacity ?? 1,
    fontSize: markup.overrides?.fontSize ?? defaults.fontSize ?? 12,
    fontFamily: markup.overrides?.fontFamily ?? defaults.fontFamily ?? 'Arial',
    lineSpacing: markup.overrides?.lineSpacing ?? 1.35,
    bold: markup.overrides?.bold ?? false,
    underline: markup.overrides?.underline ?? false,
    indent: markup.overrides?.indent ?? 0,
    align: markup.overrides?.align ?? 'left',
    valign: markup.overrides?.valign ?? 'top',
  };
}

/** Canvas font shorthand — quoted family with a sans-serif fallback. */
function canvasFont(sizePx: number, family: string, bold = false): string {
  return `${bold ? '700 ' : ''}${sizePx}px "${family}", sans-serif`;
}

export function drawMarkupOnCanvas(
  ctx: CanvasRenderingContext2D,
  markup: Markup,
  defaults: PageDefaults,
  scale: number,
  pageHeight: number,
): void {
  const style = resolveStyle(markup, defaults);
  ctx.save();
  ctx.globalAlpha = style.opacity;
  // Box (rectangular) line finish — never rounded caps/joins
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  applyLineStyle(ctx, style.lineStyle, style.lineWeight * scale);
  ctx.strokeStyle = style.stroke;
  ctx.fillStyle = style.fill ?? 'transparent';
  ctx.lineWidth = style.lineWeight * scale;

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
      if (style.fill) ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      ctx.restore();
      break;
    }
    case 'highlighter': {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = style.fill ?? '#f5c542';
      const x = markup.x * scale;
      const y = (pageHeight - markup.y - markup.height) * scale;
      ctx.fillRect(x, y, markup.width * scale, markup.height * scale);
      break;
    }
    case 'inkHighlight': {
      // Fat translucent marker swipe with a round pen — opacity + colour come
      // from the markup's overrides (yellow @ 0.35) set on the global above.
      if (!markup.points.length) break;
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
      ctx.stroke();
      if (style.fill) ctx.fill();
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
      const label = formatLength(len, defaults.scaleFactor, markup.roundTo);
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
      drawCloudPath(ctx, markup.points, scale, pageHeight);
      if (style.fill) {
        ctx.beginPath();
        const cf = toScreen(markup.points[0]!);
        ctx.moveTo(cf.x, cf.y);
        for (let i = 1; i < markup.points.length; i++) {
          const cp = toScreen(markup.points[i]!);
          ctx.lineTo(cp.x, cp.y);
        }
        ctx.closePath();
        ctx.fill();
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
        if (style.fill) ctx.fill();
      }
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
        ctx.fillRect(x, y, markup.width * scale, markup.height * scale);
      }
      // Box border — drawn with the line color/weight/style (independent of
      // the text color, which only paints the glyphs)
      ctx.strokeRect(x, y, markup.width * scale, markup.height * scale);
      ctx.fillStyle = style.textColor;
      // Clip so text can never spill outside the box
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, markup.width * scale, markup.height * scale);
      ctx.clip();
      drawTextBlock(ctx, markup.content, x, y, markup.width * scale, markup.height * scale, 3 * scale, style, scale);
      ctx.restore();
      break;
    }
    case 'callout': {
      // Bluebeam-style: bordered text box + leader line from the nearest box
      // edge to the anchor point, ending in an arrowhead.
      const bx = markup.textX * scale;
      const by = (pageHeight - markup.textY - markup.textHeight) * scale;
      const bw = markup.textWidth * scale;
      const bh = markup.textHeight * scale;
      const anchor = toScreen({ x: markup.anchorX, y: markup.anchorY });
      // Elbow leader: horizontal run out of the box at mid-height, kink,
      // then a diagonal to the anchor
      const leader = calloutLeader(
        markup.textX,
        markup.textY,
        markup.textWidth,
        markup.textHeight,
        markup.anchorX,
        markup.anchorY,
        markup.kinkX,
        markup.kinkY,
      );
      const exitS = toScreen(leader.exit);
      const kinkS = toScreen(leader.kink);
      // Callout arrows use a 2.5× larger base than lines, scaled by the multiplier
      const calloutArrow = style.lineWeight * scale * 2.5 * (markup.arrowSize ?? 1);
      const head = markup.arrowEnd ?? 'filled';
      // Pull the leader back to meet the arrowhead (filled → base, open → tuck)
      const anchorEnd = shortenToward(anchor, kinkS, arrowBodyInset(head, calloutArrow, style.lineWeight * scale));
      ctx.beginPath();
      ctx.moveTo(exitS.x, exitS.y);
      ctx.lineTo(kinkS.x, kinkS.y);
      ctx.lineTo(anchorEnd.x, anchorEnd.y);
      ctx.stroke();
      ctx.fillStyle = style.stroke;
      drawArrow(ctx, anchor, kinkS, head, calloutArrow);
      // Box infill: user-chosen fill, else the cream default
      ctx.fillStyle = style.fill ?? 'rgba(255, 254, 245, 0.92)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeRect(bx, by, bw, bh);
      ctx.fillStyle = style.textColor;
      // Clip so text can never spill outside the callout box
      ctx.save();
      ctx.beginPath();
      ctx.rect(bx, by, bw, bh);
      ctx.clip();
      drawTextBlock(ctx, markup.content, bx, by, bw, bh, 4 * scale, style, scale);
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
  switch (style) {
    case 'dashed':
      ctx.setLineDash([width * 4, width * 2]);
      break;
    case 'dotted':
      ctx.setLineDash([width, width * 2]);
      break;
    case 'centerline':
      ctx.setLineDash([width * 8, width * 2, width * 2, width * 2]);
      break;
    default:
      ctx.setLineDash([]);
  }
}

/** Half-angle of the arrowhead — atan(0.5) so the base width equals the axial
 *  depth (a 1:1 width-to-length triangle). */
const ARROW_SPREAD = Math.atan(0.5);

/** Barb length (tip → barb end, along the hypotenuse) for a head of `size`. */
const ARROW_LEN = 6;

/** Axial depth (tip → base) of an arrowhead of the given `size`. The body line
 *  is shortened by this amount so the thick stroke doesn't poke through and
 *  blunt the sharp triangular tip. */
function arrowDepth(size: number): number {
  return size * ARROW_LEN * Math.cos(ARROW_SPREAD);
}

/** How far to pull the body line back from the true tip for a given head.
 *  Filled → to the triangle base. Open (V) has no base, so only tuck the butt
 *  cap behind the tip (half the stroke width) so the line still meets the V
 *  without the squared end poking past it. */
function arrowBodyInset(head: ArrowHead, size: number, strokeW: number): number {
  if (head === 'none') return 0;
  return head === 'filled' ? arrowDepth(size) : strokeW * 0.6;
}

/** Move `p` toward `toward` by `dist` (clamped so it never overshoots). */
function shortenToward(p: Point, toward: Point, dist: number): Point {
  const dx = toward.x - p.x;
  const dy = toward.y - p.y;
  const L = Math.hypot(dx, dy) || 1;
  const d = Math.min(dist, L * 0.9);
  return { x: p.x + (dx / L) * d, y: p.y + (dy / L) * d };
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  head: ArrowHead,
  size: number,
): void {
  if (head === 'none') return;
  const angle = Math.atan2(from.y - to.y, from.x - to.x);
  const len = size * ARROW_LEN;
  const spread = ARROW_SPREAD;
  const bx1 = from.x - len * Math.cos(angle - spread);
  const by1 = from.y - len * Math.sin(angle - spread);
  const bx2 = from.x - len * Math.cos(angle + spread);
  const by2 = from.y - len * Math.sin(angle + spread);

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

/** Break text into lines that fit `maxWidth`: wraps between words, and words
 *  wider than a whole line are broken mid-word so nothing can escape the box. */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (let word of para.split(' ')) {
      // A word wider than the whole line: emit fitting chunks of it
      while (ctx.measureText(word).width > maxWidth && word.length > 1) {
        if (line && ctx.measureText(`${line} ${word[0]}`).width > maxWidth) {
          lines.push(line);
          line = '';
        }
        const base = line ? `${line} ` : '';
        // Largest prefix of the word that still fits on this line
        let lo = 1;
        let hi = word.length - 1;
        let fit = 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (ctx.measureText(base + word.slice(0, mid)).width <= maxWidth) {
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
      if (line && ctx.measureText(candidate).width > maxWidth) {
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

/** Formatted text block inside a box (screen px): word-wrap, block indent,
 *  horizontal + vertical alignment, bold and underline. `pad` is the inner
 *  padding on every side. */
function drawTextBlock(
  ctx: CanvasRenderingContext2D,
  text: string,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  pad: number,
  style: DrawStyle,
  scale: number,
): void {
  const fontSize = style.fontSize * scale;
  const indent = style.indent * INDENT_STEP * scale;
  const availW = Math.max(20, bw - pad * 2 - indent);
  ctx.font = canvasFont(fontSize, style.fontFamily, style.bold);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const lineHeight = fontSize * style.lineSpacing;
  const lines = wrapLines(ctx, text, availW);
  const blockH = lines.length * lineHeight;
  let cy =
    style.valign === 'middle'
      ? by + Math.max(pad, (bh - blockH) / 2)
      : style.valign === 'bottom'
        ? by + Math.max(pad, bh - pad - blockH)
        : by + pad;
  const left = bx + pad + indent;
  for (const line of lines) {
    const lw = ctx.measureText(line).width;
    const lx =
      style.align === 'center'
        ? left + (availW - lw) / 2
        : style.align === 'right'
          ? left + availW - lw
          : left;
    ctx.fillText(line, lx, cy);
    if (style.underline && line.trim()) {
      ctx.fillRect(lx, cy + fontSize * 0.95, lw, Math.max(1, fontSize * 0.06));
    }
    cy += lineHeight;
  }
}

let _measureCtx: CanvasRenderingContext2D | null = null;

/** Height the wrapped text needs at the given width — same wrap logic as the
 *  canvas renderer, so text/callout boxes can auto-grow to fit on commit.
 *  All values in page units (pt). */
export function measureTextBlockHeight(
  text: string,
  maxWidth: number,
  fontSize: number,
  fontFamily = 'Arial',
  lineSpacing = 1.35,
  bold = false,
  indentSteps = 0,
): number {
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
  if (!_measureCtx) return fontSize * lineSpacing;
  _measureCtx.font = canvasFont(fontSize, fontFamily, bold);
  const lines = wrapLines(_measureCtx, text, Math.max(20, maxWidth - indentSteps * INDENT_STEP));
  return lines.length * fontSize * lineSpacing;
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
  const ARC_R = 8 * scale; // arc radius in screen px
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
