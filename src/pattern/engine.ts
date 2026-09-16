import { MARD_291_COLORS } from '../data/mard291';
import type { PatternGrid } from '../types';

/** Cell value meaning "no bead" (transparent source pixel, removed background, user-erased). */
export const EMPTY_CELL = -1;

/**
 * Runtime bead grid. `cells` is row-major; each value is an index into MARD_291_COLORS
 * (0..290) or EMPTY_CELL. Palette scope only affects matching, never the index space,
 * so a grid generated under one scope still renders under another.
 */
export type BeadGrid = {
  width: number;
  height: number;
  cells: Int32Array;
};

export type PaletteScope = 'all' | 'mard221' | 'inventory';

export type ImagePixels = {
  width: number;
  height: number;
  /** RGBA bytes, row-major, 4 bytes per pixel (same layout as ImageData.data). */
  data: Uint8ClampedArray;
};

export type GenerateOptions = {
  /** Grid columns. Height derives from the image aspect ratio (min 1). */
  gridWidth: number;
  /** Cap on distinct bead colors. Beyond it, low-usage colors merge into the nearest survivor. */
  maxColors: number;
  /** Floyd-Steinberg error diffusion during matching. Default false. */
  dither?: boolean;
  /**
   * Region sampling mode per cell. 'dominant' takes the mean of the largest
   * coarse color cluster inside the cell area — crisper edges on line art and
   * logos (black+white border cells come out black or white, not grey).
   * 'average' blends the whole area. Default 'dominant'.
   */
  sampling?: 'dominant' | 'average';
  /** Majority smoothing: a cell whose 4-neighbors share >=3 of one other color adopts it. Default true. */
  smooth?: boolean;
  /** Flood-remove cells connected to the edges that match the corner background color. Default true. */
  removeEdgeBackground?: boolean;
  /** Which MARD subset may be used for matching. Default 'all'. */
  paletteScope?: PaletteScope;
  /** Codes with stock > 0. Required when paletteScope === 'inventory'. */
  inventoryCodes?: ReadonlySet<string>;
  /**
   * Optional foreground mask at image resolution (0-255 per pixel, row-major,
   * same dimensions as ImagePixels). When present, cells whose mean mask
   * coverage stays below the foreground threshold become EMPTY_CELL and the
   * edge-color flood is skipped entirely - the mask is the authoritative
   * subject/background split (e.g. ML person segmentation).
   */
  segmentationMask?: { width: number; height: number; data: Uint8ClampedArray };
};

export type GenerateResult = {
  grid: BeadGrid;
  /** BOM sorted by palette sortOrder: one entry per used code. */
  items: Array<{ code: string; quantity: number }>;
  usedColorCount: number;
  /** Cells blanked by background removal or the segmentation mask (0 when neither ran). */
  removedCells: number;
  /** How many palette colors were eligible under the scope (for low-inventory warnings). */
  paletteSize: number;
};

/** Board-friendly grid widths: 29/52/87/116 columns (1x1, 52-board, 3x3, 4x4 boards). */
export const GRID_WIDTH_PRESETS = [29, 52, 87, 116] as const;

/** One-tap param presets shown as chips in the generator workspace. */
export const VARIANT_PRESETS: ReadonlyArray<{ id: string; labelZh: string; maxColors: number }> = [
  { id: 'compact', labelZh: '简洁 16色', maxColors: 16 },
  { id: 'balanced', labelZh: '均衡 24色', maxColors: 24 },
  { id: 'detailed', labelZh: '细腻 36色', maxColors: 36 },
];

// ---------------------------------------------------------------------------
// Internal color-space helpers (pure math; the engine never touches the DOM).
// ---------------------------------------------------------------------------

const PALETTE_SIZE = MARD_291_COLORS.length;
/** Palette index reserved in the encoded form for EMPTY_CELL. */
const ENCODED_EMPTY = PALETTE_SIZE; // 291
const B64_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';

/** D65 reference white. */
const D65_X = 0.95047;
const D65_Y = 1;
const D65_Z = 1.08883;
const LAB_DELTA = 6 / 29;
const LAB_DELTA_CUBE = LAB_DELTA * LAB_DELTA * LAB_DELTA;
const LAB_LINEAR_DENOM = 3 * LAB_DELTA * LAB_DELTA;

/** Edge cells within this CIE Lab distance of the corner background color are removed. */
const EDGE_BG_LAB_THRESHOLD = 15;
const EDGE_BG_LAB_THRESHOLD_SQ = EDGE_BG_LAB_THRESHOLD * EDGE_BG_LAB_THRESHOLD;
/** Edge cells are clustered into at most this many background color seeds, so a
 * gradient or two-tone backdrop still floods cleanly - while every candidate cell
 * is judged directly against a seed, so the flood can never chain its way through
 * a soft gradient into the subject. */
const EDGE_BG_MAX_CLUSTERS = 3;
/** After flooding, connected components of kept cells smaller than this are debris. */
const EDGE_BG_ISLAND_MIN = 8;
const EDGE_BG_ISLAND_FRACTION = 0.015;
/**
 * Majority smoothing adopts a neighbor color only within this Lab distance when
 * the cell still has same-colored neighbors (a plausible detail). Cells with NO
 * same-colored 8-neighbor are pure speckle and always follow the majority.
 */
const SMOOTH_DETAIL_LAB = 24;
const SMOOTH_DETAIL_LAB_SQ = SMOOTH_DETAIL_LAB * SMOOTH_DETAIL_LAB;
/** Snapped cluster centers closer than this are treated as one bead color. */
const CENTER_DEDUP_LAB = 8;
const CENTER_DEDUP_LAB_SQ = CENTER_DEDUP_LAB * CENTER_DEDUP_LAB;

/** Mean alpha byte below which a sampled cell counts as transparent. */
const ALPHA_THRESHOLD = 128;
const SEG_MASK_FG_MIN = 0.3;

function srgbToLinearChannel(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function labPivot(t: number): number {
  return t > LAB_DELTA_CUBE ? Math.cbrt(t) : t / LAB_LINEAR_DENOM + 4 / 29;
}

/** sRGB 0..255 (input is clamped) -> CIE Lab under D65. */
function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = srgbToLinearChannel(Math.min(255, Math.max(0, r)));
  const gl = srgbToLinearChannel(Math.min(255, Math.max(0, g)));
  const bl = srgbToLinearChannel(Math.min(255, Math.max(0, b)));
  const x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175;
  const z = rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041;
  const fx = labPivot(x / D65_X);
  const fy = labPivot(y / D65_Y);
  const fz = labPivot(z / D65_Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Module-level Lab cache for the whole palette: [L,a,b] triples per color index. */
let paletteLabCache: Float64Array | null = null;

function getPaletteLab(): Float64Array {
  if (paletteLabCache === null) {
    const lab = new Float64Array(PALETTE_SIZE * 3);
    for (let i = 0; i < PALETTE_SIZE; i++) {
      const { r, g, b } = MARD_291_COLORS[i].rgb;
      const [l, a, bb] = rgbToLab(r, g, b);
      lab[i * 3] = l;
      lab[i * 3 + 1] = a;
      lab[i * 3 + 2] = bb;
    }
    paletteLabCache = lab;
  }
  return paletteLabCache;
}

function labDistanceSq(l1: number, a1: number, b1: number, l2: number, a2: number, b2: number): number {
  const dl = l1 - l2;
  const da = a1 - a2;
  const db = b1 - b2;
  return dl * dl + da * da + db * db;
}

function paletteLabDistanceSq(lab: Float64Array, a: number, b: number): number {
  return labDistanceSq(
    lab[a * 3],
    lab[a * 3 + 1],
    lab[a * 3 + 2],
    lab[b * 3],
    lab[b * 3 + 1],
    lab[b * 3 + 2],
  );
}

/** Deterministic PRNG (mulberry32) so k-means seeding is stable across runs. */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * K-means over cell Lab values (k-means++ init, Lloyd iterations, fixed seed).
 * `indices` selects which cells participate. Returns k*3 centroid floats;
 * empty clusters keep their last position and dedupe later at palette snap.
 */
export function clusterCellColors(indices: number[], cellLab: Float64Array, k: number): Float64Array {
  const rand = mulberry32(0x9e3779b9);
  const centers = new Float64Array(k * 3);
  const first = indices[Math.floor(rand() * indices.length)]!;
  centers[0] = cellLab[first * 3]!;
  centers[1] = cellLab[first * 3 + 1]!;
  centers[2] = cellLab[first * 3 + 2]!;
  const distToNearest = new Float64Array(indices.length).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let pi = 0; pi < indices.length; pi++) {
      const i = indices[pi]!;
      const d = labDistanceSq(
        cellLab[i * 3]!, cellLab[i * 3 + 1]!, cellLab[i * 3 + 2]!,
        centers[(c - 1) * 3]!, centers[(c - 1) * 3 + 1]!, centers[(c - 1) * 3 + 2]!,
      );
      if (d < distToNearest[pi]!) distToNearest[pi] = d;
      total += distToNearest[pi]!;
    }
    let pick = indices[0]!;
    if (total > 0) {
      let r = rand() * total;
      for (let pi = 0; pi < indices.length; pi++) {
        r -= distToNearest[pi]!;
        if (r <= 0) {
          pick = indices[pi]!;
          break;
        }
      }
    }
    centers[c * 3] = cellLab[pick * 3]!;
    centers[c * 3 + 1] = cellLab[pick * 3 + 1]!;
    centers[c * 3 + 2] = cellLab[pick * 3 + 2]!;
  }
  const assign = new Int32Array(indices.length).fill(-1);
  const cnt = new Uint32Array(k);
  for (let iter = 0; iter < 15; iter++) {
    let moved = 0;
    const sumL = new Float64Array(k);
    const sumA = new Float64Array(k);
    const sumB = new Float64Array(k);
    cnt.fill(0);
    for (let pi = 0; pi < indices.length; pi++) {
      const i = indices[pi]!;
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = labDistanceSq(
          cellLab[i * 3]!, cellLab[i * 3 + 1]!, cellLab[i * 3 + 2]!,
          centers[c * 3]!, centers[c * 3 + 1]!, centers[c * 3 + 2]!,
        );
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      if (assign[pi] !== best) {
        assign[pi] = best;
        moved++;
      }
      sumL[best] += cellLab[i * 3]!;
      sumA[best] += cellLab[i * 3 + 1]!;
      sumB[best] += cellLab[i * 3 + 2]!;
      cnt[best]++;
    }
    for (let c = 0; c < k; c++) {
      if (cnt[c]! > 0) {
        centers[c * 3] = sumL[c]! / cnt[c]!;
        centers[c * 3 + 1] = sumA[c]! / cnt[c]!;
        centers[c * 3 + 2] = sumB[c]! / cnt[c]!;
      }
    }
    if (moved === 0) break;
  }
  return centers;
}

/**
 * Palette indices usable under a scope/**
 * Palette indices usable under a scope, in MARD_291_COLORS order.
 * 'all' -> every color; 'mard221' -> inMard221 colors; 'inventory' -> codes present in inventoryCodes.
 */
export function usablePaletteIndices(scope: PaletteScope = 'all', inventoryCodes?: ReadonlySet<string>): number[] {
  const indices: number[] = [];
  for (let i = 0; i < PALETTE_SIZE; i++) {
    if (scope === 'all') {
      indices.push(i);
    } else if (scope === 'mard221') {
      if (MARD_291_COLORS[i].inMard221) indices.push(i);
    } else if (inventoryCodes !== undefined && inventoryCodes.has(MARD_291_COLORS[i].code)) {
      indices.push(i);
    }
  }
  return indices;
}

/**
 * Convert an image to a bead grid.
 *
 * Pipeline (deterministic — same input and options give the same grid):
 * 1. Region sampling: each cell takes the dominant cluster color (default) or the
 *    mean RGB of its source rectangle (never single-pixel sampling).
 *    Alpha < 0.5 cells become EMPTY_CELL.
 * 2. Edge background removal (optional): edge cells are clustered into up to 3
 *    background color seeds; every cell joining the flood must sit within
 *    Lab ~15 of a seed directly (no neighbor chaining, so soft gradients cannot
 *    tunnel the flood into the subject). Small disconnected debris islands are
 *    dropped afterwards.
 * 3. Palette selection: k-means over the sampled cell colors picks the image's
 *    own dominant tones (k = maxColors), then snaps centroids to the scoped
 *    bead palette - the bead colors used are chosen by the image content, not
 *    by per-cell nearest matching. With dither enabled, quantization error
 *    diffuses right/down (Floyd-Steinberg) within the selected palette.
 * 4. Isolated-cell cleanup: a cell differing from all present 4-neighbors takes
 *    the most frequent neighbor color; then an optional majority pass erases
 *    speckle (no same-colored 8-neighbor) and near-color noise while preserving
 *    high-contrast details that span 2+ cells.
 */
export function generateBeadGrid(image: ImagePixels, options: GenerateOptions): GenerateResult {
  const { width: imgW, height: imgH, data } = image;
  if (!Number.isInteger(imgW) || !Number.isInteger(imgH) || imgW < 1 || imgH < 1) {
    throw new Error('invalid image dimensions');
  }
  if (data.length < imgW * imgH * 4) {
    throw new Error('image pixel data shorter than width*height*4');
  }
  const rawGridW = Math.round(options.gridWidth);
  const gridW = Number.isFinite(rawGridW) && rawGridW >= 1 ? rawGridW : 1;
  const gridH = Math.max(1, Math.round((gridW * imgH) / imgW));
  const cellCount = gridW * gridH;

  const scope = options.paletteScope ?? 'all';
  const allowed = usablePaletteIndices(scope, options.inventoryCodes);
  if (allowed.length === 0) {
    throw new Error('当前色板范围内没有可用色号');
  }
  const maxColors = Math.max(1, Math.floor(options.maxColors));

  // Step 1: region sampling into a float RGB grid. Cells whose mean alpha
  // stays below 0.5 are EMPTY_CELL and never reach matching or counting.
  // 'average' blends the whole rectangle; 'dominant' bins pixels into 512 coarse
  // buckets (top 3 bits per channel) and takes the mean of the largest bucket, so
  // a cell straddling a black outline and a white fill snaps to one side instead
  // of averaging into mud grey.
  const sampling = options.sampling ?? 'dominant';
  const mask = options.segmentationMask;
  const maskData =
    mask && mask.width === imgW && mask.height === imgH && mask.data.length >= imgW * imgH ? mask.data : undefined;
  let maskedOut = 0;
  const cells = new Int32Array(cellCount).fill(EMPTY_CELL);
  const hasColor = new Uint8Array(cellCount); // 1 = sampled opaque cell
  const workR = new Float64Array(cellCount);
  const workG = new Float64Array(cellCount);
  const workB = new Float64Array(cellCount);
  const binCount = new Uint32Array(512);
  const binSumR = new Float64Array(512);
  const binSumG = new Float64Array(512);
  const binSumB = new Float64Array(512);
  const touched: number[] = [];
  for (let cy = 0; cy < gridH; cy++) {
    const sy0 = Math.floor((cy * imgH) / gridH);
    const sy1 = Math.min(imgH, Math.max(sy0 + 1, Math.ceil(((cy + 1) * imgH) / gridH)));
    for (let cx = 0; cx < gridW; cx++) {
      const sx0 = Math.floor((cx * imgW) / gridW);
      const sx1 = Math.min(imgW, Math.max(sx0 + 1, Math.ceil(((cx + 1) * imgW) / gridW)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      let m = 0;
      touched.length = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let offset = (sy * imgW + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++) {
          const pr = data[offset] ?? 0;
          const pg = data[offset + 1] ?? 0;
          const pb = data[offset + 2] ?? 0;
          r += pr;
          g += pg;
          b += pb;
          a += data[offset + 3] ?? 0;
          n++;
          m += maskData ? maskData[offset >> 2] ?? 0 : 255;
          const bin = ((pr >> 5) << 6) | ((pg >> 5) << 3) | (pb >> 5);
          if (binCount[bin] === 0) touched.push(bin);
          binCount[bin]!++;
          binSumR[bin] = binSumR[bin]! + pr;
          binSumG[bin] = binSumG[bin]! + pg;
          binSumB[bin] = binSumB[bin]! + pb;
          offset += 4;
        }
      }
      const i = cy * gridW + cx;
      const opaque = a / n >= ALPHA_THRESHOLD;
      if (opaque && (!maskData || m / n / 255 >= SEG_MASK_FG_MIN)) {
        hasColor[i] = 1;
        if (sampling === 'dominant' && touched.length > 1) {
          let bestBin = touched[0]!;
          for (const bin of touched) {
            if (binCount[bin]! > binCount[bestBin]!) bestBin = bin;
          }
          workR[i] = binSumR[bestBin]! / binCount[bestBin]!;
          workG[i] = binSumG[bestBin]! / binCount[bestBin]!;
          workB[i] = binSumB[bestBin]! / binCount[bestBin]!;
        } else {
          workR[i] = r / n;
          workG[i] = g / n;
          workB[i] = b / n;
        }
      }
      else if (opaque && maskData) {
        maskedOut++;
      }
      for (const bin of touched) {
        binCount[bin] = 0;
        binSumR[bin] = 0;
        binSumG[bin] = 0;
        binSumB[bin] = 0;
      }
    }
  }

  // Lab triple per sampled cell (used for background removal and non-dither matching).
  const cellLab = new Float64Array(cellCount * 3);
  for (let i = 0; i < cellCount; i++) {
    if (hasColor[i] !== 1) continue;
    const [l, a, b] = rgbToLab(workR[i]!, workG[i]!, workB[i]!);
    cellLab[i * 3] = l;
    cellLab[i * 3 + 1] = a;
    cellLab[i * 3 + 2] = b;
  }

  // Step 2: edge background removal - non-empty edge cells are clustered into
  // up to EDGE_BG_MAX_CLUSTERS background seeds; a cell joins the flood only by
  // sitting within the Lab threshold of a seed directly. The flood therefore
  // covers gradients and multi-tone backdrops but can never chain its way into
  // the subject through a soft transition.
  let removedCells = maskedOut;
  if (maskData || options.removeEdgeBackground !== false) {
    const edgeCells: number[] = [];
    for (let cx = 0; cx < gridW; cx++) {
      edgeCells.push(cx);
      edgeCells.push((gridH - 1) * gridW + cx);
    }
    for (let cy = 0; cy < gridH; cy++) {
      edgeCells.push(cy * gridW);
      edgeCells.push(cy * gridW + gridW - 1);
    }
    const opaqueEdge = edgeCells.filter((i) => hasColor[i] === 1);
    if (maskData || opaqueEdge.length > 0) {
      if (!maskData) {
        const seedK = Math.min(EDGE_BG_MAX_CLUSTERS, opaqueEdge.length);
        const allSeeds = clusterCellColors(opaqueEdge, cellLab, seedK);
        // Background seeds are qualified by per-edge support below.
        // Per-edge support: a seed only counts as background when it covers >=15%
        // of the opaque cells on at least two distinct borders. A cluster confined
        // to one border is far more likely an edge-touching subject (a laptop base
        // on the bottom edge, hair along the top) than a backdrop, so it never
        // seeds the flood - leftover background can still be tap-erased, but eaten
        // subject cannot be recovered.
        const edgeLens = [0, 0, 0, 0]; // opaque cells per border: T B L R
        const seedEdgeCount = new Uint32Array(seedK * 4);
        for (const i of opaqueEdge) {
          const edges: number[] = [];
          if (i < gridW) edges.push(0);
          if (i >= (gridH - 1) * gridW) edges.push(1);
          if (i % gridW === 0) edges.push(2);
          if (i % gridW === gridW - 1) edges.push(3);
          for (const e of edges) edgeLens[e]++;
          let best = 0;
          let bd = Infinity;
          for (let s = 0; s < seedK; s++) {
            const d = labDistanceSq(
              cellLab[i * 3]!, cellLab[i * 3 + 1]!, cellLab[i * 3 + 2]!,
              allSeeds[s * 3]!, allSeeds[s * 3 + 1]!, allSeeds[s * 3 + 2]!,
            );
            if (d < bd) {
              bd = d;
              best = s;
            }
          }
          for (const e of edges) seedEdgeCount[best * 4 + e]++;
        }
        const qualified = [...Array(seedK).keys()].filter(
          (s) => [0, 1, 2, 3].filter((e) => seedEdgeCount[s * 4 + e]! >= edgeLens[e]! * 0.15).length >= 2,
        );
        const seeds = new Float64Array(qualified.length * 3);
        qualified.forEach((s, qi) => {
          seeds[qi * 3] = allSeeds[s * 3]!;
          seeds[qi * 3 + 1] = allSeeds[s * 3 + 1]!;
          seeds[qi * 3 + 2] = allSeeds[s * 3 + 2]!;
        });
        const seedCount = qualified.length;
        const queued = new Uint8Array(cellCount);
        const queue: number[] = [];
        const nearSeed = (i: number): boolean => {
          for (let s = 0; s < seedCount; s++) {
            const d2 = labDistanceSq(
              cellLab[i * 3]!, cellLab[i * 3 + 1]!, cellLab[i * 3 + 2]!,
              seeds[s * 3]!, seeds[s * 3 + 1]!, seeds[s * 3 + 2]!,
            );
            if (d2 < EDGE_BG_LAB_THRESHOLD_SQ) return true;
          }
          return false;
        };
        const tryVisit = (i: number) => {
          if (hasColor[i] !== 1 || queued[i] === 1) return;
          if (nearSeed(i)) {
            queued[i] = 1;
            queue.push(i);
          }
        };
        if (seedCount > 0) {
        for (const i of edgeCells) tryVisit(i);
        while (queue.length > 0) {
          const i = queue.pop()!;
          hasColor[i] = 0;
          removedCells++;
          const cx = i % gridW;
          const cy = (i / gridW) | 0;
          if (cx > 0) tryVisit(i - 1);
          if (cx < gridW - 1) tryVisit(i + 1);
          if (cy > 0) tryVisit(i - gridW);
          if (cy < gridH - 1) tryVisit(i + gridW);
        }
        }
      }

      // Drop debris: (a) tiny disconnected islands of kept cells - leftovers
      // that survived the flood; (b) edge-touching remnants much smaller than
      // the main subject - background shreds whose color never matched a seed
      // but stayed attached to the border. Interior components and any
      // component comparable to the largest one always survive.
      let kept = 0;
      for (let i = 0; i < cellCount; i++) if (hasColor[i] === 1) kept++;
      const islandLimit = Math.max(EDGE_BG_ISLAND_MIN, Math.floor(kept * EDGE_BG_ISLAND_FRACTION));
      const seen = new Uint8Array(cellCount);
      const comps: Array<{ cells: number[]; touchesEdge: boolean }> = [];
      for (let start = 0; start < cellCount; start++) {
        if (hasColor[start] !== 1 || seen[start] === 1) continue;
        const cells2: number[] = [];
        let touchesEdge = false;
        const stack = [start];
        seen[start] = 1;
        while (stack.length > 0) {
          const i = stack.pop()!;
          cells2.push(i);
          const cx = i % gridW;
          const cy = (i / gridW) | 0;
          if (cx === 0 || cy === 0 || cx === gridW - 1 || cy === gridH - 1) touchesEdge = true;
          const nb = (j: number) => {
            if (hasColor[j] === 1 && seen[j] !== 1) {
              seen[j] = 1;
              stack.push(j);
            }
          };
          if (cx > 0) nb(i - 1);
          if (cx < gridW - 1) nb(i + 1);
          if (cy > 0) nb(i - gridW);
          if (cy < gridH - 1) nb(i + gridW);
        }
        comps.push({ cells: cells2, touchesEdge });
      }
      let largest = 0;
      for (const c of comps) if (c.cells.length > largest) largest = c.cells.length;
      const remnantLimit = Math.max(islandLimit, Math.floor(largest * 0.25));
      for (const c of comps) {
        const drop = c.cells.length < islandLimit || (c.touchesEdge && c.cells.length < remnantLimit && c.cells.length < largest);
        if (!drop) continue;
        for (const i of c.cells) {
          hasColor[i] = 0;
          removedCells++;
        }
      }
    }
  }

  // Step 3: choose this image's bead palette - k-means over the kept cell colors
  // (k = min(maxColors, keptCells, paletteSize)) finds the image's own dominant
  // tones, then each centroid snaps to its nearest allowed bead color. The color
  // budget goes where the image needs it (several skin tones for a face, pure
  // outline colors for line art) instead of merging whatever per-cell nearest
  // matching happened to produce.
  const paletteLab = getPaletteLab();
  const nearestIn = (set: ReadonlyArray<number>, l: number, a: number, b: number): number => {
    let best = set[0]!;
    let bestD = Number.POSITIVE_INFINITY;
    for (const p of set) {
      const d = labDistanceSq(l, a, b, paletteLab[p * 3]!, paletteLab[p * 3 + 1]!, paletteLab[p * 3 + 2]!);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  };
  const keptIdx: number[] = [];
  for (let i = 0; i < cellCount; i++) {
    if (hasColor[i] === 1) keptIdx.push(i);
  }
  let selected: number[];
  if (allowed.length <= maxColors || keptIdx.length <= maxColors) {
    selected = allowed;
  } else {
    const k = Math.min(maxColors, keptIdx.length);
    const centers = clusterCellColors(keptIdx, cellLab, k);
    // Snap centroids to bead colors, biggest cluster first; near-duplicate snaps
    // (Lab < CENTER_DEDUP_LAB) collapse so similar shades don't waste slots.
    const clusterSize = new Uint32Array(k);
    for (const i of keptIdx) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = labDistanceSq(
          cellLab[i * 3]!, cellLab[i * 3 + 1]!, cellLab[i * 3 + 2]!,
          centers[c * 3]!, centers[c * 3 + 1]!, centers[c * 3 + 2]!,
        );
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      clusterSize[best]++;
    }
    const order = [...Array(k).keys()].sort((a, b) => clusterSize[b]! - clusterSize[a]!);
    const sel: number[] = [];
    for (const c of order) {
      const pIdx = nearestIn(allowed, centers[c * 3]!, centers[c * 3 + 1]!, centers[c * 3 + 2]!);
      let dup = false;
      for (const q of sel) {
        if (q === pIdx || paletteLabDistanceSq(paletteLab, pIdx, q) < CENTER_DEDUP_LAB_SQ) {
          dup = true;
          break;
        }
      }
      if (!dup) sel.push(pIdx);
    }
    selected = sel.length > 0 ? sel : allowed;
  }

  // Step 4: assign every kept cell to its nearest selected bead color.
  const nearestPalette = (l: number, a: number, b: number): number => nearestIn(selected, l, a, b);

  if (options.dither === true) {
    // Floyd-Steinberg on the sampled float RGB grid, within the selected palette.
    // EMPTY cells neither match nor receive diffused error.
    for (let cy = 0; cy < gridH; cy++) {
      for (let cx = 0; cx < gridW; cx++) {
        const i = cy * gridW + cx;
        if (hasColor[i] !== 1) continue;
        const [l, a, b] = rgbToLab(workR[i]!, workG[i]!, workB[i]!);
        const p = nearestPalette(l, a, b);
        cells[i] = p;
        const errR = workR[i]! - MARD_291_COLORS[p].rgb.r;
        const errG = workG[i]! - MARD_291_COLORS[p].rgb.g;
        const errB = workB[i]! - MARD_291_COLORS[p].rgb.b;
        const spread = (target: number, fraction: number) => {
          if (hasColor[target] === 1) {
            workR[target] = workR[target]! + errR * fraction;
            workG[target] = workG[target]! + errG * fraction;
            workB[target] = workB[target]! + errB * fraction;
          }
        };
        if (cx < gridW - 1) spread(i + 1, 7 / 16);
        if (cy < gridH - 1) {
          if (cx > 0) spread(i + gridW - 1, 3 / 16);
          spread(i + gridW, 5 / 16);
          if (cx < gridW - 1) spread(i + gridW + 1, 1 / 16);
        }
      }
    }
  } else {
    for (let i = 0; i < cellCount; i++) {
      if (hasColor[i] !== 1) continue;
      cells[i] = nearestPalette(cellLab[i * 3]!, cellLab[i * 3 + 1]!, cellLab[i * 3 + 2]!);
    }
  }

  // Step 5: isolated-cell cleanup  // Step 5: isolated-cell cleanup — a cell differing from every present
  // 4-neighbor takes the most frequent neighbor color (snapshot semantics).
  const cleaned = Int32Array.from(cells);
  for (let cy = 0; cy < gridH; cy++) {
    for (let cx = 0; cx < gridW; cx++) {
      const i = cy * gridW + cx;
      const own = cells[i]!;
      if (own === EMPTY_CELL) continue;
      const neighborCounts = new Map<number, number>();
      const addNeighbor = (j: number) => {
        const v = cells[j]!;
        if (v !== EMPTY_CELL) neighborCounts.set(v, (neighborCounts.get(v) ?? 0) + 1);
      };
      if (cx > 0) addNeighbor(i - 1);
      if (cx < gridW - 1) addNeighbor(i + 1);
      if (cy > 0) addNeighbor(i - gridW);
      if (cy < gridH - 1) addNeighbor(i + gridW);
      if (neighborCounts.size === 0 || neighborCounts.has(own)) continue;
      let bestIdx = -1;
      let bestN = 0;
      for (const [idx, count] of neighborCounts) {
        if (count > bestN || (count === bestN && (bestIdx < 0 || idx < bestIdx))) {
          bestN = count;
          bestIdx = idx;
        }
      }
      cleaned[i] = bestIdx;
    }
  }

  // Step 5b: majority smoothing - a cell adopts a single value shared by >=3 of
  // its 4-neighbors, with two rules:
  //   - cells with NO same-valued 8-neighbor are pure speckle -> always adopt
  //     (this also fills 1-cell holes and erases floating lone beads);
  //   - cells still attached to a same-colored structure are plausible details
  //     (eyes, mouth) -> only adopt when the winning neighbor color is close in
  //     Lab space, so high-contrast details survive.
  if (options.smooth !== false) {
    const smoothed = Int32Array.from(cleaned);
    for (let cy = 0; cy < gridH; cy++) {
      for (let cx = 0; cx < gridW; cx++) {
        const i = cy * gridW + cx;
        const own = cleaned[i]!;
        const counts = new Map<number, number>();
        const tally = (v: number) => counts.set(v, (counts.get(v) ?? 0) + 1);
        if (cx > 0) tally(cleaned[i - 1]!);
        if (cx < gridW - 1) tally(cleaned[i + 1]!);
        if (cy > 0) tally(cleaned[i - gridW]!);
        if (cy < gridH - 1) tally(cleaned[i + gridW]!);
        let sameColor8 = false;
        for (let dy = -1; dy <= 1 && !sameColor8; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const ny = cy + dy;
            const nx = cx + dx;
            if (ny < 0 || ny >= gridH || nx < 0 || nx >= gridW) continue;
            if (cleaned[ny * gridW + nx] === own) {
              sameColor8 = true;
              break;
            }
          }
        }
        for (const [v, count] of counts) {
          if (v === own || count < 3) continue;
          let adopt = !sameColor8;
          if (!adopt && v !== EMPTY_CELL && own !== EMPTY_CELL) {
            adopt = paletteLabDistanceSq(paletteLab, own, v) < SMOOTH_DETAIL_LAB_SQ;
          }
          if (adopt) {
            smoothed[i] = v;
            break;
          }
        }
      }
    }
    cleaned.set(smoothed);
  }

  const grid: BeadGrid = { width: gridW, height: gridH, cells: cleaned };
  const items = gridToItems(grid);
  return {
    grid,
    items,
    usedColorCount: items.length,
    removedCells,
    paletteSize: allowed.length,
  };
}

/** Count beads per code. Sorted by palette sortOrder. */
export function gridToItems(grid: BeadGrid): Array<{ code: string; quantity: number }> {
  const counts = new Map<number, number>();
  for (const cell of grid.cells) {
    if (cell < 0 || cell >= PALETTE_SIZE) continue; // EMPTY_CELL or unexpected value
    counts.set(cell, (counts.get(cell) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => MARD_291_COLORS[a[0]].sortOrder - MARD_291_COLORS[b[0]].sortOrder)
    .map(([index, quantity]) => ({ code: MARD_291_COLORS[index].code, quantity }));
}

/** Return a new grid with every cell of `paletteIndex` set to EMPTY_CELL (tap-to-remove color). */
export function removeColorCells(grid: BeadGrid, paletteIndex: number): BeadGrid {
  const cells = new Int32Array(grid.cells.length);
  for (let i = 0; i < cells.length; i++) {
    const v = grid.cells[i]!;
    cells[i] = v === paletteIndex ? EMPTY_CELL : v;
  }
  return { width: grid.width, height: grid.height, cells };
}

/**
 * Pack a grid for storage: `cells` becomes a string of 2 chars per cell —
 * each pair is the base-64 index (digits 0-9A-Za-z-_) of the palette index (0..291),
 * where 291 encodes EMPTY_CELL.
 */
export function encodeGrid(grid: BeadGrid): PatternGrid {
  const chars = new Array<string>(grid.cells.length * 2);
  for (let i = 0; i < grid.cells.length; i++) {
    const raw = grid.cells[i]!;
    const value = raw === EMPTY_CELL ? ENCODED_EMPTY : raw;
    if (!Number.isInteger(value) || value < 0 || value > ENCODED_EMPTY) {
      throw new Error(`grid contains illegal cell value: ${raw}`);
    }
    chars[i * 2] = B64_ALPHABET.charAt(value >> 6);
    chars[i * 2 + 1] = B64_ALPHABET.charAt(value & 63);
  }
  return { width: grid.width, height: grid.height, cells: chars.join('') };
}

/** Inverse of encodeGrid. Throws on malformed input. */
export function decodeGrid(stored: PatternGrid): BeadGrid {
  const { width, height, cells } = stored;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('stored grid has illegal dimensions');
  }
  if (typeof cells !== 'string' || cells.length !== width * height * 2) {
    throw new Error('stored grid data has illegal length');
  }
  const out = new Int32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const hi = B64_ALPHABET.indexOf(cells.charAt(i * 2));
    const lo = B64_ALPHABET.indexOf(cells.charAt(i * 2 + 1));
    if (hi < 0 || lo < 0) {
      throw new Error('stored grid data contains illegal characters');
    }
    const value = hi * 64 + lo;
    if (value > ENCODED_EMPTY) {
      throw new Error('stored grid data contains out-of-range palette index');
    }
    out[i] = value === ENCODED_EMPTY ? EMPTY_CELL : value;
  }
  return { width, height, cells: out };
}