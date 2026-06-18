import type { Markup, Point } from '../state/types';
import { dist, pointInRect, dimensionGeometry, calloutLeader } from '../util/geometry';

const HIT_TOLERANCE = 8;

/** Inverse of a shape's screen-clockwise rotation, mapping a page point into
 *  the shape's local (axis-aligned) frame. */
function unrotate(p: Point, c: Point, deg: number): Point {
  const t = (-deg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos + dy * sin, y: c.y - dx * sin + dy * cos };
}

export function hitTestMarkup(markup: Markup, p: Point, tolerance = HIT_TOLERANCE): boolean {
  switch (markup.type) {
    case 'rectangle': {
      // Un-rotate the click into the rect's local frame
      const rot = markup.rotation ?? 0;
      const lp = rot ? unrotate(p, { x: markup.x + markup.width / 2, y: markup.y + markup.height / 2 }, rot) : p;
      return pointInRect(lp.x, lp.y, markup.x, markup.y, markup.width, markup.height);
    }
    case 'highlighter':
    case 'snipImage':
      return pointInRect(p.x, p.y, markup.x, markup.y, markup.width, markup.height);
    case 'ellipse': {
      const rot = markup.rotation ?? 0;
      const lp = rot ? unrotate(p, { x: markup.cx, y: markup.cy }, rot) : p;
      const dx = (lp.x - markup.cx) / markup.rx;
      const dy = (lp.y - markup.cy) / markup.ry;
      return dx * dx + dy * dy <= 1;
    }
    case 'line':
      return distToSegment(p, { x: markup.x1, y: markup.y1 }, { x: markup.x2, y: markup.y2 }) <= tolerance;
    case 'dimension': {
      // Clickable along the (possibly offset) dimension line and both
      // extension lines
      const g = dimensionGeometry(markup.x1, markup.y1, markup.x2, markup.y2, markup.offset ?? 0);
      return (
        distToSegment(p, g.d1, g.d2) <= tolerance ||
        distToSegment(p, { x: markup.x1, y: markup.y1 }, g.d1) <= tolerance ||
        distToSegment(p, { x: markup.x2, y: markup.y2 }, g.d2) <= tolerance
      );
    }
    case 'polyline':
    case 'polygon':
    case 'cloud':
      for (let i = 1; i < markup.points.length; i++) {
        if (distToSegment(p, markup.points[i - 1]!, markup.points[i]!) <= tolerance) return true;
      }
      return false;
    case 'inkHighlight': {
      // Clickable anywhere under the fat pen stroke
      const tol = Math.max(tolerance, markup.penWidth / 2);
      if (markup.points.length === 1) return dist(p, markup.points[0]!) <= tol;
      for (let i = 1; i < markup.points.length; i++) {
        if (distToSegment(p, markup.points[i - 1]!, markup.points[i]!) <= tol) return true;
      }
      return false;
    }
    case 'text':
      return pointInRect(p.x, p.y, markup.x, markup.y, markup.width, markup.height);
    case 'callout': {
      const leader = calloutLeader(
        markup.textX,
        markup.textY,
        markup.textWidth,
        markup.textHeight,
        markup.anchorX,
        markup.anchorY,
        markup.kinkX,
      );
      return (
        pointInRect(p.x, p.y, markup.textX, markup.textY, markup.textWidth, markup.textHeight) ||
        distToSegment(p, leader.exit, leader.kink) <= tolerance ||
        distToSegment(p, leader.kink, { x: markup.anchorX, y: markup.anchorY }) <= tolerance
      );
    }
    case 'sticky':
      return dist(p, { x: markup.x, y: markup.y }) <= 12;
    case 'measureAngle':
      return (
        distToSegment(p, markup.vertex, markup.p1) <= tolerance ||
        distToSegment(p, markup.vertex, markup.p2) <= tolerance
      );
  }
}

export function findMarkupAtPoint(markups: Markup[], pageIndex: number, p: Point): Markup | null {
  const pageMarkups = markups.filter((m) => m.pageIndex === pageIndex).reverse();
  for (const m of pageMarkups) {
    if (hitTestMarkup(m, p)) return m;
  }
  return null;
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const l2 = dist(a, b) ** 2;
  if (l2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
}

export function getMarkupBounds(markup: Markup): { x: number; y: number; w: number; h: number } {
  switch (markup.type) {
    case 'rectangle':
    case 'highlighter':
    case 'snipImage':
      return { x: markup.x, y: markup.y, w: markup.width, h: markup.height };
    case 'ellipse':
      return {
        x: markup.cx - markup.rx,
        y: markup.cy - markup.ry,
        w: markup.rx * 2,
        h: markup.ry * 2,
      };
    case 'line':
    case 'dimension':
      return {
        x: Math.min(markup.x1, markup.x2),
        y: Math.min(markup.y1, markup.y2),
        w: Math.abs(markup.x2 - markup.x1),
        h: Math.abs(markup.y2 - markup.y1),
      };
    case 'inkHighlight': {
      if (!markup.points.length) return { x: 0, y: 0, w: 0, h: 0 };
      const xs = markup.points.map((pt) => pt.x);
      const ys = markup.points.map((pt) => pt.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
    }
    default:
      return { x: 0, y: 0, w: 0, h: 0 };
  }
}

export function cloneMarkup(m: Markup, newId: string, pageIndex?: number): Markup {
  const base = { ...m, id: newId, pageIndex: pageIndex ?? m.pageIndex };
  if ('points' in base && base.points) {
    return { ...base, points: base.points.map((p) => ({ ...p })) } as Markup;
  }
  if (m.type === 'measureAngle') {
    return {
      ...base,
      p1: { ...m.p1 },
      vertex: { ...m.vertex },
      p2: { ...m.p2 },
    } as Markup;
  }
  return base as Markup;
}
