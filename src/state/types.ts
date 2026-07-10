import type { PDFDocumentProxy } from 'pdfjs-dist';

export type ToolId =
  | 'flip'
  | 'pan'
  | 'zoom'
  | 'select'
  | 'rectangle'
  | 'ellipse'
  | 'polygon'
  | 'line'
  | 'polyline'
  | 'highlighter'
  | 'text'
  | 'callout'
  | 'calibrate'
  | 'dimension'
  | 'measureAngle'
  | 'snip';

export type ViewMode = 'continuous' | 'single';
export type ArrowHead = 'none' | 'open' | 'filled';
export type LineStyle = 'solid' | 'dashed' | 'dotted' | 'centerline' | 'cloud';
export type SplitMode = 'none' | 'vertical' | 'horizontal';

export interface Point {
  x: number;
  y: number;
}

export interface PageDefaults {
  scaleLabel: string;
  scaleFactor: number | null;
  strokeColor: string;
  fillColor: string | null;
  textColor: string;
  lineWeight: number;
  lineStyle: LineStyle;
  fontSize: number;
  fontFamily: string;
}

export interface AppearanceOverrides {
  strokeColor?: string;
  fillColor?: string | null;
  textColor?: string;
  lineWeight?: number;
  lineStyle?: LineStyle;
  opacity?: number;
  fontSize?: number;
  fontFamily?: string;
  /** Multiple of the font size (1 = single, 2 = double). Text/callout only. */
  lineSpacing?: number;
}

export type MarkupType =
  | 'rectangle'
  | 'ellipse'
  | 'polygon'
  | 'cloud'
  | 'line'
  | 'polyline'
  | 'highlighter'
  | 'inkHighlight'
  | 'text'
  | 'callout'
  | 'sticky'
  | 'dimension'
  | 'measureAngle'
  | 'snipImage';

export interface MarkupBase {
  id: string;
  type: MarkupType;
  pageIndex: number;
  description?: string;
  /** Locked = reversibly "flattened": still drawn in its draw-order slot but
   *  not selectable/editable until unlocked (markups-list padlock or
   *  Markup ▸ Unlock). */
  locked?: boolean;
  overrides?: AppearanceOverrides;
  arrowStart?: ArrowHead;
  arrowEnd?: ArrowHead;
  /** Arrowhead size as a multiple of the line weight (0.25/0.5/1/2). Default 1
   *  for lines/polylines; callouts scale a larger base. */
  arrowSize?: number;
}

export interface RectMarkup extends MarkupBase {
  type: 'rectangle' | 'highlighter';
  x: number;
  y: number;
  width: number;
  height: number;
  /** Rotation in degrees (clockwise on screen) about the shape's center. */
  rotation?: number;
}

export interface EllipseMarkup extends MarkupBase {
  type: 'ellipse';
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** Rotation in degrees (clockwise on screen) about the center. */
  rotation?: number;
}

export interface PolyMarkup extends MarkupBase {
  type: 'polygon' | 'cloud' | 'polyline';
  points: Point[];
  /** Polygon area label: decimal places for the sq-ft value (default 2). */
  decimals?: number;
  /** polyline only: show the total length at the centre when true. */
  showLength?: boolean;
  /** polygon only: show the enclosed area at the centroid when true. */
  showArea?: boolean;
}

/** Free-hand fat highlighter stroke — a translucent yellow path with a round
 *  pen. No text/font properties; just a marker swipe over an area. */
export interface InkMarkup extends MarkupBase {
  type: 'inkHighlight';
  points: Point[];
  /** Pen width in page points. */
  penWidth: number;
}

export interface LineMarkup extends MarkupBase {
  type: 'line' | 'dimension';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Dimension only: perpendicular distance (page units, signed) from the
   *  measured points to the dimension line. 0 = drawn on the points. */
  offset?: number;
  /** Dimension only: end graphic on the dimension line. */
  tickStyle?: 'slash' | 'arrow';
  /** Dimension only: round the displayed value UP to this many real-world
   *  inches (0.25, 1, 6, 12). Undefined = exact. */
  roundTo?: number;
}

export interface TextMarkup extends MarkupBase {
  type: 'text';
  x: number;
  y: number;
  width: number;
  height: number;
  content: string;
}

export interface CalloutMarkup extends MarkupBase {
  type: 'callout';
  textX: number;
  textY: number;
  textWidth: number;
  textHeight: number;
  anchorX: number;
  anchorY: number;
  content: string;
  /** X of the leader elbow. The horizontal run exits the box at mid-height
   *  on the left/right side and bends here toward the anchor. Undefined =
   *  derived automatically on the anchor's side. */
  kinkX?: number;
  /** Y of the leader elbow. When set (3-click callouts), the leader exits the
   *  box edge toward the elbow and bends at (kinkX, kinkY). When undefined the
   *  elbow stays on the box mid-height (legacy single-axis behaviour). */
  kinkY?: number;
}

export interface StickyMarkup extends MarkupBase {
  type: 'sticky';
  x: number;
  y: number;
  content: string;
}

export interface AngleMarkup extends MarkupBase {
  type: 'measureAngle';
  p1: Point;
  vertex: Point;
  p2: Point;
}

export interface SnipMarkup extends MarkupBase {
  type: 'snipImage';
  x: number;
  y: number;
  width: number;
  height: number;
  imageData: string;
}

export type Markup =
  | RectMarkup
  | EllipseMarkup
  | PolyMarkup
  | InkMarkup
  | LineMarkup
  | TextMarkup
  | CalloutMarkup
  | StickyMarkup
  | AngleMarkup
  | SnipMarkup;

export interface PageInfo {
  width: number;
  height: number;
  rotation: number;
}

export interface OverlaySlot {
  pageIndex: number;
  opacity: number;
}

export interface PdfDocumentState {
  id: string;
  filename: string;
  fileHandle: FileSystemFileHandle | null;
  pdfDoc: PDFDocumentProxy | null;
  pdfBytes: Uint8Array | null;
  pageCount: number;
  pages: PageInfo[];
  pageDefaults: PageDefaults[];
  markups: Markup[];
  currentPage: number;
  zoom: number;
  viewMode: ViewMode;
  dirty: boolean;
  flattened: boolean;
  splitMode: SplitMode;
  splitRatio: number;
  overlayEnabled: boolean;
  overlays: [OverlaySlot | null, OverlaySlot | null];
  /** Composite overlay pages onto the base page Photoshop-Multiply style. */
  overlayMultiply: boolean;
  clipboard: Markup[] | null;
}

export interface AppState {
  documents: PdfDocumentState[];
  activeDocId: string | null;
  activeTool: ToolId;
  /** Navigate tool to restore after a markup tool finishes its markup. */
  lastNavTool: 'select' | 'zoom';
  selectedMarkupIds: string[];
  cursorPagePoint: Point | null;
  leftPanelVisible: boolean;
  rightPanelVisible: boolean;
  leftPanelWidth: number;
  rightPanelWidth: number;
  leftPanelTab: 'bookmarks' | 'thumbnails';
  rightPanelTab: 'properties' | 'totals';
  snipBuffer: SnipMarkup | null;
}

export interface BookmarkNode {
  title: string;
  pageIndex: number;
  children: BookmarkNode[];
}

/** Default markup color — dark blue from the standard palette. */
export const DEFAULT_COLOR = '#002060';

export const DEFAULT_PAGE_DEFAULTS: PageDefaults = {
  scaleLabel: 'None',
  scaleFactor: null,
  strokeColor: DEFAULT_COLOR,
  fillColor: null,
  textColor: DEFAULT_COLOR,
  lineWeight: 1,
  lineStyle: 'solid',
  fontSize: 12,
  fontFamily: 'Arial',
};

/** Line weight presets (pt); "Custom…" prompts for any other value. */
export const LINE_WEIGHT_OPTIONS = [0.25, 0.5, 1, 2, 3];

/** Text-size presets (pt) for the dropdown selectors. */
export const TEXT_SIZE_OPTIONS = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];

/** Decimal-place options for the area (sq ft) label. */
export const AREA_DECIMAL_OPTIONS = [0, 1, 2, 3];

/** Arrowhead size options, as a multiple of the line weight. */
export const ARROW_SIZE_OPTIONS: { value: number; label: string }[] = [
  { value: 0.25, label: '25%' },
  { value: 0.5, label: '50%' },
  { value: 1, label: '100%' },
  { value: 2, label: '200%' },
  { value: 4, label: '400%' },
  { value: 8, label: '800%' },
];

/** Fonts offered in the property panel. Arial is always the default. */
export const FONT_FAMILIES = [
  'Arial',
  'Helvetica',
  'Times New Roman',
  'Courier New',
  'Verdana',
  'Georgia',
];

export const LINE_SPACING_OPTIONS = [1, 1.15, 1.35, 1.5, 2];

export const ARCH_SCALES = [
  '3" = 1\'-0"',
  '1 1/2" = 1\'-0"',
  '1" = 1\'-0"',
  '3/4" = 1\'-0"',
  '1/2" = 1\'-0"',
  '3/8" = 1\'-0"',
  '1/4" = 1\'-0"',
  '3/16" = 1\'-0"',
  '1/8" = 1\'-0"',
  '3/32" = 1\'-0"',
  '1/16" = 1\'-0"',
  '1/32" = 1\'-0"',
];

export const ENG_SCALES = [
  '1" = 10\'',
  '1" = 20\'',
  '1" = 30\'',
  '1" = 40\'',
  '1" = 50\'',
  '1" = 60\'',
  '1" = 80\'',
  '1" = 100\'',
  '1" = 200\'',
  '1" = 300\'',
  '1" = 400\'',
  '1" = 500\'',
];

export const PAGE_SIZES: Record<string, { w: number; h: number }> = {
  '8.5 x 11': { w: 612, h: 792 },
  '11 x 17': { w: 792, h: 1224 },
  'ARCH A': { w: 648, h: 864 },
  'ARCH B': { w: 864, h: 1296 },
  'ARCH C': { w: 1296, h: 1728 },
  'ARCH D': { w: 1728, h: 2592 },
  'ARCH E1': { w: 2160, h: 3024 },
  'ARCH E': { w: 2592, h: 3456 },
};

/** Standard color palette (Office standard colors): dark red, red, orange,
 *  yellow, light green, green, light blue, blue, dark blue, purple. */
export const SWATCH_COLORS = [
  '#c00000',
  '#ff0000',
  '#ffc000',
  '#ffff00',
  '#92d050',
  '#00b050',
  '#00b0f0',
  '#0070c0',
  '#002060',
  '#7030a0',
  // Grayscale ramp, white → black
  '#ffffff',
  '#d9d9d9',
  '#bfbfbf',
  '#808080',
  '#595959',
  '#404040',
  '#000000',
];
