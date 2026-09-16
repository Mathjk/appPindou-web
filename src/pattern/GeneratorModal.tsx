import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { MARD_291_COLORS } from '../data/mard291';
import type { AppData } from '../types';
import {
  EMPTY_CELL,
  GRID_WIDTH_PRESETS,
  VARIANT_PRESETS,
  generateBeadGrid,
  gridToItems,
  removeColorCells,
  usablePaletteIndices,
} from './engine';
import type { BeadGrid, ImagePixels, PaletteScope } from './engine';
import { buildStockOverlay, exportGridPng, renderGridToCanvas } from './gridRender';
import { segmentPerson } from './segment';
import type { ForegroundMask } from './segment';

export type GeneratorSaveResult = {
  grid: BeadGrid;
  items: Array<{ code: string; quantity: number }>;
  previewDataUrl: string;
  message: string;
};

export type GeneratorModalProps = {
  visible: boolean;
  imageUri?: string;
  data: AppData;
  onCancel: () => void;
  onSave: (result: GeneratorSaveResult) => void;
};

const MAX_IMAGE_SIDE = 1600;
const GRID_WIDTH_MIN = 16;
const GRID_WIDTH_MAX = 140;
const MAX_COLORS_MIN = 4;
const MAX_COLORS_MAX = 50;
const ZOOMED_CELL_PX = 22;

const colors = {
  ink: '#171A21',
  inkSoft: '#303847',
  muted: '#687080',
  faint: '#9AA2AF',
  line: '#DDE2EA',
  lineStrong: '#B9C1CE',
  bg: '#EEF2F6',
  bgAlt: '#F6F8FB',
  panel: '#FFFFFF',
  panelTint: '#F9FBFE',
  panelDark: '#121620',
  panelDark2: '#1C2230',
  green: '#0F7A62',
  amber: '#B46A16',
  amberSoft: '#FFF1D6',
  red: '#C0473D',
  redSoft: '#FFE5E1',
  blue: '#2D66C3',
  blueSoft: '#E6F0FF',
  white: '#FFFFFF',
};

const previewScrollStyle = {
  overflow: 'auto',
  maxWidth: '100%',
  maxHeight: '52vh',
  borderRadius: 8,
  border: `1px solid ${colors.line}`,
  backgroundColor: colors.bgAlt,
} as const;

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function Chip({
  label,
  active = false,
  danger = false,
  onPress,
}: {
  label: string;
  active?: boolean;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        ui.chip,
        active && ui.chipActive,
        active && danger && ui.chipDanger,
        pressed && ui.chipPressed,
      ]}
    >
      <Text style={[ui.chipText, active && ui.chipTextActive, active && danger && ui.chipDangerText]}>{label}</Text>
    </Pressable>
  );
}

export function GeneratorModal({ visible, imageUri, data, onCancel, onSave }: GeneratorModalProps) {
  const { width: viewportWidth } = useWindowDimensions();
  const [pixels, setPixels] = useState<ImagePixels | undefined>();
  const [loadError, setLoadError] = useState('');
  const [gridWidth, setGridWidth] = useState(52);
  const [gridWidthInput, setGridWidthInput] = useState('52');
  const [maxColors, setMaxColors] = useState(20);
  const [maxColorsInput, setMaxColorsInput] = useState('20');
  const [paletteScope, setPaletteScope] = useState<PaletteScope>('all');
  const [dither, setDither] = useState(false);
  const [removeBg, setRemoveBg] = useState(true);
  const [sampling, setSampling] = useState<'dominant' | 'average'>('dominant');
  const [smooth, setSmooth] = useState(true);
  const [eraseMode, setEraseMode] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [bgMode, setBgMode] = useState<'edge' | 'person'>('edge');
  const [segMask, setSegMask] = useState<ForegroundMask | undefined>();
  const [segBusy, setSegBusy] = useState(false);
  const [segError, setSegError] = useState('');
  const sourceCanvasRef = useRef<HTMLCanvasElement | undefined>(undefined);
  const [showCodes, setShowCodes] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [grid, setGrid] = useState<BeadGrid | undefined>();
  const [meta, setMeta] = useState<{ usedColorCount: number; paletteSize: number; removedCells: number } | undefined>();
  const [genError, setGenError] = useState('');
  const [localMsg, setLocalMsg] = useState('');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const inventoryCodes = useMemo(() => {
    const codes = new Set<string>();
    for (const [code, entry] of Object.entries(data.inventory)) {
      if ((entry?.quantity ?? 0) > 0) codes.add(code);
    }
    return codes;
  }, [data.inventory]);

  // Load the picked photo into raw pixels (downscaled so huge phone photos stay snappy).
  useEffect(() => {
    if (!visible || !imageUri || Platform.OS !== 'web' || typeof document === 'undefined') return;
    let cancelled = false;
    setLoadError('');
    setGenError('');
    setPixels(undefined);
    setGrid(undefined);
    setSegMask(undefined);
    setSegError('');
    setSegBusy(false);
    sourceCanvasRef.current = undefined;
    const image = document.createElement('img');
    image.onload = () => {
      if (cancelled) return;
      try {
        const sourceWidth = image.naturalWidth || image.width;
        const sourceHeight = image.naturalHeight || image.height;
        if (!sourceWidth || !sourceHeight) throw new Error('图片尺寸为空');
        const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(sourceWidth, sourceHeight));
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('浏览器不支持 Canvas');
        context.drawImage(image, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
        const imageData = context.getImageData(0, 0, width, height);
        sourceCanvasRef.current = canvas;
        setPixels({ width, height, data: imageData.data });
      } catch (error) {
        setLoadError(`图片读取失败：${error instanceof Error ? error.message : '未知错误'}`);
      }
    };
    image.onerror = () => {
      if (!cancelled) setLoadError('图片加载失败，请换一张再试');
    };
    image.decoding = 'async';
    image.src = imageUri;
    return () => {
      cancelled = true;
    };
  }, [visible, imageUri]);

  // Person segmentation: lazy-loads the MediaPipe WASM model on first use and
  // caches the mask per loaded image. Failure falls back to edge detection.
  useEffect(() => {
    if (bgMode !== 'person' || segMask || segBusy || segError) return;
    const source = sourceCanvasRef.current;
    if (!source || !pixels) return;
    let cancelled = false;
    setSegBusy(true);
    segmentPerson(source, pixels.width, pixels.height)
      .then((mask) => {
        if (cancelled) return;
        setSegMask(mask);
        setSegBusy(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setSegBusy(false);
        setSegError(`人像分割失败，已回退边缘检测：${error instanceof Error ? error.message : '未知错误'}`);
        setBgMode('edge');
      });
    return () => {
      cancelled = true;
    };
  }, [bgMode, segMask, segBusy, segError, pixels]);

  // Regenerate whenever the source pixels or any parameter change. Wide grids get a small
  // debounce so numeric inputs stay responsive.
  useEffect(() => {
    if (!pixels) return;
    if (bgMode === 'person' && !segMask) {
      setGrid(undefined);
      return;
    }
    if (paletteScope === 'inventory' && inventoryCodes.size === 0) {
      setGrid(undefined);
      setGenError('库存为空，无法使用「仅库存色号」；请先在豆仓录入库存或切换色板范围');
      return;
    }
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      try {
        const result = generateBeadGrid(pixels, {
          gridWidth,
          maxColors,
          dither,
          sampling,
          smooth,
          removeEdgeBackground: removeBg,
          segmentationMask: bgMode === 'person' ? segMask : undefined,
          paletteScope,
          inventoryCodes: paletteScope === 'inventory' ? inventoryCodes : undefined,
        });
        if (cancelled) return;
        setGrid(result.grid);
        setMeta({
          usedColorCount: result.usedColorCount,
          paletteSize: result.paletteSize,
          removedCells: result.removedCells,
        });
        setGenError('');
      } catch (error) {
        if (!cancelled) setGenError(`生成失败：${error instanceof Error ? error.message : '未知错误'}`);
      }
    };
    if (gridWidth > 80) {
      const timer = setTimeout(run, 150);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [pixels, gridWidth, maxColors, dither, sampling, smooth, removeBg, bgMode, segMask, paletteScope, inventoryCodes]);

  const items = useMemo(() => {
    if (!grid) return [] as Array<{ code: string; quantity: number }>;
    try {
      return gridToItems(grid);
    } catch {
      return [];
    }
  }, [grid]);

  const overlay = useMemo(() => buildStockOverlay(items, data), [items, data]);

  const inventoryUsableCount = useMemo(() => {
    try {
      return usablePaletteIndices('inventory', inventoryCodes).length;
    } catch {
      return inventoryCodes.size;
    }
  }, [inventoryCodes]);
  const showInventoryWarning = paletteScope === 'inventory' && inventoryUsableCount < 8;

  const previewMaxWidth = Math.min(Math.max(viewportWidth - 72, 240), 820);
  const fitCellPx = grid ? clampNumber(Math.floor(previewMaxWidth / grid.width), 3, 20) : 12;
  const cellPx = zoomed ? ZOOMED_CELL_PX : fitCellPx;

  // Paint the grid into the display canvas via the shared renderer.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !grid) return;
    try {
      const rendered = renderGridToCanvas(grid, {
        cellPx,
        showGridLines: true,
        showCodeLabels: showCodes,
        missingIndices: showOverlay ? overlay.missing : undefined,
        lowStockIndices: showOverlay ? overlay.low : undefined,
      });
      canvas.width = rendered.width;
      canvas.height = rendered.height;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(rendered, 0, 0);
    } catch {
      // Rendering failures are non-fatal; the grid state stays intact.
    }
  }, [grid, cellPx, showCodes, showOverlay, overlay]);

  const applyGridWidth = (value: number) => {
    const next = clampNumber(value, GRID_WIDTH_MIN, GRID_WIDTH_MAX);
    setGridWidth(next);
    setGridWidthInput(String(next));
  };

  const handleGridWidthInput = (raw: string) => {
    setGridWidthInput(raw);
    const value = parseInt(raw.replace(/[^\d]/g, ''), 10);
    if (Number.isFinite(value) && value >= GRID_WIDTH_MIN && value <= GRID_WIDTH_MAX) setGridWidth(value);
  };

  const applyMaxColors = (value: number) => {
    const next = clampNumber(value, MAX_COLORS_MIN, MAX_COLORS_MAX);
    setMaxColors(next);
    setMaxColorsInput(String(next));
  };

  const handleMaxColorsInput = (raw: string) => {
    setMaxColorsInput(raw);
    const value = parseInt(raw.replace(/[^\d]/g, ''), 10);
    if (Number.isFinite(value) && value >= MAX_COLORS_MIN && value <= MAX_COLORS_MAX) setMaxColors(value);
  };

  const handleCanvasClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!eraseMode || !grid) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const col = Math.floor(((event.clientX - rect.left) / rect.width) * grid.width);
    const row = Math.floor(((event.clientY - rect.top) / rect.height) * grid.height);
    if (col < 0 || row < 0 || col >= grid.width || row >= grid.height) return;
    const paletteIndex = grid.cells[row * grid.width + col];
    if (paletteIndex === EMPTY_CELL || paletteIndex < 0 || paletteIndex >= MARD_291_COLORS.length) {
      setLocalMsg('这一格是空格，没有可删除的颜色');
      return;
    }
    let removed = 0;
    for (const value of grid.cells) {
      if (value === paletteIndex) removed += 1;
    }
    try {
      setGrid(removeColorCells(grid, paletteIndex));
      setLocalMsg(`已删除 ${MARD_291_COLORS[paletteIndex]?.code ?? paletteIndex} 色 ${removed} 格，可继续点其他格子`);
    } catch (error) {
      setLocalMsg(`删除失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  const handleExportPng = () => {
    if (!grid) {
      setLocalMsg('还没有生成图纸，无法导出');
      return;
    }
    try {
      exportGridPng(grid, `拼豆图纸-${grid.width}x${grid.height}.png`);
      setLocalMsg('已导出 PNG 图片');
    } catch (error) {
      setLocalMsg(`导出失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  const handleSave = () => {
    if (!grid) {
      setLocalMsg('还没有生成图纸，无法保存');
      return;
    }
    try {
      const preview = renderGridToCanvas(grid, { cellPx: 14, showGridLines: true });
      onSave({
        grid,
        items,
        previewDataUrl: preview.toDataURL('image/png'),
        message: `照片生成 · ${grid.width}×${grid.height} · ${items.length} 色`,
      });
    } catch (error) {
      setLocalMsg(`导出预览失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  const missingRows = overlay.rows.filter((row) => row.missing > 0);
  const isWeb = Platform.OS === 'web' && typeof document !== 'undefined';

  const canvasNode = isWeb
    ? createElement(
        'div',
        { style: previewScrollStyle },
        createElement('canvas', {
          ref: canvasRef,
          onClick: handleCanvasClick,
          style: {
            display: 'block',
            cursor: eraseMode ? 'crosshair' : 'default',
            imageRendering: 'pixelated',
          },
        }),
      )
    : null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      <View style={ui.screen}>
        <View style={ui.header}>
          <View style={ui.flex}>
            <Text style={ui.title}>照片生成图纸</Text>
            <Text style={ui.headerSub}>调整参数实时预览拼豆效果，确认后存为图纸项目</Text>
          </View>
          <Pressable accessibilityLabel="关闭照片生成" style={ui.headerClose} onPress={onCancel}>
            <Text style={ui.headerCloseText}>关闭</Text>
          </Pressable>
        </View>

        {!isWeb ? (
          <View style={ui.unsupported}>
            <Text style={ui.sectionTitle}>仅支持网页版</Text>
            <Text style={ui.muted}>照片生成需要在浏览器里用 Canvas 处理图片，请打开网页版使用。</Text>
            <View style={ui.footerRow}>
              <Pressable accessibilityLabel="返回" style={[ui.button, ui.buttonNeutral]} onPress={onCancel}>
                <Text style={ui.buttonNeutralText}>返回</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <>
            <ScrollView style={ui.flex} contentContainerStyle={ui.body} keyboardShouldPersistTaps="handled">
              <View style={ui.panel}>
                <View style={ui.previewToolbar}>
                  <Text style={ui.sectionTitle}>
                    图纸预览{grid ? ` ${grid.width}×${grid.height}` : ''}
                    {meta ? ` · ${meta.usedColorCount} 色` : ''}
                  </Text>
                  <View style={ui.toolbarChips}>
                    <Chip label={zoomed ? '适配宽度' : '放大查看'} active={zoomed} onPress={() => setZoomed((v) => !v)} />
                    <Chip label="色号标注" active={showCodes} onPress={() => setShowCodes((v) => !v)} />
                    <Chip label="库存覆盖" active={showOverlay} onPress={() => setShowOverlay((v) => !v)} />
                    <Chip label="点色删除" active={eraseMode} danger onPress={() => setEraseMode((v) => !v)} />
                    <Chip label="导出图片" onPress={handleExportPng} />
                  </View>
                </View>
                {eraseMode ? (
                  <Text style={ui.eraseHint}>点色删除已开启：点击预览中的格子，删除该颜色全部格子；再点「点色删除」退出。</Text>
                ) : null}
                {loadError ? <Text style={ui.errorText}>{loadError}</Text> : null}
                {genError ? <Text style={ui.errorText}>{genError}</Text> : null}
                {!pixels && !loadError ? <Text style={ui.muted}>正在读取图片…</Text> : null}
                {grid ? canvasNode : !genError && !loadError && pixels ? <Text style={ui.muted}>正在生成图纸…</Text> : null}
                {showOverlay ? <Text style={ui.legend}>红斜纹 = 缺货色 · 黄角标 = 余量低于安全库存</Text> : null}
                {segBusy ? <Text style={ui.muted}>正在加载模型并分割人像…（首次使用需下载模型文件）</Text> : null}
                {segError ? <Text style={ui.errorText}>{segError}</Text> : null}
                {meta?.removedCells ? <Text style={ui.muted}>自动去背景已清空 {meta.removedCells} 格</Text> : null}
              </View>

              <View style={ui.panel}>
                <Text style={ui.summaryText}>
                  共 {overlay.totalBeads} 豆 · {items.length} 色
                  {missingRows.length ? ` · 缺 ${missingRows.length} 色 ${overlay.missingBeads} 颗` : ' · 库存可覆盖'}
                </Text>
                {missingRows.length ? (
                  <View style={ui.missChipWrap}>
                    {missingRows.map((row) => {
                      const hex = row.paletteIndex >= 0 ? MARD_291_COLORS[row.paletteIndex]?.hex ?? '#ddd' : '#ddd';
                      return (
                        <View key={row.code} style={ui.missChip}>
                          <View style={[ui.missSwatch, { backgroundColor: hex }]} />
                          <Text style={ui.missChipText}>
                            {row.code} 缺{row.missing}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                ) : null}
                {showInventoryWarning ? (
                  <Text style={ui.errorText}>库存仅 {inventoryUsableCount} 色可用，图纸可能严重失真</Text>
                ) : null}
              </View>

              <View style={ui.panel}>
                <Text style={ui.label}>快捷变体</Text>
                <View style={ui.chipRow}>
                  {VARIANT_PRESETS.map((preset) => (
                    <Chip
                      key={preset.id}
                      label={preset.labelZh}
                      active={maxColors === preset.maxColors && paletteScope !== 'inventory'}
                      onPress={() => applyMaxColors(preset.maxColors)}
                    />
                  ))}
                  <Chip label="仅库存色号" active={paletteScope === 'inventory'} onPress={() => setPaletteScope('inventory')} />
                </View>

                <Text style={ui.label}>图纸宽度（格）</Text>
                <View style={ui.chipRow}>
                  {GRID_WIDTH_PRESETS.map((width) => (
                    <Chip key={width} label={`${width} 格`} active={gridWidth === width} onPress={() => applyGridWidth(width)} />
                  ))}
                  <TextInput
                    style={[ui.input, ui.numInput]}
                    value={gridWidthInput}
                    onChangeText={handleGridWidthInput}
                    keyboardType="number-pad"
                    accessibilityLabel="自定义图纸宽度"
                  />
                </View>
                <Text style={ui.muted}>范围 {GRID_WIDTH_MIN}-{GRID_WIDTH_MAX} 格，高度按图片比例自动计算</Text>

                <Text style={ui.label}>最大色数</Text>
                <View style={ui.chipRow}>
                  <Pressable accessibilityLabel="减少最大色数" style={ui.stepButton} onPress={() => applyMaxColors(maxColors - 1)}>
                    <Text style={ui.stepButtonText}>−</Text>
                  </Pressable>
                  <TextInput
                    style={[ui.input, ui.numInput]}
                    value={maxColorsInput}
                    onChangeText={handleMaxColorsInput}
                    keyboardType="number-pad"
                    accessibilityLabel="最大色数"
                  />
                  <Pressable accessibilityLabel="增加最大色数" style={ui.stepButton} onPress={() => applyMaxColors(maxColors + 1)}>
                    <Text style={ui.stepButtonText}>+</Text>
                  </Pressable>
                </View>
                <Text style={ui.muted}>范围 {MAX_COLORS_MIN}-{MAX_COLORS_MAX} 色，超出后低频色会并入最接近的颜色</Text>

                <Text style={ui.label}>色板范围</Text>
                <View style={ui.chipRow}>
                  <Chip label="全部 291 色" active={paletteScope === 'all'} onPress={() => setPaletteScope('all')} />
                  <Chip label="仅 221 套装" active={paletteScope === 'mard221'} onPress={() => setPaletteScope('mard221')} />
                  <Chip label="仅库存色号" active={paletteScope === 'inventory'} onPress={() => setPaletteScope('inventory')} />
                </View>

                <Text style={ui.label}>抠图方式</Text>
                <View style={ui.chipRow}>
                  <Chip label="边缘检测" active={bgMode === 'edge'} onPress={() => setBgMode('edge')} />
                  <Chip label="人像分割（AI）" active={bgMode === 'person'} onPress={() => setBgMode('person')} />
                </View>
                {bgMode === 'person' ? (
                  <Text style={ui.muted}>AI 人像分割启用时，去背景由分割结果接管，「自动去背景」不生效</Text>
                ) : null}

                <Text style={ui.label}>采样方式</Text>
                <View style={ui.chipRow}>
                  <Chip label="保边（线条/卡通）" active={sampling === 'dominant'} onPress={() => setSampling('dominant')} />
                  <Chip label="平滑（照片渐变）" active={sampling === 'average'} onPress={() => setSampling('average')} />
                </View>

                <Text style={ui.label}>效果开关</Text>
                <View style={ui.chipRow}>
                  <Chip label={`杂点清理 ${smooth ? '开' : '关'}`} active={smooth} onPress={() => setSmooth((v) => !v)} />
                  <Chip label={`抖动 ${dither ? '开' : '关'}`} active={dither} onPress={() => setDither((v) => !v)} />
                  <Chip label={`自动去背景 ${removeBg ? '开' : '关'}`} active={removeBg} onPress={() => setRemoveBg((v) => !v)} />
                </View>
              </View>

              {localMsg ? <Text style={ui.localMsg}>{localMsg}</Text> : null}
            </ScrollView>

            <View style={ui.footer}>
              <Pressable accessibilityLabel="取消生成" style={[ui.button, ui.buttonNeutral]} onPress={onCancel}>
                <Text style={ui.buttonNeutralText}>取消</Text>
              </Pressable>
              <Pressable accessibilityLabel="存为图纸" style={[ui.button, ui.buttonPrimary]} onPress={handleSave}>
                <Text style={ui.buttonPrimaryText}>存为图纸</Text>
              </Pressable>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const ui = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.panelDark,
    borderBottomWidth: 1,
    borderBottomColor: '#2A3142',
  },
  title: {
    color: colors.white,
    fontSize: 18,
    fontWeight: '900',
  },
  muted: {
    color: colors.muted,
    lineHeight: 19,
    fontSize: 12,
  },
  headerSub: {
    color: '#A9B4C7',
    marginTop: 3,
    fontSize: 12,
    fontWeight: '700',
  },
  headerClose: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#3C465F',
    backgroundColor: colors.panelDark2,
  },
  headerCloseText: {
    color: colors.white,
    fontWeight: '900',
    fontSize: 13,
  },
  body: {
    width: '100%',
    maxWidth: 960,
    alignSelf: 'center',
    padding: 12,
    paddingBottom: 28,
    gap: 10,
  },
  panel: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 8,
    padding: 13,
    gap: 8,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '900',
    color: colors.ink,
  },
  previewToolbar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  toolbarChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.white,
  },
  chipActive: {
    backgroundColor: colors.panelDark,
    borderColor: colors.panelDark,
  },
  chipDanger: {
    backgroundColor: colors.red,
    borderColor: colors.red,
  },
  chipPressed: {
    opacity: 0.84,
  },
  chipText: {
    color: colors.ink,
    fontWeight: '800',
    fontSize: 13,
  },
  chipTextActive: {
    color: colors.white,
  },
  chipDangerText: {
    color: colors.white,
  },
  label: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '900',
    marginTop: 6,
  },
  input: {
    minHeight: 38,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panelTint,
    borderRadius: 8,
    paddingHorizontal: 10,
    color: colors.ink,
    fontSize: 15,
  },
  numInput: {
    width: 88,
    textAlign: 'center',
  },
  stepButton: {
    width: 38,
    height: 38,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepButtonText: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '900',
  },
  summaryText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '900',
  },
  missChipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  missChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E7B24D',
    backgroundColor: colors.amberSoft,
  },
  missSwatch: {
    width: 14,
    height: 14,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(23, 26, 33, 0.2)',
  },
  missChipText: {
    color: '#74460D',
    fontSize: 12,
    fontWeight: '800',
  },
  legend: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  eraseHint: {
    color: '#74460D',
    backgroundColor: colors.amberSoft,
    borderWidth: 1,
    borderColor: '#E7B24D',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 12,
    fontWeight: '700',
    overflow: 'hidden',
  },
  errorText: {
    color: colors.red,
    fontWeight: '800',
    lineHeight: 19,
  },
  localMsg: {
    color: '#74460D',
    fontWeight: '700',
    paddingHorizontal: 4,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.panel,
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 12,
  },
  button: {
    minHeight: 40,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
  },
  buttonPrimary: {
    backgroundColor: colors.panelDark,
    borderColor: colors.panelDark,
  },
  buttonPrimaryText: {
    color: colors.white,
    fontWeight: '900',
  },
  buttonNeutral: {
    backgroundColor: colors.white,
    borderColor: colors.lineStrong,
  },
  buttonNeutralText: {
    color: colors.ink,
    fontWeight: '900',
  },
  unsupported: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 8,
  },
});
