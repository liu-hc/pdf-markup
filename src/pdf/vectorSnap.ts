/* Vector snapping for measure tools.
 *
 * Architectural PDFs out of Revit/AutoCAD are vector drawings: every wall,
 * grid line and door swing is a path in the content stream. This module walks
 * a page's operator list once, collects the path geometry in PAGE coordinates
 * (the same y-up point space the markups live in), and indexes it so the
 * dimension tools can snap the cursor to real drawing geometry:
 *
 *   1. VERTEX  — an endpoint of a line/curve, or a corner of a shape (highest
 *      priority: an exact hit wins over anything else).
 *   2. MIDPOINT — the middle of a straight segment.
 *   3. EDGE    — the nearest point ON a line or curve (lowest priority).
 *
 * Everything is lazy and cached per page. Extraction is capped so a 60MB CAD
 * sheet can't blow out memory; past the cap snapping still works, just on the
 * geometry gathered so far.
 */

import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Point } from '../state/types';

/** pdf.js operator codes we care about (OPS in pdfjs-dist). */
const OP_SAVE = 10;
const OP_RESTORE = 11;
const OP_TRANSFORM = 12;
const OP_FORM_BEGIN = 74;
const OP_FORM_END = 75;
const OP_CONSTRUCT_PATH = 91;

/** pdf.js DrawOPS codes inside a constructPath data array. */
const D_MOVE_TO = 0;
const D_LINE_TO = 1;
const D_CURVE_TO = 2;
const D_QUAD_TO = 3;
const D_CLOSE = 4;

/** Hard caps — a page past these still snaps, just on partial geometry. */
const MAX_VERTICES = 400_000;
const MAX_SEGMENTS = 200_000;
/** Bezier flattening: chords per curve. More = better edge snapping, more RAM. */
const CURVE_STEPS = 6;
/** Grid cell size (page points) for the vertex index. */
const VERTEX_CELL = 24;
/** Grid cell size (page points) for the segment index — coarser, since a
 *  segment is inserted into every cell its bounding box touches. */
const SEGMENT_CELL = 96;
/** A segment spanning more cells than this is indexed by its endpoints' cells
 *  only (a page-long construction line shouldn't populate the whole grid). */
const MAX_SEGMENT_CELLS = 256;

export type SnapKind = 'vertex' | 'edge';

export interface SnapHit {
  point: Point;
  kind: SnapKind;
  /** Distance from the query point, in page units. */
  distance: number;
}

/** A page's snappable geometry, indexed for nearest-neighbour queries. */
export interface SnapIndex {
  /** Vertex coordinates, packed x,y,x,y… */
  vx: Float32Array;
  vertexCount: number;
  /** Segment endpoints, packed x1,y1,x2,y2,… */
  seg: Float32Array;
  segmentCount: number;
  /** CSR vertex grid. */
  vGrid: CellIndex;
  /** CSR segment grid. */
  sGrid: CellIndex;
  /** True when extraction hit a cap and the geometry is partial. */
  truncated: boolean;
}

/** Compressed-sparse-row bucket grid: `items[start[c] … start[c+1])` are the
 *  element indices in cell `c`. */
interface CellIndex {
  cols: number;
  rows: number;
  cell: number;
  start: Int32Array;
  items: Int32Array;
}

const cache = new Map<string, Map<number, SnapIndex>>();

/** Indexed pages kept per document, most-recently-used first.
 *
 *  A dense sheet indexes to roughly 400k vertices and 200k segments — about
 *  7MB of typed arrays. Keeping every page ever visited in a 53-page set meant
 *  hundreds of megabytes and the GC pressure that comes with it, so the cache
 *  is now bounded; a page that falls out is simply re-read if it is needed
 *  again. */
const MAX_CACHED_PAGES = 8;
const loading = new Set<string>();

function key(docId: string, pageIndex: number): string {
  return `${docId}:${pageIndex}`;
}

/** Synchronous read — null until the page's geometry has been extracted. */
export function getSnapIndexSync(docId: string, pageIndex: number): SnapIndex | null {
  const docMap = cache.get(docId);
  const hit = docMap?.get(pageIndex);
  if (!hit || !docMap) return hit ?? null;
  // Re-insert so Map iteration order stays least-recently-used first
  docMap.delete(pageIndex);
  docMap.set(pageIndex, hit);
  return hit;
}

/** True while a page's geometry is still being extracted. */
export function isSnapLoading(docId: string, pageIndex: number): boolean {
  return loading.has(key(docId, pageIndex));
}

/** Drop a document's cached geometry (on flatten / close). */
export function clearSnapIndex(docId: string): void {
  cache.delete(docId);
}

/** Lazily extract + index one page's vector geometry. Concurrent calls for the
 *  same page coalesce; the result is cached for the document's lifetime. */
export async function ensureSnapIndex(
  docId: string,
  pdfDoc: PDFDocumentProxy,
  pageIndex: number,
): Promise<SnapIndex | null> {
  const existing = cache.get(docId)?.get(pageIndex);
  if (existing) return existing;
  const lk = key(docId, pageIndex);
  if (loading.has(lk)) return null;
  loading.add(lk);
  try {
    const page = await pdfDoc.getPage(pageIndex + 1);
    // Operator-list coordinates are raw PDF user space. The base CTM maps them
    // the same way the renderer does (viewport transform: crop-box offset +
    // /Rotate), then flips y so the result lands in our y-up page space.
    const vp = page.getViewport({ scale: 1 });
    const vt = vp.transform as number[];
    const base = mul(
      [1, 0, 0, -1, 0, vp.height] as Matrix,
      [vt[0]!, vt[1]!, vt[2]!, vt[3]!, vt[4]!, vt[5]!] as Matrix,
    );
    const opList = await page.getOperatorList();
    const index = buildIndex(collect(opList, base));
    let docMap = cache.get(docId);
    if (!docMap) {
      docMap = new Map();
      cache.set(docId, docMap);
    }
    docMap.delete(pageIndex);
    docMap.set(pageIndex, index);
    while (docMap.size > MAX_CACHED_PAGES) {
      const oldest = docMap.keys().next().value;
      if (oldest === undefined) break;
      docMap.delete(oldest);
    }
    return index;
  } catch {
    return null;
  } finally {
    loading.delete(lk);
  }
}

/* ── Extraction ─────────────────────────────────────────────────────────── */

/** A 2D affine matrix [a, b, c, d, e, f] (PDF convention). */
type Matrix = [number, number, number, number, number, number];

/** m2 applied first, then m1 — matching pdf.js `Util.transform`. */
function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** Growable packed float buffer. */
class FloatBuf {
  data: Float32Array;
  len = 0;
  constructor(initial = 4096) {
    this.data = new Float32Array(initial);
  }
  push2(a: number, b: number): void {
    if (this.len + 2 > this.data.length) this.grow(this.len + 2);
    this.data[this.len++] = a;
    this.data[this.len++] = b;
  }
  push4(a: number, b: number, c: number, d: number): void {
    if (this.len + 4 > this.data.length) this.grow(this.len + 4);
    this.data[this.len++] = a;
    this.data[this.len++] = b;
    this.data[this.len++] = c;
    this.data[this.len++] = d;
  }
  private grow(need: number): void {
    let cap = this.data.length * 2;
    while (cap < need) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.data.subarray(0, this.len));
    this.data = next;
  }
}

interface Collected {
  verts: FloatBuf;
  segs: FloatBuf;
  truncated: boolean;
}

/** Walk the operator list, tracking the CTM, and flatten every path into
 *  vertices + straight segments in page space. */
function collect(
  opList: { fnArray: number[]; argsArray: unknown[] },
  base: Matrix,
): Collected {
  const verts = new FloatBuf(1 << 14);
  const segs = new FloatBuf(1 << 14);
  let truncated = false;

  let ctm: Matrix = base;
  const stack: Matrix[] = [];
  const fns = opList.fnArray;
  const args = opList.argsArray;

  for (let i = 0; i < fns.length; i++) {
    switch (fns[i]) {
      case OP_SAVE:
        stack.push(ctm);
        break;
      case OP_RESTORE:
        ctm = stack.pop() ?? base;
        break;
      case OP_TRANSFORM: {
        const a = args[i] as number[];
        if (a && a.length >= 6) {
          ctm = mul(ctm, [a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!]);
        }
        break;
      }
      case OP_FORM_BEGIN: {
        // save + transform(matrix), mirroring the canvas renderer
        stack.push(ctm);
        const m = (args[i] as unknown[])?.[0] as number[] | undefined;
        if (m && m.length >= 6) ctm = mul(ctm, [m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!]);
        break;
      }
      case OP_FORM_END:
        ctm = stack.pop() ?? base;
        break;
      case OP_CONSTRUCT_PATH: {
        // args = [op, data, minMax]; data[0] is the flat DrawOPS array
        const a = args[i] as unknown[];
        const data = a?.[1] as unknown[] | undefined;
        const raw = data?.[0];
        if (Array.isArray(raw) || ArrayBuffer.isView(raw)) {
          if (emitPath(raw as ArrayLike<number>, ctm, verts, segs)) truncated = true;
        }
        break;
      }
      default:
        break;
    }
    if (verts.len >= MAX_VERTICES * 2 && segs.len >= MAX_SEGMENTS * 4) {
      truncated = true;
      break;
    }
  }

  return { verts, segs, truncated };
}

/** Decode one flat DrawOPS array under `m`. Returns true if a cap was hit. */
function emitPath(
  d: ArrayLike<number>,
  m: Matrix,
  verts: FloatBuf,
  segs: FloatBuf,
): boolean {
  const tx = (x: number, y: number): [number, number] => [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5],
  ];
  const vFull = (): boolean => verts.len >= MAX_VERTICES * 2;
  const sFull = (): boolean => segs.len >= MAX_SEGMENTS * 4;
  let capped = false;

  // Subpath start (for closePath) and current point, both in page space
  let startX = 0;
  let startY = 0;
  let curX = 0;
  let curY = 0;
  let hasCurrent = false;

  const vertex = (x: number, y: number): void => {
    if (vFull()) {
      capped = true;
      return;
    }
    verts.push2(x, y);
  };
  const segment = (x1: number, y1: number, x2: number, y2: number): void => {
    if (sFull()) {
      capped = true;
      return;
    }
    // Skip zero-length segments — they add nothing but index weight
    if (Math.abs(x2 - x1) < 1e-6 && Math.abs(y2 - y1) < 1e-6) return;
    segs.push4(x1, y1, x2, y2);
  };

  for (let i = 0, n = d.length; i < n; ) {
    const op = d[i++]!;
    if (op === D_MOVE_TO) {
      const [x, y] = tx(d[i++]!, d[i++]!);
      startX = curX = x;
      startY = curY = y;
      hasCurrent = true;
      vertex(x, y);
    } else if (op === D_LINE_TO) {
      const [x, y] = tx(d[i++]!, d[i++]!);
      if (hasCurrent) segment(curX, curY, x, y);
      curX = x;
      curY = y;
      hasCurrent = true;
      vertex(x, y);
    } else if (op === D_CURVE_TO) {
      const [c1x, c1y] = tx(d[i++]!, d[i++]!);
      const [c2x, c2y] = tx(d[i++]!, d[i++]!);
      const [ex, ey] = tx(d[i++]!, d[i++]!);
      if (hasCurrent) flattenCubic(curX, curY, c1x, c1y, c2x, c2y, ex, ey, segment);
      curX = ex;
      curY = ey;
      hasCurrent = true;
      // Only the curve's own endpoint is a "vertex"; its interior is edge-only
      vertex(ex, ey);
    } else if (op === D_QUAD_TO) {
      const [qx, qy] = tx(d[i++]!, d[i++]!);
      const [ex, ey] = tx(d[i++]!, d[i++]!);
      if (hasCurrent) {
        // Elevate the quadratic to a cubic and reuse the flattener
        flattenCubic(
          curX,
          curY,
          curX + (2 / 3) * (qx - curX),
          curY + (2 / 3) * (qy - curY),
          ex + (2 / 3) * (qx - ex),
          ey + (2 / 3) * (qy - ey),
          ex,
          ey,
          segment,
        );
      }
      curX = ex;
      curY = ey;
      hasCurrent = true;
      vertex(ex, ey);
    } else if (op === D_CLOSE) {
      if (hasCurrent) segment(curX, curY, startX, startY);
      curX = startX;
      curY = startY;
    } else {
      // Unknown opcode — the rest of this array can't be decoded safely
      break;
    }
  }
  return capped;
}

function flattenCubic(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  emit: (ax: number, ay: number, bx: number, by: number) => void,
): void {
  let px = x0;
  let py = y0;
  for (let s = 1; s <= CURVE_STEPS; s++) {
    const t = s / CURVE_STEPS;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const e = t * t * t;
    const qx = a * x0 + b * x1 + c * x2 + e * x3;
    const qy = a * y0 + b * y1 + c * y2 + e * y3;
    emit(px, py, qx, qy);
    px = qx;
    py = qy;
  }
}

/* ── Indexing ───────────────────────────────────────────────────────────── */

function buildIndex(c: Collected): SnapIndex {
  const vx = c.verts.data.subarray(0, c.verts.len);
  const seg = c.segs.data.subarray(0, c.segs.len);
  const vertexCount = c.verts.len >> 1;
  const segmentCount = c.segs.len >> 2;

  // Extent over everything we collected (paths can sit outside the crop box)
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < vx.length; i += 2) {
    const x = vx[i]!;
    const y = vx[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  for (let i = 0; i < seg.length; i += 2) {
    const x = seg[i]!;
    const y = seg[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) {
    minX = minY = 0;
    maxX = maxY = 1;
  }

  const vGrid = buildVertexGrid(vx, vertexCount, minX, minY, maxX, maxY);
  const sGrid = buildSegmentGrid(seg, segmentCount, minX, minY, maxX, maxY);
  return { vx, vertexCount, seg, segmentCount, vGrid, sGrid, truncated: c.truncated };
}

function gridDims(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  cell: number,
): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.min(4096, Math.ceil((maxX - minX) / cell) + 1)),
    rows: Math.max(1, Math.min(4096, Math.ceil((maxY - minY) / cell) + 1)),
  };
}

/** Origin of each grid, stored alongside so queries map the same way. */
interface Origin {
  ox: number;
  oy: number;
}
const origins = new WeakMap<CellIndex, Origin>();

function buildVertexGrid(
  vx: Float32Array,
  count: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): CellIndex {
  const { cols, rows } = gridDims(minX, minY, maxX, maxY, VERTEX_CELL);
  const counts = new Int32Array(cols * rows + 1);
  const cellOf = (i: number): number => {
    const cx = clampi(Math.floor((vx[i * 2]! - minX) / VERTEX_CELL), 0, cols - 1);
    const cy = clampi(Math.floor((vx[i * 2 + 1]! - minY) / VERTEX_CELL), 0, rows - 1);
    return cy * cols + cx;
  };
  for (let i = 0; i < count; i++) counts[cellOf(i) + 1]!++;
  for (let c = 0; c < cols * rows; c++) counts[c + 1]! += counts[c]!;
  const items = new Int32Array(count);
  const cursor = counts.slice(0, cols * rows);
  for (let i = 0; i < count; i++) {
    const c = cellOf(i);
    items[cursor[c]!++] = i;
  }
  const idx: CellIndex = { cols, rows, cell: VERTEX_CELL, start: counts, items };
  origins.set(idx, { ox: minX, oy: minY });
  return idx;
}

function buildSegmentGrid(
  seg: Float32Array,
  count: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): CellIndex {
  const { cols, rows } = gridDims(minX, minY, maxX, maxY, SEGMENT_CELL);
  const counts = new Int32Array(cols * rows + 1);

  /** Visit every cell a segment's bounding box touches (capped). */
  const forEachCell = (i: number, fn: (c: number) => void): void => {
    const x1 = seg[i * 4]!;
    const y1 = seg[i * 4 + 1]!;
    const x2 = seg[i * 4 + 2]!;
    const y2 = seg[i * 4 + 3]!;
    const cx0 = clampi(Math.floor((Math.min(x1, x2) - minX) / SEGMENT_CELL), 0, cols - 1);
    const cx1 = clampi(Math.floor((Math.max(x1, x2) - minX) / SEGMENT_CELL), 0, cols - 1);
    const cy0 = clampi(Math.floor((Math.min(y1, y2) - minY) / SEGMENT_CELL), 0, rows - 1);
    const cy1 = clampi(Math.floor((Math.max(y1, y2) - minY) / SEGMENT_CELL), 0, rows - 1);
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > MAX_SEGMENT_CELLS) {
      // Very long segment: index its two endpoint cells only
      fn(cy0 * cols + cx0);
      const other = cy1 * cols + cx1;
      if (other !== cy0 * cols + cx0) fn(other);
      return;
    }
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) fn(cy * cols + cx);
    }
  };

  for (let i = 0; i < count; i++) forEachCell(i, (c) => counts[c + 1]!++);
  for (let c = 0; c < cols * rows; c++) counts[c + 1]! += counts[c]!;
  const items = new Int32Array(counts[cols * rows]!);
  const cursor = counts.slice(0, cols * rows);
  for (let i = 0; i < count; i++) {
    forEachCell(i, (c) => {
      items[cursor[c]!++] = i;
    });
  }
  const idx: CellIndex = { cols, rows, cell: SEGMENT_CELL, start: counts, items };
  origins.set(idx, { ox: minX, oy: minY });
  return idx;
}

function clampi(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/* ── Query ──────────────────────────────────────────────────────────────── */

export interface SnapOptions {
  /** Search radius in page units. */
  radius: number;
  /** Include nearest-point-on-edge hits (the lowest-priority tier). */
  edges?: boolean;
}

/** Nearest snap target to `p`, or null when nothing is within `radius`.
 *  Vertices win outright; anything else falls back to the nearest point along
 *  a segment. Segment MIDPOINTS are deliberately not offered — on dense CAD
 *  linework they pull the cursor to places nothing is actually drawn. */
export function findSnap(index: SnapIndex, p: Point, opts: SnapOptions): SnapHit | null {
  const { radius } = opts;
  const r2 = radius * radius;

  // 1. Vertices / corners
  let bestD2 = r2;
  let best: Point | null = null;
  forEachCellInRadius(index.vGrid, p, radius, (c) => {
    const g = index.vGrid;
    for (let k = g.start[c]!; k < g.start[c + 1]!; k++) {
      const i = g.items[k]!;
      const dx = index.vx[i * 2]! - p.x;
      const dy = index.vx[i * 2 + 1]! - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = { x: index.vx[i * 2]!, y: index.vx[i * 2 + 1]! };
      }
    }
  });
  if (best) return { point: best, kind: 'vertex', distance: Math.sqrt(bestD2) };

  if (!opts.edges) return null;

  // 2. Nearest point along a segment
  let edgeD2 = r2;
  let edge: Point | null = null;
  forEachCellInRadius(index.sGrid, p, radius, (c) => {
    const g = index.sGrid;
    for (let k = g.start[c]!; k < g.start[c + 1]!; k++) {
      const i = g.items[k]!;
      const x1 = index.seg[i * 4]!;
      const y1 = index.seg[i * 4 + 1]!;
      const x2 = index.seg[i * 4 + 2]!;
      const y2 = index.seg[i * 4 + 3]!;
      const vx = x2 - x1;
      const vy = y2 - y1;
      const len2 = vx * vx + vy * vy;
      if (len2 < 1e-12) continue;
      let t = ((p.x - x1) * vx + (p.y - y1) * vy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = x1 + vx * t;
      const qy = y1 + vy * t;
      const d2 = (qx - p.x) ** 2 + (qy - p.y) ** 2;
      if (d2 < edgeD2) {
        edgeD2 = d2;
        edge = { x: qx, y: qy };
      }
    }
  });

  if (edge) return { point: edge, kind: 'edge', distance: Math.sqrt(edgeD2) };
  return null;
}

function forEachCellInRadius(
  g: CellIndex,
  p: Point,
  radius: number,
  fn: (cell: number) => void,
): void {
  const o = origins.get(g);
  if (!o) return;
  const cx0 = clampi(Math.floor((p.x - radius - o.ox) / g.cell), 0, g.cols - 1);
  const cx1 = clampi(Math.floor((p.x + radius - o.ox) / g.cell), 0, g.cols - 1);
  const cy0 = clampi(Math.floor((p.y - radius - o.oy) / g.cell), 0, g.rows - 1);
  const cy1 = clampi(Math.floor((p.y + radius - o.oy) / g.cell), 0, g.rows - 1);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) fn(cy * g.cols + cx);
  }
}
