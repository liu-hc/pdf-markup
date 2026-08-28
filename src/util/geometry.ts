import type { ArrowHead, LineStyle, Point } from '../state/types';
import { ARCH_SCALES, ENG_SCALES, FULL_SCALE_LABEL } from '../state/types';

/* ── Shared markup geometry ───────────────────────────────────────────────
   Pure maths, no canvas and no pdf-lib, so the on-screen renderer
   (markups/draw.ts) and the PDF exporter (pdf/export.ts) draw the SAME
   shapes. Anything both need lives here; if it only one of them needs it,
   it stays in that module. */

/** Arrowhead half-angle — atan(0.5), so the base width equals the axial
 *  depth (a 1:1 width-to-length triangle). */
export const ARROW_SPREAD = Math.atan(0.5);

/** Barb length (tip → barb end, along the hypotenuse) per unit of arrow size. */
export const ARROW_LEN = 6;

/** Axial depth (tip → base) of an arrowhead of the given size. */
export function arrowDepth(size: number): number {
  return size * ARROW_LEN * Math.cos(ARROW_SPREAD);
}

/** How far to pull a body line back from the true tip. Filled → to the
 *  triangle base. Open (V) has no base, so only tuck the butt cap behind the
 *  tip so the squared end doesn't poke past the V. */
export function arrowBodyInset(head: ArrowHead, size: number, strokeW: number): number {
  if (head === 'none') return 0;
  return head === 'filled' ? arrowDepth(size) : strokeW * 0.6;
}

/** Move `p` toward `toward` by `dist` (clamped so it never overshoots). */
export function shortenToward(p: Point, toward: Point, dist: number): Point {
  const dx = toward.x - p.x;
  const dy = toward.y - p.y;
  const L = Math.hypot(dx, dy) || 1;
  const d = Math.min(dist, L * 0.9);
  return { x: p.x + (dx / L) * d, y: p.y + (dy / L) * d };
}

/** The two barb endpoints of an arrowhead whose tip is at `tip`, pointing away
 *  from `awayFrom`. Space-agnostic: feed it screen coords or page coords and
 *  the triangle comes back in the same space. */
export function arrowBarbs(tip: Point, awayFrom: Point, size: number): [Point, Point] {
  const angle = Math.atan2(tip.y - awayFrom.y, tip.x - awayFrom.x);
  const len = size * ARROW_LEN;
  return [
    { x: tip.x - len * Math.cos(angle - ARROW_SPREAD), y: tip.y - len * Math.sin(angle - ARROW_SPREAD) },
    { x: tip.x - len * Math.cos(angle + ARROW_SPREAD), y: tip.y - len * Math.sin(angle + ARROW_SPREAD) },
  ];
}

/** Dash pattern for a line style at a given stroke width, or [] for solid.
 *  Both renderers take their dashes from here. */
export function dashPattern(style: LineStyle, width: number): number[] {
  switch (style) {
    case 'dashed':
      return [width * 4, width * 2];
    case 'dotted':
      return [width, width * 2];
    case 'centerline':
      return [width * 8, width * 2, width * 2, width * 2];
    default:
      return [];
  }
}

/** Revision-cloud scallop radius, in page points. */
export const CLOUD_ARC_R = 8;

/** The scalloped outline of a revision cloud, flattened to a point list in
 *  PAGE coordinates (y-up).
 *
 *  The canvas renderer draws these with ctx.arc in its own y-down space; this
 *  mirrors that maths in y-down and flips back at the end, so the exported
 *  cloud scallops bulge exactly the way the on-screen one does. */
export function cloudOutline(points: Point[], r = CLOUD_ARC_R, stepsPerArc = 10): Point[] {
  if (points.length < 3) return [];
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    // y-down mirror of the page coords, matching the canvas maths
    const ax = a.x;
    const ay = -a.y;
    const bx = b.x;
    const by = -b.y;
    const segLen = Math.hypot(bx - ax, by - ay);
    if (segLen < 1) continue;
    const numArcs = Math.max(1, Math.round(segLen / (r * 2)));
    const angle = Math.atan2(by - ay, bx - ax);
    for (let j = 0; j < numArcs; j++) {
      const t = (j + 0.5) / numArcs;
      const cx = ax + (bx - ax) * t;
      const cy = ay + (by - ay) * t;
      // ctx.arc(cx, cy, r, angle + PI, angle, false) sweeps in +theta,
      // i.e. angle+PI through angle+2PI
      for (let s = 0; s <= stepsPerArc; s++) {
        const th = angle + Math.PI + (Math.PI * s) / stepsPerArc;
        out.push({ x: cx + r * Math.cos(th), y: -(cy + r * Math.sin(th)) });
      }
    }
  }
  return out;
}

/** Cubic-bezier approximation of an ellipse, optionally rotated (degrees,
 *  screen-clockwise like the markup's own `rotation`). Returns the start point
 *  plus four [c1, c2, end] curve triples, in page coordinates. */
export function ellipseBezier(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotationDeg = 0,
): { start: Point; curves: [Point, Point, Point][] } {
  const K = 0.5522847498307936;
  // Stored rotation is screen-clockwise; page space is y-up, so it negates
  const t = (-rotationDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const at = (x: number, y: number): Point => ({
    x: cx + x * cos - y * sin,
    y: cy + x * sin + y * cos,
  });
  return {
    start: at(rx, 0),
    curves: [
      [at(rx, K * ry), at(K * rx, ry), at(0, ry)],
      [at(-K * rx, ry), at(-rx, K * ry), at(-rx, 0)],
      [at(-rx, -K * ry), at(-K * rx, -ry), at(0, -ry)],
      [at(K * rx, -ry), at(rx, -K * ry), at(rx, 0)],
    ],
  };
}

/** The four corners of a rectangle rotated about its centre (page coords).
 *  `rotationDeg` is the markup's screen-clockwise rotation. */
export function rotatedRectCorners(
  x: number,
  y: number,
  w: number,
  h: number,
  rotationDeg = 0,
): Point[] {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const t = (-rotationDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([dx, dy]) => ({ x: cx + dx! * cos - dy! * sin, y: cy + dx! * sin + dy! * cos }));
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Geometry for an offset dimension (all in page coordinates, y-up).
 *  The dimension line runs parallel to the measured segment P1→P2, displaced
 *  by `offset` along the unit perpendicular (nx, ny). Extension lines connect
 *  the measured points to the dimension line. */
export function dimensionGeometry(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  offset: number,
): {
  d1: Point;
  d2: Point;
  nx: number;
  ny: number;
  ux: number;
  uy: number;
  mid: Point;
} {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L;
  const uy = dy / L;
  const nx = -uy;
  const ny = ux;
  const d1 = { x: x1 + nx * offset, y: y1 + ny * offset };
  const d2 = { x: x2 + nx * offset, y: y2 + ny * offset };
  return { d1, d2, nx, ny, ux, uy, mid: { x: (d1.x + d2.x) / 2, y: (d1.y + d2.y) / 2 } };
}

/** Elbow leader for a callout (page coordinates, y-up).
 *  Exits the text box horizontally at mid-height on the left or right side
 *  (whichever the kink is on), runs to the kink, then goes diagonally to the
 *  anchor. When kinkX is undefined, a default is derived on the anchor side. */
export function calloutLeader(
  textX: number,
  textY: number,
  textWidth: number,
  textHeight: number,
  anchorX: number,
  _anchorY: number,
  kinkX: number | undefined,
  kinkY?: number,
): { exit: Point; kink: Point } {
  const centerX = textX + textWidth / 2;
  const centerY = textY + textHeight / 2;

  // 3-click callout: the elbow's X sets how long the horizontal run out of the
  // box is. The leader exits the CENTRE of the left or right edge and the elbow
  // stays on that mid-height line, so the box→elbow segment is always
  // horizontal; the elbow→anchor segment then angles down to the subject.
  if (kinkX !== undefined && kinkY !== undefined) {
    const exitX = kinkX >= centerX ? textX + textWidth : textX;
    return { exit: { x: exitX, y: centerY }, kink: { x: kinkX, y: centerY } };
  }

  // Legacy single-axis elbow: exits horizontally at the box mid-height.
  const cy = centerY;
  let kx = kinkX;
  if (kx === undefined) {
    kx = anchorX >= centerX ? textX + textWidth + 20 : textX - 20;
  }
  const exitX = kx >= centerX ? textX + textWidth : textX;
  return { exit: { x: exitX, y: cy }, kink: { x: kx, y: cy } };
}

/** Area-weighted polygon centroid (page coords). Falls back to the vertex
 *  average for degenerate (zero-area) inputs so the label still lands sensibly. */
export function polygonCentroid(points: Point[]): Point {
  const n = points.length;
  if (n === 0) return { x: 0, y: 0 };
  if (n < 3) {
    let x = 0;
    let y = 0;
    for (const p of points) {
      x += p.x;
      y += p.y;
    }
    return { x: x / n, y: y / n };
  }
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const p0 = points[i]!;
    const p1 = points[(i + 1) % n]!;
    const cross = p0.x * p1.y - p1.x * p0.y;
    a += cross;
    cx += (p0.x + p1.x) * cross;
    cy += (p0.y + p1.y) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    let x = 0;
    let y = 0;
    for (const p of points) {
      x += p.x;
      y += p.y;
    }
    return { x: x / n, y: y / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Point halfway along a polyline by arc length (page coords). */
export function polylineMidpoint(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { ...points[0]! };
  const half = polylineLength(points) / 2;
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = dist(points[i - 1]!, points[i]!);
    if (acc + seg >= half) {
      const t = seg === 0 ? 0 : (half - acc) / seg;
      return {
        x: points[i - 1]!.x + (points[i]!.x - points[i - 1]!.x) * t,
        y: points[i - 1]!.y + (points[i]!.y - points[i - 1]!.y) * t,
      };
    }
    acc += seg;
  }
  return { ...points[points.length - 1]! };
}

export function polygonArea(points: Point[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    sum += points[i]!.x * points[j]!.y - points[j]!.x * points[i]!.y;
  }
  return Math.abs(sum) / 2;
}

export function polylineLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += dist(points[i - 1]!, points[i]!);
  }
  return len;
}

export function angleDegrees(p1: Point, vertex: Point, p2: Point): number {
  const a = dist(vertex, p1);
  const b = dist(vertex, p2);
  const c = dist(p1, p2);
  if (a === 0 || b === 0) return 0;
  const cos = Math.max(-1, Math.min(1, (a * a + b * b - c * c) / (2 * a * b)));
  return (Math.acos(cos) * 180) / Math.PI;
}

export function pointInRect(px: number, py: number, x: number, y: number, w: number, h: number): boolean {
  const minX = Math.min(x, x + w);
  const maxX = Math.max(x, x + w);
  const minY = Math.min(y, y + h);
  const maxY = Math.max(y, y + h);
  return px >= minX && px <= maxX && py >= minY && py <= maxY;
}

export function normalizeRect(x: number, y: number, w: number, h: number) {
  return {
    x: w < 0 ? x + w : x,
    y: h < 0 ? y + h : y,
    width: Math.abs(w),
    height: Math.abs(h),
  };
}

/** Scale factor (real-world inches per paper inch) for a scale-select label.
 *  Covers "None", the 1:1 full-size label, and the arch / eng presets. */
export function scaleFactorForLabel(label: string): number | null {
  if (!label || label === 'None') return null;
  if (label === FULL_SCALE_LABEL) return 1;
  return parseArchScale(label) ?? parseEngScale(label) ?? null;
}

/** Resolve a measured calibration factor to a real scale.
 *
 *  Calibrating by eye never lands exactly on 48 or 96, so a factor within
 *  CALIBRATION_TOLERANCE (4%) of a standard architectural or engineering scale
 *  snaps to that scale EXACTLY — which is what the drawing is actually at, and
 *  it stops every later dimension inheriting the pick-up error. Anything that
 *  matches nothing standard keeps its measured factor and gets a label that
 *  states it, rather than the uninformative "Custom".
 *
 *  4% is forgiving of a couple of pixels' pick-up error at working zoom while
 *  staying well inside the ~12.5% that would risk reaching the wrong scale:
 *  the closest pair in the whole table is 1/8" (96) against 1" = 10' (120). */
const CALIBRATION_TOLERANCE = 0.04;

export function resolveCalibratedScale(factor: number): { label: string; factor: number } {
  let best: { label: string; factor: number } | null = null;
  let bestErr = CALIBRATION_TOLERANCE;
  for (const label of [FULL_SCALE_LABEL, ...ARCH_SCALES, ...ENG_SCALES]) {
    const f = scaleFactorForLabel(label);
    if (!f) continue;
    const err = Math.abs(f - factor) / f;
    if (err < bestErr) {
      bestErr = err;
      best = { label, factor: f };
    }
  }
  if (best) return best;

  // No standard match — say what the scale actually is, in the engineering
  // form so it parses back to the same factor. `factor` is real-world inches
  // per paper inch.
  const feet = Number((factor / 12).toFixed(3));
  return { label: `1" = ${feet}'`, factor };
}

export function parseArchScale(label: string): number | null {
  const m = label.match(/^([\d\s\/\.]+)"\s*=\s*1'-0"$/);
  if (!m) return null;
  const inches = parseFractionInches(m[1]!.trim());
  if (inches == null) return null;
  return 12 / inches;
}

export function parseEngScale(label: string): number | null {
  // Decimals allowed: a calibrated scale that matches no standard is written
  // in this form (1" = 12.5') and has to parse back to the same factor.
  const m = label.match(/^1"\s*=\s*([\d]*\.?[\d]+)'$/);
  if (!m) return null;
  // The scale factor is real-world INCHES per paper inch (parseArchScale
  // returns 48 for 1/4"=1'-0"). 1" = N' means N feet = N*12 inches per inch —
  // returning bare feet made every engineer scale read 12× short.
  return Number(m[1]) * 12;
}

export function parseFractionInches(s: string): number | null {
  const parts = s.split(/\s+/);
  let total = 0;
  for (const p of parts) {
    if (p.includes('/')) {
      const [n, d] = p.split('/');
      total += Number(n) / Number(d);
    } else {
      total += Number(p);
    }
  }
  return Number.isFinite(total) ? total : null;
}

export function pageToScreen(
  px: number,
  py: number,
  scale: number,
  offsetX: number,
  offsetY: number,
  pageHeight: number,
): Point {
  return {
    x: offsetX + px * scale,
    y: offsetY + (pageHeight - py) * scale,
  };
}

export function screenToPage(
  sx: number,
  sy: number,
  scale: number,
  offsetX: number,
  offsetY: number,
  pageHeight: number,
): Point {
  return {
    x: (sx - offsetX) / scale,
    y: pageHeight - (sy - offsetY) / scale,
  };
}

export function clonePoint(p: Point): Point {
  return { x: p.x, y: p.y };
}

export function clonePoints(points: Point[]): Point[] {
  return points.map(clonePoint);
}
