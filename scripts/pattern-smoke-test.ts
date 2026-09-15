import { MARD_291_COLORS } from '../src/data/mard291';
import {
  EMPTY_CELL,
  decodeGrid,
  encodeGrid,
  generateBeadGrid,
  gridToItems,
  removeColorCells,
  usablePaletteIndices,
} from '../src/pattern/engine';
import type { BeadGrid, ImagePixels } from '../src/pattern/engine';

declare const process: { exit(code: number): void };

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function expectThrow(fn: () => void, note: string) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`expected throw: ${note}`);
}

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function indexOf(code: string): number {
  const i = MARD_291_COLORS.findIndex((c) => c.code === code);
  if (i < 0) throw new Error(`test palette missing code ${code}`);
  return i;
}

function makeImage(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): ImagePixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
  }
  return { width, height, data };
}

function solidImage(width: number, height: number, hex: string, alpha = 255): ImagePixels {
  const [r, g, b] = hexRgb(hex);
  return makeImage(width, height, () => [r, g, b, alpha]);
}

function distinctIndices(grid: BeadGrid): Set<number> {
  const set = new Set<number>();
  for (const cell of grid.cells) {
    if (cell !== EMPTY_CELL) set.add(cell);
  }
  return set;
}

function nonEmptyCount(grid: BeadGrid): number {
  let n = 0;
  for (const cell of grid.cells) {
    if (cell !== EMPTY_CELL) n++;
  }
  return n;
}

// Exact palette colors keep every assertion deterministic.
const RED = { code: 'F5', hex: '#E7002F' };
const BLUE = { code: 'C8', hex: '#0F54C0' };
const GREEN = { code: 'B2', hex: '#63F347' };
const YELLOW = { code: 'Q3', hex: '#FFFF00' };
const WHITE = { code: 'T1', hex: '#FFFFFF' };

check('usablePaletteIndices scopes', () => {
  const all = usablePaletteIndices('all');
  assert(all.length === 291 && all[0] === 0 && all[290] === 290, 'all scope should list every palette index');
  const mard221 = usablePaletteIndices('mard221');
  const expected = MARD_291_COLORS.filter((c) => c.inMard221).length;
  assert(mard221.length === expected, 'mard221 scope count should match inMard221 colors');
  assert(mard221.every((i) => MARD_291_COLORS[i].inMard221), 'mard221 scope should only contain inMard221 colors');
  const inv = usablePaletteIndices('inventory', new Set([RED.code, BLUE.code]));
  assert(
    inv.length === 2 && inv[0] === indexOf(BLUE.code) && inv[1] === indexOf(RED.code),
    'inventory scope should list stocked codes in palette order',
  );
  assert(usablePaletteIndices('inventory', new Set()).length === 0, 'empty inventory should yield no usable colors');
  assert(usablePaletteIndices('inventory').length === 0, 'missing inventory set should yield no usable colors');
});

check('solid color maps to the matching MARD color', () => {
  const res = generateBeadGrid(solidImage(8, 8, BLUE.hex), {
    gridWidth: 8,
    maxColors: 16,
    removeEdgeBackground: false,
  });
  assert(res.grid.width === 8 && res.grid.height === 8, 'square image should produce a square grid');
  const want = indexOf(BLUE.code);
  for (const cell of res.grid.cells) {
    assert(cell === want, `every cell should match ${BLUE.code}`);
  }
  assert(res.usedColorCount === 1, 'solid image should use exactly one color');
  assert(res.items.length === 1 && res.items[0].code === BLUE.code && res.items[0].quantity === 64, 'items should count 64 beads');
  assert(res.paletteSize === 291, 'all scope should expose the full palette');
  assert(res.removedCells === 0, 'disabled background removal should report 0 removed cells');

  const wide = generateBeadGrid(solidImage(16, 8, BLUE.hex), {
    gridWidth: 4,
    maxColors: 8,
    removeEdgeBackground: false,
  });
  assert(wide.grid.height === 2, 'grid height should follow the image aspect ratio');
});

check('left red / right blue stays split', () => {
  const [rr, rg, rb] = hexRgb(RED.hex);
  const [br, bg, bb] = hexRgb(BLUE.hex);
  const img = makeImage(8, 8, (x) => (x < 4 ? [rr, rg, rb, 255] : [br, bg, bb, 255]));
  const res = generateBeadGrid(img, { gridWidth: 8, maxColors: 16, removeEdgeBackground: false });
  const redIdx = indexOf(RED.code);
  const blueIdx = indexOf(BLUE.code);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      assert(res.grid.cells[y * 8 + x] === (x < 4 ? redIdx : blueIdx), `cell (${x},${y}) should match its half`);
    }
  }
  assert(res.usedColorCount === 2, 'two-tone image should use two colors');
});

check('transparent center becomes EMPTY cells', () => {
  const [br, bg, bb] = hexRgb(BLUE.hex);
  const img = makeImage(9, 9, (x, y) => (x >= 3 && x <= 5 && y >= 3 && y <= 5 ? [0, 0, 0, 0] : [br, bg, bb, 255]));
  const res = generateBeadGrid(img, { gridWidth: 9, maxColors: 16, removeEdgeBackground: false });
  const blueIdx = indexOf(BLUE.code);
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const cell = res.grid.cells[y * 9 + x];
      if (x >= 3 && x <= 5 && y >= 3 && y <= 5) {
        assert(cell === EMPTY_CELL, `transparent cell (${x},${y}) should be EMPTY`);
      } else {
        assert(cell === blueIdx, `opaque cell (${x},${y}) should be ${BLUE.code}`);
      }
    }
  }
  assert(nonEmptyCount(res.grid) === 72, 'only the 3x3 hole should be empty');
});

check('edge background removal blanks the border', () => {
  const [wr, wg, wb] = hexRgb(WHITE.hex);
  const [br, bg, bb] = hexRgb(BLUE.hex);
  const img = makeImage(9, 9, (x, y) => (x === 0 || y === 0 || x === 8 || y === 8 ? [wr, wg, wb, 255] : [br, bg, bb, 255]));
  const res = generateBeadGrid(img, { gridWidth: 9, maxColors: 16 });
  assert(res.removedCells === 32, 'the white border ring should be removed');
  const blueIdx = indexOf(BLUE.code);
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const cell = res.grid.cells[y * 9 + x];
      if (x === 0 || y === 0 || x === 8 || y === 8) {
        assert(cell === EMPTY_CELL, `edge cell (${x},${y}) should be EMPTY after background removal`);
      } else {
        assert(cell === blueIdx, `interior cell (${x},${y}) should survive as ${BLUE.code}`);
      }
    }
  }
  assert(res.usedColorCount === 1, 'interior should keep a single color');
});

check('maxColors cap merges low-usage colors', () => {
  const [rr, rg, rb] = hexRgb(RED.hex);
  const [br, bg, bb] = hexRgb(BLUE.hex);
  const [gr, gg, gb] = hexRgb(GREEN.hex);
  const [yr, yg, yb] = hexRgb(YELLOW.hex);
  const img = makeImage(8, 8, (x, y) => {
    if (x < 4 && y < 4) return [rr, rg, rb, 255];
    if (x >= 4 && y < 4) return [br, bg, bb, 255];
    if (x < 4) return [gr, gg, gb, 255];
    return [yr, yg, yb, 255];
  });
  const res = generateBeadGrid(img, { gridWidth: 8, maxColors: 2, removeEdgeBackground: false });
  assert(res.usedColorCount === 2, 'grid should be merged down to exactly 2 colors');
  const distinct = distinctIndices(res.grid);
  assert(distinct.size === 2 && nonEmptyCount(res.grid) === 64, 'all cells should hold one of the 2 survivor colors');
});

check('isolated single cell gets cleaned up', () => {
  const [rr, rg, rb] = hexRgb(RED.hex);
  const [br, bg, bb] = hexRgb(BLUE.hex);
  const img = makeImage(5, 5, (x, y) => (x === 2 && y === 2 ? [rr, rg, rb, 255] : [br, bg, bb, 255]));
  const res = generateBeadGrid(img, { gridWidth: 5, maxColors: 16, removeEdgeBackground: false });
  assert(res.grid.cells[2 * 5 + 2] === indexOf(BLUE.code), 'isolated red center should be repainted to neighbor blue');
  assert(res.usedColorCount === 1, 'cleanup should leave a single color');
});

check('inventory scope only picks stocked colors', () => {
  const res = generateBeadGrid(solidImage(6, 6, RED.hex), {
    gridWidth: 6,
    maxColors: 16,
    removeEdgeBackground: false,
    paletteScope: 'inventory',
    inventoryCodes: new Set([BLUE.code, RED.code]),
  });
  assert(res.paletteSize === 2, 'paletteSize should reflect the stocked subset');
  const redIdx = indexOf(RED.code);
  for (const cell of res.grid.cells) {
    assert(cell === redIdx, 'exact stocked color should win over a distant stocked blue');
  }
  expectThrow(
    () =>
      generateBeadGrid(solidImage(4, 4, RED.hex), {
        gridWidth: 4,
        maxColors: 16,
        removeEdgeBackground: false,
        paletteScope: 'inventory',
        inventoryCodes: new Set(),
      }),
    'empty inventory scope',
  );
});

check('encode/decode round-trips and validates', () => {
  const grid: BeadGrid = { width: 3, height: 2, cells: new Int32Array([0, EMPTY_CELL, 5, 200, 290, 17]) };
  const stored = encodeGrid(grid);
  assert(stored.width === 3 && stored.height === 2 && stored.cells.length === 12, 'encoded grid should carry dims and 2 chars per cell');
  assert(stored.cells.slice(2, 4) === '4Z', 'EMPTY_CELL should encode as palette index 291');
  const back = decodeGrid(stored);
  assert(back.width === 3 && back.height === 2, 'decoded dims should match');
  assert([...back.cells].join(',') === [...grid.cells].join(','), 'decoded cells should match the source grid');
  expectThrow(() => decodeGrid({ width: 2, height: 2, cells: '000' }), 'bad length');
  expectThrow(() => decodeGrid({ width: 1, height: 1, cells: '!0' }), 'illegal char');
  expectThrow(() => decodeGrid({ width: 1, height: 1, cells: '4i' }), 'out-of-range value 300');
  expectThrow(() => decodeGrid({ width: 0, height: 1, cells: '00' }), 'zero width');
  expectThrow(() => encodeGrid({ width: 1, height: 1, cells: new Int32Array([999]) }), 'illegal cell value');
});

check('gridToItems sorts by palette order; removeColorCells blanks one color', () => {
  const redIdx = indexOf(RED.code);
  const blueIdx = indexOf(BLUE.code);
  const grid: BeadGrid = { width: 2, height: 2, cells: new Int32Array([redIdx, blueIdx, EMPTY_CELL, redIdx]) };
  const items = gridToItems(grid);
  assert(items.length === 2, 'items should list one entry per used code');
  assert(items[0].code === BLUE.code && items[0].quantity === 1, 'items should sort by palette sortOrder');
  assert(items[1].code === RED.code && items[1].quantity === 2, 'items should count every bead');
  const removed = removeColorCells(grid, redIdx);
  assert(removed.cells[0] === EMPTY_CELL && removed.cells[3] === EMPTY_CELL, 'removed color cells should become EMPTY');
  assert(removed.cells[1] === blueIdx && removed.cells[2] === EMPTY_CELL, 'other cells should stay untouched');
  assert(grid.cells[0] === redIdx, 'removeColorCells must not mutate the source grid');
});

check('fully transparent image yields an empty grid', () => {
  const res = generateBeadGrid(makeImage(4, 4, () => [10, 20, 30, 0]), { gridWidth: 4, maxColors: 8 });
  assert(nonEmptyCount(res.grid) === 0, 'every cell should be EMPTY');
  assert(res.items.length === 0 && res.usedColorCount === 0, 'no beads should be counted');
  assert(res.removedCells === 0, 'nothing should be counted as background removal');
});

check('dithered gradient still produces a valid grid', () => {
  const [rr, rg, rb] = hexRgb(RED.hex);
  const [br, bg, bb] = hexRgb(BLUE.hex);
  const img = makeImage(8, 8, (x, y) => {
    const t = x / 7;
    return [Math.round(rr + (br - rr) * t), Math.round(rg + (bg - rg) * t), Math.round(rb + (bb - rb) * t), 255];
  });
  const res = generateBeadGrid(img, { gridWidth: 8, maxColors: 16, dither: true, removeEdgeBackground: false });
  for (const cell of res.grid.cells) {
    assert(cell >= 0 && cell < 291, 'dithered cells should hold valid palette indices');
  }
  assert(res.usedColorCount >= 2, 'a red-to-blue gradient should keep at least two colors');
  const again = generateBeadGrid(img, { gridWidth: 8, maxColors: 16, dither: true, removeEdgeBackground: false });
  assert([...again.grid.cells].join(',') === [...res.grid.cells].join(','), 'dither should be deterministic');
});

console.log(`pattern smoke tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}