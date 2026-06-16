import type { Point } from '../state/types';

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

export function parseArchScale(label: string): number | null {
  const m = label.match(/^([\d\s\/\.]+)"\s*=\s*1'-0"$/);
  if (!m) return null;
  const inches = parseFractionInches(m[1]!.trim());
  if (inches == null) return null;
  return 12 / inches;
}

export function parseEngScale(label: string): number | null {
  const m = label.match(/^1"\s*=\s*([\d]+)'$/);
  if (!m) return null;
  return Number(m[1]);
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
