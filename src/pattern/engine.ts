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
};

export type GenerateResult = {
  grid: BeadGrid;
  /** BOM sorted by palette sortOrder: one entry per used code. */
  items: Array<{ code: string; quantity: number }>;
  usedColorCount: number;
  /** Cells blanked by edge-background removal (0 when disabled). */
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
const EDGE_BG_LAB_THRESHOLD = 20;
const EDGE_BG_LAB_THRESHOLD_SQ = EDGE_BG_LAB_THRESHOLD * EDGE_BG_LAB_THRESHOLD;
/** A cell may also join the background flood when it is within this Lab distance of an
 * already-removed neighbor — provided it still stays within EDGE_BG_LAB_HARD of the
 * background color. Lets the flood follow textured/gradient backgrounds without
 * unbounded drift into the subject. */
const EDGE_BG_NEIGHBOR_LAB = 6;
const EDGE_BG_NEIGHBOR_LAB_SQ = EDGE_BG_NEIGHBOR_LAB * EDGE_BG_NEIGHBOR_LAB;
const EDGE_BG_LAB_HARD = 30;
const EDGE_BG_LAB_HARD_SQ = EDGE_BG_LAB_HARD * EDGE_BG_LAB_HARD;

/** Mean alpha byte below which a sampled cell counts as transparent. */
const ALPHA_THRESHOLD = 128;

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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
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
 * 2. Edge background removal (optional): background color = median of all edge
 *    cells; flood-fill from edges where a cell joins if it is close to the
 *    background (Lab < ~18) or close to an already-removed neighbor (Lab < ~8),
 *    so textured/gradient backgrounds still get picked up.
 * 3. Nearest-color matching in CIE Lab space against the scoped palette.
 *    With dither enabled, quantization error diffuses right/down (Floyd-Steinberg).
 * 4. maxColors enforcement: repeatedly merge the pair minimizing
 *    labDistance * (1 + minUsage/totalCells); cells go to the higher-usage color.
 * 5. Isolated-cell cleanup: a cell differing from all present 4-neighbors takes
 *    the most frequent neighbor color; then an optional majority pass lets a cell
 *    adopt a single color shared by >=3 of its 4-neighbors.
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
      if (a / n >= ALPHA_THRESHOLD) {
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

  // Step 2: edge background removal — background color is the median of ALL
  // edge cells (robust when a subject touches a corner), then a flood from the
  // edges. A cell joins when it is close to the background color outright, or
  // close to an already-removed neighbor while still within a hard bound of the
  // background — the second rule follows JPEG noise and gradual gradients that
  // a flat threshold leaves behind as grey beads.
  let removedCells = 0;
  if (options.removeEdgeBackground !== false) {
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
    if (opaqueEdge.length > 0) {
      const bgR = median(opaqueEdge.map((i) => workR[i]!));
      const bgG = median(opaqueEdge.map((i) => workG[i]!));
      const bgB = median(opaqueEdge.map((i) => workB[i]!));
      const [bgL, bgA, bgB2] = rgbToLab(bgR, bgG, bgB);
      const queued = new Uint8Array(cellCount);
      const queue: number[] = [];
      const tryVisit = (i: number, fromI: number) => {
        if (hasColor[i] !== 1 || queued[i] === 1) return;
        const dBg = labDistanceSq(cellLab[i * 3]!, cellLab[i * 3 + 1]!, cellLab[i * 3 + 2]!, bgL, bgA, bgB2);
        let join = dBg < EDGE_BG_LAB_THRESHOLD_SQ;
        if (!join && fromI >= 0 && dBg < EDGE_BG_LAB_HARD_SQ) {
          const dNeighbor = labDistanceSq(
            cellLab[i * 3]!,
            cellLab[i * 3 + 1]!,
            cellLab[i * 3 + 2]!,
            cellLab[fromI * 3]!,
            cellLab[fromI * 3 + 1]!,
            cellLab[fromI * 3 + 2]!,
          );
          join = dNeighbor < EDGE_BG_NEIGHBOR_LAB_SQ;
        }
        if (join) {
          queued[i] = 1;
          queue.push(i);
        }
      };
      for (const i of edgeCells) tryVisit(i, -1);
      while (queue.length > 0) {
        const i = queue.pop()!;
        hasColor[i] = 0;
        removedCells++;
        const cx = i % gridW;
        const cy = (i / gridW) | 0;
        if (cx > 0) tryVisit(i - 1, i);
        if (cx < gridW - 1) tryVisit(i + 1, i);
        if (cy > 0) tryVisit(i - gridW, i);
        if (cy < gridH - 1) tryVisit(i + gridW, i);
      }
    }
  }

  // Step 3: nearest-color matching in Lab space over the scoped palette.
  const paletteLab = getPaletteLab();
  const nearestPalette = (l: number, a: number, b: number): number => {
    let best = allowed[0]!;
    let bestD = Number.POSITIVE_INFINITY;
    for (const p of allowed) {
      const d = labDistanceSq(l, a, b, paletteLab[p * 3]!, paletteLab[p * 3 + 1]!, paletteLab[p * 3 + 2]!);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  };

  if (options.dither === true) {
    // Floyd-Steinberg on the sampled float RGB grid. EMPTY cells neither match
    // nor receive diffused error.
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

  // Step 4: maxColors enforcement — merge the pair minimizing
  // labDistance * (1 + minUsage/totalCells); the smaller-usage color folds
  // into the larger one (ties keep the smaller palette index, deterministically).
  const usage = new Map<number, number>();
  let nonEmpty = 0;
  for (let i = 0; i < cellCount; i++) {
    const v = cells[i]!;
    if (v !== EMPTY_CELL) {
      usage.set(v, (usage.get(v) ?? 0) + 1);
      nonEmpty++;
    }
  }
  while (usage.size > maxColors && usage.size > 1) {
    const keys = [...usage.keys()].sort((a, b) => a - b);
    let mergeA = -1;
    let mergeB = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let x = 0; x < keys.length; x++) {
      for (let y = x + 1; y < keys.length; y++) {
        const a = keys[x]!;
        const b = keys[y]!;
        const score =
          Math.sqrt(paletteLabDistanceSq(paletteLab, a, b)) *
          (1 + Math.min(usage.get(a)!, usage.get(b)!) / nonEmpty);
        if (score < bestScore) {
          bestScore = score;
          mergeA = a;
          mergeB = b;
        }
      }
    }
    if (mergeA < 0) break;
    const countA = usage.get(mergeA)!;
    const countB = usage.get(mergeB)!;
    const winner = countA >= countB ? mergeA : mergeB;
    const loser = winner === mergeA ? mergeB : mergeA;
    for (let i = 0; i < cellCount; i++) {
      if (cells[i] === loser) cells[i] = winner;
    }
    usage.set(winner, countA + countB);
    usage.delete(loser);
  }

  // Step 5: isolated-cell cleanup — a cell differing from every present
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

  // Step 5b: majority smoothing — when >=3 of a cell's 4-neighbors share one
  // single value different from the cell (including EMPTY), the cell adopts it.
  // Kills the residual speckle that isolated-cell cleanup cannot reach (a noise
  // cell that happens to touch one same-colored neighbor survives step 5).
  // Snapshot semantics; single pass keeps thin 1-cell lines intact.
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
        for (const [v, count] of counts) {
          if (v !== own && count >= 3) {
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