import { MARD_291_COLORS, getColor, normalizeBeadCode } from '../data/mard291';
import type { AppData } from '../types';
import { EMPTY_CELL } from './engine';
import type { BeadGrid } from './engine';

export type GridRenderOptions = {
  /** Pixel size of one bead cell. Default 16. */
  cellPx?: number;
  /** Draw thin gray separators between cells. Default true. */
  showGridLines?: boolean;
  /** Palette indices with insufficient stock — cells get a red diagonal hatch. */
  missingIndices?: ReadonlySet<number>;
  /** Palette indices whose remaining stock falls under the safety buffer — yellow corner marker. */
  lowStockIndices?: ReadonlySet<number>;
  /** Print the MARD code inside each cell. Only rendered when cellPx >= 20. */
  showCodeLabels?: boolean;
};

const BOARD_FILL = '#F4F5F7';
const EMPTY_FILL = '#E9ECF1';
const EMPTY_CROSS = '#C4CCD8';
const GRID_LINE = 'rgba(23, 26, 33, 0.14)';
const BEAD_RIM = 'rgba(23, 26, 33, 0.16)';
const MISSING_STROKE = 'rgba(192, 47, 47, 0.9)';
const LOW_STOCK_FILL = '#F5C518';
const LOW_STOCK_EDGE = 'rgba(120, 84, 0, 0.65)';

function hexToRgb(hex: string) {
  const value = hex.replace('#', '');
  const parsed = parseInt(
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value,
    16,
  );
  if (Number.isNaN(parsed)) return { r: 128, g: 128, b: 128 };
  return { r: (parsed >> 16) & 255, g: (parsed >> 8) & 255, b: parsed & 255 };
}

function labelColorFor(hex: string) {
  const { r, g, b } = hexToRgb(hex);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? 'rgba(20, 22, 28, 0.82)' : 'rgba(255, 255, 255, 0.92)';
}

function drawMissingHatch(context: CanvasRenderingContext2D, x: number, y: number, size: number) {
  context.save();
  context.beginPath();
  context.rect(x, y, size, size);
  context.clip();
  context.strokeStyle = MISSING_STROKE;
  context.lineWidth = Math.max(1, size * 0.07);
  context.lineCap = 'square';
  // 45° hatch: lines running bottom-left to top-right, spaced half a cell apart.
  for (let offset = -size; offset <= size; offset += size / 2) {
    context.beginPath();
    context.moveTo(x + offset, y + size);
    context.lineTo(x + offset + size, y);
    context.stroke();
  }
  context.restore();
}

function drawLowStockMarker(context: CanvasRenderingContext2D, x: number, y: number, size: number) {
  const corner = Math.max(4, Math.round(size * 0.38));
  context.save();
  context.beginPath();
  context.moveTo(x + size - corner, y);
  context.lineTo(x + size, y);
  context.lineTo(x + size, y + corner);
  context.closePath();
  context.fillStyle = LOW_STOCK_FILL;
  context.fill();
  context.strokeStyle = LOW_STOCK_EDGE;
  context.lineWidth = 1;
  context.stroke();
  context.restore();
}

function drawEmptyCell(context: CanvasRenderingContext2D, x: number, y: number, size: number) {
  context.fillStyle = EMPTY_FILL;
  context.fillRect(x, y, size, size);
  if (size >= 10) {
    const inset = Math.max(2, size * 0.28);
    context.strokeStyle = EMPTY_CROSS;
    context.lineWidth = Math.max(1, size * 0.05);
    context.beginPath();
    context.moveTo(x + inset, y + inset);
    context.lineTo(x + size - inset, y + size - inset);
    context.moveTo(x + size - inset, y + inset);
    context.lineTo(x + inset, y + size - inset);
    context.stroke();
  }
}

/**
 * Render a bead grid to a new canvas element. Pure DOM/canvas — no React — so it can be
 * used for on-screen previews and for producing PNG data URLs for storage.
 * Beads draw as slightly inset rounded squares on a neutral board, so white and
 * near-white beads stay visibly distinct from empty cells and the page.
 */
export function renderGridToCanvas(grid: BeadGrid, opts: GridRenderOptions = {}): HTMLCanvasElement {
  const cellPx = Math.max(2, Math.floor(opts.cellPx ?? 16));
  const showGridLines = opts.showGridLines ?? true;
  const showCodeLabels = Boolean(opts.showCodeLabels) && cellPx >= 20;
  const widthPx = Math.max(1, grid.width * cellPx);
  const heightPx = Math.max(1, grid.height * cellPx);

  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持 Canvas 渲染');

  context.fillStyle = BOARD_FILL;
  context.fillRect(0, 0, widthPx, heightPx);

  const inset = cellPx >= 8 ? Math.max(1, cellPx * 0.06) : 0;
  const beadSize = cellPx - inset * 2;
  const radius = Math.min(beadSize / 2, Math.max(0, cellPx * 0.3));

  for (let row = 0; row < grid.height; row += 1) {
    for (let col = 0; col < grid.width; col += 1) {
      const value = grid.cells[row * grid.width + col];
      const x = col * cellPx;
      const y = row * cellPx;
      if (value === EMPTY_CELL || value < 0 || value >= MARD_291_COLORS.length) {
        drawEmptyCell(context, x, y, cellPx);
        continue;
      }
      const hex = MARD_291_COLORS[value]?.hex ?? '#FF00FF';
      context.fillStyle = hex;
      if (inset > 0) {
        context.beginPath();
        context.roundRect(x + inset, y + inset, beadSize, beadSize, radius);
        context.fill();
        context.strokeStyle = BEAD_RIM;
        context.lineWidth = 1;
        context.stroke();
      } else {
        context.fillRect(x, y, cellPx, cellPx);
      }
      if (opts.missingIndices?.has(value)) drawMissingHatch(context, x, y, cellPx);
      else if (opts.lowStockIndices?.has(value)) drawLowStockMarker(context, x, y, cellPx);
      if (showCodeLabels) {
        const code = MARD_291_COLORS[value]?.code ?? '';
        if (code) {
          context.fillStyle = labelColorFor(hex);
          context.font = `700 ${Math.max(9, Math.floor(cellPx * 0.34))}px Menlo, ui-monospace, monospace`;
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          context.fillText(code, x + cellPx / 2, y + cellPx / 2 + 0.5);
        }
      }
    }
  }

  if (showGridLines && cellPx >= 5) {
    context.strokeStyle = GRID_LINE;
    context.lineWidth = 1;
    context.beginPath();
    for (let col = 0; col <= grid.width; col += 1) {
      const x = col * cellPx + 0.5;
      context.moveTo(x, 0);
      context.lineTo(x, heightPx);
    }
    for (let row = 0; row <= grid.height; row += 1) {
      const y = row * cellPx + 0.5;
      context.moveTo(0, y);
      context.lineTo(widthPx, y);
    }
    context.stroke();
  }

  return canvas;
}

export type StockOverlayRow = {
  code: string;
  required: number;
  stock: number;
  missing: number;
  lowStock: boolean;
  /** Index into MARD_291_COLORS, or -1 when the code isn't in the palette. */
  paletteIndex: number;
};

export type StockOverlay = {
  missing: ReadonlySet<number>;
  low: ReadonlySet<number>;
  rows: StockOverlayRow[];
  totalBeads: number;
  missingColors: number;
  missingBeads: number;
};

/**
 * Compare a grid BOM against inventory: which palette indices are short (missing > 0)
 * and which fall below the project safety buffer after deducting demand.
 */
export function buildStockOverlay(items: Array<{ code: string; quantity: number }>, data: AppData): StockOverlay {
  const missing = new Set<number>();
  const low = new Set<number>();
  const safetyBuffer = Math.max(0, Math.floor(data.settings.projectSafetyBuffer ?? 0));
  let totalBeads = 0;
  let missingBeads = 0;
  const rows = items.map((item) => {
    const color = getColor(item.code);
    const paletteIndex = color ? MARD_291_COLORS.indexOf(color) : -1;
    const required = Math.max(0, Math.floor(item.quantity));
    const code = normalizeBeadCode(item.code) || item.code;
    const stock = data.inventory[code]?.quantity ?? 0;
    const missingQty = Math.max(required - stock, 0);
    const lowStock = missingQty === 0 && stock - required < safetyBuffer;
    if (paletteIndex >= 0) {
      if (missingQty > 0) missing.add(paletteIndex);
      else if (lowStock) low.add(paletteIndex);
    }
    totalBeads += required;
    missingBeads += missingQty;
    return { code, required, stock, missing: missingQty, lowStock, paletteIndex };
  });
  const missingColors = rows.filter((row) => row.missing > 0).length;
  return { missing, low, rows, totalBeads, missingColors, missingBeads };
}
