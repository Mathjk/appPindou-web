import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { MARD_291_COLORS } from '../data/mard291';
import type { AppData, PatternProject } from '../types';
import { EMPTY_CELL, decodeGrid, gridToItems, removeColorCells } from './engine';
import type { BeadGrid } from './engine';
import { buildStockOverlay, renderGridToCanvas } from './gridRender';

export type GridViewModalProps = {
  visible: boolean;
  project?: PatternProject;
  data: AppData;
  onClose: () => void;
  /** When provided, enables tap-to-remove-color editing; called with the updated grid. */
  onGridChanged?: (grid: BeadGrid) => void;
};

const ZOOMED_CELL_PX = 22;

const colors = {
  ink: '#171A21',
  inkSoft: '#303847',
  muted: '#687080',
  line: '#DDE2EA',
  lineStrong: '#B9C1CE',
  bg: '#EEF2F6',
  bgAlt: '#F6F8FB',
  panel: '#FFFFFF',
  panelDark: '#121620',
  panelDark2: '#1C2230',
  amberSoft: '#FFF1D6',
  red: '#C0473D',
  white: '#FFFFFF',
};

const previewScrollStyle = {
  overflow: 'auto',
  maxWidth: '100%',
  maxHeight: '60vh',
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

export function GridViewModal({ visible, project, data, onClose, onGridChanged }: GridViewModalProps) {
  const { width: viewportWidth } = useWindowDimensions();
  const [grid, setGrid] = useState<BeadGrid | undefined>();
  const [decodeError, setDecodeError] = useState('');
  const [eraseMode, setEraseMode] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [showCodes, setShowCodes] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [localMsg, setLocalMsg] = useState('');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const stored = project?.grid;

  // Decode once per stored payload; edits live in local state and are written back via
  // onGridChanged so the parent can re-encode and persist them.
  useEffect(() => {
    if (!visible) return;
    setLocalMsg('');
    setEraseMode(false);
    if (!stored) {
      setGrid(undefined);
      setDecodeError('这份图纸还没有格子数据');
      return;
    }
    try {
      setGrid(decodeGrid(stored));
      setDecodeError('');
    } catch (error) {
      setGrid(undefined);
      setDecodeError(`图纸数据无法解析：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }, [visible, stored]);

  const items = useMemo(() => {
    if (!grid) return [] as Array<{ code: string; quantity: number }>;
    try {
      return gridToItems(grid);
    } catch {
      return [];
    }
  }, [grid]);

  const overlay = useMemo(() => buildStockOverlay(items, data), [items, data]);

  const previewMaxWidth = Math.min(Math.max(viewportWidth - 72, 240), 820);
  const fitCellPx = grid ? clampNumber(Math.floor(previewMaxWidth / grid.width), 3, 20) : 12;
  const cellPx = zoomed ? ZOOMED_CELL_PX : fitCellPx;

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
      // Non-fatal: keep showing the previous frame.
    }
  }, [grid, cellPx, showCodes, showOverlay, overlay]);

  const handleCanvasClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!eraseMode || !grid || !onGridChanged) return;
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
      const next = removeColorCells(grid, paletteIndex);
      setGrid(next);
      onGridChanged(next);
      setLocalMsg(`已删除 ${MARD_291_COLORS[paletteIndex]?.code ?? paletteIndex} 色 ${removed} 格，可继续点其他格子`);
    } catch (error) {
      setLocalMsg(`删除失败：${error instanceof Error ? error.message : '未知错误'}`);
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
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={ui.screen}>
        <View style={ui.header}>
          <View style={ui.flex}>
            <Text style={ui.title}>{project?.name ?? '图纸预览'}</Text>
            <Text style={ui.headerSub}>
              {grid ? `${grid.width}×${grid.height} · ${items.length} 色 · 共 ${overlay.totalBeads} 豆` : '已存图纸'}
            </Text>
          </View>
          <Pressable accessibilityLabel="关闭图纸预览" style={ui.headerClose} onPress={onClose}>
            <Text style={ui.headerCloseText}>关闭</Text>
          </Pressable>
        </View>

        {!isWeb ? (
          <View style={ui.unsupported}>
            <Text style={ui.sectionTitle}>仅支持网页版</Text>
            <Text style={ui.muted}>图纸渲染需要在浏览器里用 Canvas 绘制，请打开网页版查看。</Text>
            <View style={ui.footerRow}>
              <Pressable accessibilityLabel="返回" style={[ui.button, ui.buttonNeutral]} onPress={onClose}>
                <Text style={ui.buttonNeutralText}>返回</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <>
            <ScrollView style={ui.flex} contentContainerStyle={ui.body} keyboardShouldPersistTaps="handled">
              <View style={ui.panel}>
                <View style={ui.previewToolbar}>
                  <Text style={ui.sectionTitle}>格子图纸</Text>
                  <View style={ui.toolbarChips}>
                    <Chip label={zoomed ? '适配宽度' : '放大查看'} active={zoomed} onPress={() => setZoomed((v) => !v)} />
                    <Chip label="色号标注" active={showCodes} onPress={() => setShowCodes((v) => !v)} />
                    <Chip label="库存覆盖" active={showOverlay} onPress={() => setShowOverlay((v) => !v)} />
                    {onGridChanged ? (
                      <Chip label="点色删除" active={eraseMode} danger onPress={() => setEraseMode((v) => !v)} />
                    ) : null}
                  </View>
                </View>
                {eraseMode ? (
                  <Text style={ui.eraseHint}>点色删除已开启：点击格子删除该颜色全部格子，用量草稿会同步更新；再点「点色删除」退出。</Text>
                ) : null}
                {decodeError ? <Text style={ui.errorText}>{decodeError}</Text> : null}
                {grid ? canvasNode : !decodeError ? <Text style={ui.muted}>正在解析图纸…</Text> : null}
                {showOverlay ? <Text style={ui.legend}>红斜纹 = 缺货色 · 黄角标 = 余量低于安全库存</Text> : null}
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
              </View>

              {localMsg ? <Text style={ui.localMsg}>{localMsg}</Text> : null}
            </ScrollView>

            <View style={ui.footer}>
              <Pressable accessibilityLabel="关闭图纸" style={[ui.button, ui.buttonPrimary]} onPress={onClose}>
                <Text style={ui.buttonPrimaryText}>完成</Text>
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
