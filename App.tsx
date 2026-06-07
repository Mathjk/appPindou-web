import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import { Directory, File, Paths } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { MARD_291_COLORS, MARD_SERIES_ORDER, getColor, isKnownBeadCode, normalizeBeadCode, tryNormalizeBeadCode } from './src/data/mard291';
import {
  adjustStock,
  addProjectShortageToPurchaseList,
  addPurchaseItem,
  applyStockChange,
  buildPurchaseRows,
  buildRequirementRows,
  clampWholeNumber,
  createEmptyData,
  createPurchaseList,
  createProject,
  deductProjectInventory,
  deletePurchaseList,
  deleteProject,
  formatPurchaseRows,
  getInventoryStats,
  getStock,
  makeId,
  parseWholeNumber,
  recordActionHistory,
  removePurchaseItem,
  rollbackToHistoryEntry,
  setPurchaseItemQuantity,
  undoSingleHistoryEntry,
  upsertPurchaseList,
  upsertProject,
} from './src/domain';
import { recognizePatternDraft } from './src/ocr';
import { exportAppData, loadAppData, parseImportedData, saveAppData } from './src/storage';
import type { AppData, PatternProject, ProjectItem, PurchaseList } from './src/types';

type TabKey = 'inventory' | 'projects' | 'shopping' | 'settings';
type UpdateData = (producer: (current: AppData) => AppData, label?: string, options?: { recordHistory?: boolean }) => string | undefined;
type ShowNotice = (message: string) => void;
type CropPixels = { originX: number; originY: number; width: number; height: number };
type DisplayCropRect = { x: number; y: number; width: number; height: number };
type CropGestureMode = 'move' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: 'inventory', label: '豆仓' },
  { key: 'projects', label: '图纸' },
  { key: 'shopping', label: '采购' },
  { key: 'settings', label: '设置' },
];

const SEARCH_SERIES_ORDER = [...MARD_SERIES_ORDER].sort((left, right) => right.length - left.length);
const NUMBER_PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

function normalizeSearchQuery(value: string) {
  return value.replace(/[a-z]/g, (letter) => letter.toUpperCase()).trimStart();
}

function getSearchSeries(value: string) {
  const normalized = normalizeSearchQuery(value).trim();
  return SEARCH_SERIES_ORDER.find((item) => normalized === item || new RegExp(`^${item}\\d*$`).test(normalized));
}

export default function App() {
  const viewport = useWindowDimensions();
  const [tab, setTab] = useState<TabKey>('inventory');
  const [data, setData] = useState<AppData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState('');
  const [noticeUndoId, setNoticeUndoId] = useState<string | undefined>();
  const lastHistoryIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    loadAppData()
      .then(setData)
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (loaded && data) {
      saveAppData(data).catch(() => {
        setNotice('本地保存失败，请稍后重试');
        setNoticeUndoId(undefined);
      });
    }
  }, [data, loaded]);

  const showNotice: ShowNotice = (message) => {
    setNotice(message);
    setNoticeUndoId(message ? lastHistoryIdRef.current : undefined);
    lastHistoryIdRef.current = undefined;
  };

  const updateData: UpdateData = (producer, label = '数据变更', options) => {
    let createdHistoryId: string | undefined;
    setData((current) => {
      if (!current) return current;
      const produced = producer(current);
      if (options?.recordHistory === false) return produced;
      const recorded = recordActionHistory(current, produced, label);
      createdHistoryId = recorded.actionHistory[0]?.id !== current.actionHistory[0]?.id ? recorded.actionHistory[0]?.id : undefined;
      return recorded;
    });
    lastHistoryIdRef.current = createdHistoryId;
    return createdHistoryId;
  };

  const undoNoticeAction = () => {
    if (!noticeUndoId) return;
    updateData((current) => undoSingleHistoryEntry(current, noticeUndoId), '撤销操作', { recordHistory: false });
    setNotice('已撤销操作');
    setNoticeUndoId(undefined);
  };

  if (!loaded || !data) {
    return (
      <SafeAreaView style={[styles.shell, Platform.OS === 'web' && styles.webShell, Platform.OS === 'web' && { height: viewport.height }]}>
        <StatusBar style="dark" />
        <View style={styles.loading}>
          <Text style={styles.brand}>豆仓</Text>
          <Text style={styles.muted}>正在读取本地数据...</Text>
        </View>
      </SafeAreaView>
    );
  }

  const stats = getInventoryStats(data);

  return (
    <SafeAreaView style={[styles.shell, Platform.OS === 'web' && styles.webShell, Platform.OS === 'web' && { height: viewport.height }]}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.shell}>
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>MARD 豆仓</Text>
            <Text style={styles.headerSub}>
              {stats.stocked}/{stats.totalColors} 色有库存 · 共 {stats.totalBeads} 颗
            </Text>
          </View>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{stats.low} 低库存</Text>
          </View>
        </View>

        {notice ? (
          <View style={styles.notice}>
            <View style={styles.noticeInline}>
              <Text style={styles.noticeText}>{notice}</Text>
              {noticeUndoId ? (
                <Pressable style={styles.noticeButton} onPress={undoNoticeAction}>
                  <Text style={styles.noticeButtonText}>撤销操作</Text>
                </Pressable>
              ) : null}
              <Pressable style={styles.noticeButton} onPress={() => showNotice('')}>
                <Text style={styles.noticeButtonText}>关闭</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        <View style={styles.content}>
          {tab === 'inventory' ? <InventoryScreen data={data} updateData={updateData} setNotice={showNotice} /> : null}
          {tab === 'projects' ? <ProjectsScreen data={data} updateData={updateData} setNotice={showNotice} /> : null}
          {tab === 'shopping' ? <ShoppingScreen data={data} updateData={updateData} setNotice={showNotice} /> : null}
          {tab === 'settings' ? <SettingsScreen data={data} updateData={updateData} setNotice={showNotice} /> : null}
        </View>

        <View style={styles.tabbar}>
          {tabs.map((item) => (
            <Pressable key={item.key} style={[styles.tab, tab === item.key && styles.tabActive]} onPress={() => setTab(item.key)}>
              <Text style={[styles.tabText, tab === item.key && styles.tabTextActive]}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function InventoryScreen({
  data,
  updateData,
  setNotice,
}: {
  data: AppData;
  updateData: UpdateData;
  setNotice: ShowNotice;
}) {
  const viewport = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [series, setSeries] = useState('ALL');
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchKeypadVisible, setSearchKeypadVisible] = useState(false);
  const [selectedCode, setSelectedCode] = useState('G2');
  const [amount, setAmount] = useState('100');
  const [packs, setPacks] = useState('1');
  const [inventoryPackSize, setInventoryPackSize] = useState(String(data.settings.inventoryPackSize));
  const [editingPackSize, setEditingPackSize] = useState(false);
  const [selectedPurchaseListId, setSelectedPurchaseListId] = useState(data.purchaseLists[0]?.id);
  const [purchasePickerOpen, setPurchasePickerOpen] = useState(false);

  const selectedColor = getColor(selectedCode) ?? MARD_291_COLORS[0];
  const selectedStock = getStock(data, selectedColor.code);
  const selectedPurchaseList = data.purchaseLists.find((list) => list.id === selectedPurchaseListId) ?? data.purchaseLists[0];
  const searchSeries = getSearchSeries(query);
  const compactInventory = viewport.width < 430;
  const showSearchNumberPad = Platform.OS === 'web' && searchFocused && searchKeypadVisible && Boolean(searchSeries);

  useEffect(() => {
    if (!selectedPurchaseListId || !data.purchaseLists.some((list) => list.id === selectedPurchaseListId)) {
      setSelectedPurchaseListId(data.purchaseLists[0]?.id);
    }
  }, [data.purchaseLists, selectedPurchaseListId]);

  useEffect(() => {
    if (!editingPackSize) setInventoryPackSize(String(data.settings.inventoryPackSize));
  }, [data.settings.inventoryPackSize, editingPackSize]);

  const filteredColors = useMemo(() => {
    const normalizedQuery = normalizeSearchQuery(query).trim().toUpperCase();
    return MARD_291_COLORS.filter((color) => {
      const matchesSeries = series === 'ALL' || color.series === series;
      const matchesQuery =
        !normalizedQuery ||
        color.code.includes(normalizedQuery) ||
        color.aliases.some((alias) => alias.toUpperCase().includes(normalizedQuery)) ||
        color.nameZh?.includes(query.trim()) ||
        color.nameEn?.toUpperCase().includes(normalizedQuery);
      return matchesSeries && matchesQuery;
    });
  }, [query, series]);

  const handleSearchChange = (value: string) => {
    const nextQuery = normalizeSearchQuery(value);
    const inferredSeries = getSearchSeries(nextQuery);
    setQuery(nextQuery);
    setSeries(inferredSeries ?? 'ALL');
    setSearchKeypadVisible(Boolean(inferredSeries));
  };

  const selectSeries = (nextSeries: string) => {
    Keyboard.dismiss();
    setSeries(nextSeries);
    setQuery(nextSeries === 'ALL' ? '' : nextSeries);
    setSearchFocused(false);
    setSearchKeypadVisible(false);
  };

  const appendSearchDigit = (digit: string) => {
    const activeSeries = searchSeries ?? (series !== 'ALL' ? series : '');
    if (!activeSeries) return;
    const normalized = normalizeSearchQuery(query).trim();
    const currentDigits = normalized.startsWith(activeSeries) ? normalized.slice(activeSeries.length).replace(/\D/g, '') : '';
    handleSearchChange(`${activeSeries}${currentDigits}${digit}`);
  };

  const deleteSearchDigit = () => {
    const activeSeries = searchSeries ?? (series !== 'ALL' ? series : '');
    if (!activeSeries) {
      handleSearchChange('');
      return;
    }
    const normalized = normalizeSearchQuery(query).trim();
    const currentDigits = normalized.startsWith(activeSeries) ? normalized.slice(activeSeries.length).replace(/\D/g, '') : '';
    if (currentDigits.length) {
      handleSearchChange(`${activeSeries}${currentDigits.slice(0, -1)}`);
      return;
    }
    handleSearchChange('');
    setSearchKeypadVisible(false);
  };

  const packSize = parseWholeNumber(inventoryPackSize) || data.settings.inventoryPackSize || 1000;

  const saveInventoryPackSize = () => {
    const nextPackSize = parseWholeNumber(inventoryPackSize);
    if (!nextPackSize) {
      setNotice('每份颗数需要大于 0');
      return;
    }
    updateData(
      (current) => ({
        ...current,
        settings: {
          ...current.settings,
          inventoryPackSize: nextPackSize,
        },
      }),
      '修改豆仓每份颗数',
    );
    setEditingPackSize(false);
    setNotice(`已设置豆仓每份 ${nextPackSize} 颗`);
  };

  const mutateSelected = (kind: 'amount-add' | 'amount-remove' | 'pack-add' | 'pack-remove' | 'adjust') => {
    const byPack = kind === 'pack-add' || kind === 'pack-remove';
    const quantity = parseWholeNumber(byPack ? packs : amount);
    if (!quantity) {
      setNotice('请输入大于 0 的数量');
      return;
    }
    if (byPack) {
      const delta = quantity * packSize;
      const signedDelta = kind === 'pack-add' ? delta : -delta;
      updateData(
        (current) => applyStockChange(current, selectedColor.code, signedDelta, signedDelta > 0 ? 'purchase' : 'use', `${quantity} 份${signedDelta > 0 ? '入库' : '减少'}`),
        `${selectedColor.code} ${signedDelta > 0 ? '按份增加' : '按份减少'} ${delta} 颗`,
      );
      setNotice(`${selectedColor.code} 已按 ${quantity} 份 × ${packSize} 颗${signedDelta > 0 ? '增加' : '减少'} ${delta} 颗`);
      return;
    }
    if (kind === 'adjust') {
      updateData((current) => adjustStock(current, selectedColor.code, quantity, '手动盘点'), `${selectedColor.code} 盘点为 ${quantity} 颗`);
      setNotice(`${selectedColor.code} 已盘点为 ${quantity} 颗`);
      return;
    }
    const delta = kind === 'amount-add' ? quantity : -quantity;
    updateData(
      (current) => applyStockChange(current, selectedColor.code, delta, delta > 0 ? 'purchase' : 'use', delta > 0 ? '按颗增加' : '按颗减少'),
      `${selectedColor.code} ${delta > 0 ? '增加' : '减少'} ${quantity} 颗`,
    );
    setNotice(`${selectedColor.code} ${delta > 0 ? '增加' : '减少'} ${quantity} 颗`);
  };

  const addSelectedToPurchaseList = () => {
    if (!selectedPurchaseList) {
      setNotice('请先在采购页新建采购表');
      return;
    }
    updateData((current) => addPurchaseItem(current, selectedPurchaseList.id, selectedColor.code, selectedPurchaseList.packSize), `${selectedColor.code} 加入采购清单`);
    setNotice(`${selectedColor.code} 已加入「${selectedPurchaseList.name}」×1`);
  };

  return (
    <View style={styles.inventoryScreen}>
      <View
        style={[
          styles.panel,
          styles.stickyPanel,
          compactInventory && styles.stickyPanelCompact,
          compactInventory && { maxHeight: Math.max(300, Math.min(360, viewport.height * 0.42)) },
        ]}
      >
        <ScrollView
          scrollEnabled={compactInventory}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={compactInventory}
          contentContainerStyle={compactInventory ? styles.stickyPanelContentCompact : undefined}
        >
        <View style={styles.selectedRow}>
          <ColorSwatch color={selectedColor.hex} />
          <View style={styles.flex}>
            <Text style={styles.bigCode}>{selectedColor.code}</Text>
            <Text style={styles.muted}>
              {selectedColor.nameZh || selectedColor.nameEn || '参考色名缺失'} · 当前库存 {selectedStock} 颗
            </Text>
          </View>
        </View>

        <View style={styles.inventoryActionGrid}>
          <View style={styles.inputBlockGrid}>
            <Text style={styles.label}>颗数 / 盘点值</Text>
            <View style={styles.actionInputRow}>
              <TextInput style={[styles.input, styles.actionInput]} value={amount} onChangeText={setAmount} keyboardType="number-pad" accessibilityLabel="颗数 / 盘点值" />
              <RoundActionButton label="+" accessibilityLabel="按颗增加" tone="plus" onPress={() => mutateSelected('amount-add')} />
              <RoundActionButton label="-" accessibilityLabel="按颗减少" tone="minus" onPress={() => mutateSelected('amount-remove')} />
              <Pressable style={styles.auditButton} onPress={() => mutateSelected('adjust')}>
                <Text style={styles.auditButtonText}>盘点</Text>
              </Pressable>
            </View>
          </View>
          <View style={styles.inputBlockGrid}>
            <Pressable
              style={styles.packLabelRow}
              onPress={() => {
                setInventoryPackSize(String(data.settings.inventoryPackSize));
                setEditingPackSize(true);
              }}
            >
              <Text style={styles.label}>份数</Text>
              <Text style={styles.packHint}>当前每份 {packSize} 颗</Text>
            </Pressable>
            <View style={styles.actionInputRow}>
              <TextInput style={[styles.input, styles.actionInput]} value={packs} onChangeText={setPacks} keyboardType="number-pad" accessibilityLabel="份数" />
              <RoundActionButton label="+" accessibilityLabel="按份增加" tone="plus" onPress={() => mutateSelected('pack-add')} />
              <RoundActionButton label="-" accessibilityLabel="按份减少" tone="minus" onPress={() => mutateSelected('pack-remove')} />
            </View>
          </View>
        </View>
        {editingPackSize ? (
          <View style={styles.packEditor}>
            <TextInput style={[styles.input, styles.packEditorInput]} value={inventoryPackSize} onChangeText={setInventoryPackSize} keyboardType="number-pad" accessibilityLabel="每份颗数" />
            <ActionButton label="保存" onPress={saveInventoryPackSize} />
            <ActionButton label="取消" onPress={() => setEditingPackSize(false)} tone="neutral" />
          </View>
        ) : null}

        {data.purchaseLists.length ? (
          <View style={styles.purchasePickerBlock}>
            <Text style={styles.label}>加入采购表</Text>
            <View style={styles.purchasePickerRow}>
              <Pressable accessibilityLabel="选择采购表" style={styles.purchaseSelect} onPress={() => setPurchasePickerOpen((open) => !open)}>
                <Text style={styles.purchaseSelectText}>{selectedPurchaseList?.name ?? '选择采购表'}</Text>
                <Text style={styles.purchaseSelectHint}>{purchasePickerOpen ? '收起' : '切换'}</Text>
              </Pressable>
              <ActionButton label="加入采购清单" onPress={addSelectedToPurchaseList} tone="neutral" />
            </View>
            {purchasePickerOpen ? (
              <View style={styles.purchaseDropdown}>
                {data.purchaseLists.map((list) => (
                  <Pressable
                    key={list.id}
                    style={[styles.purchaseDropdownItem, selectedPurchaseList?.id === list.id && styles.purchaseDropdownItemActive]}
                    onPress={() => {
                      setSelectedPurchaseListId(list.id);
                      setPurchasePickerOpen(false);
                    }}
                  >
                    <Text style={[styles.purchaseDropdownText, selectedPurchaseList?.id === list.id && styles.purchaseDropdownTextActive]}>{list.name}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        ) : (
          <View style={styles.purchasePickerRow}>
            <Text style={styles.muted}>还没有采购表。</Text>
            <ActionButton label="加入采购清单" onPress={addSelectedToPurchaseList} tone="neutral" />
          </View>
        )}
        </ScrollView>
      </View>

      <View style={styles.frozenFilters}>
        <View style={styles.toolbar}>
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={handleSearchChange}
            onFocus={() => {
              setSearchFocused(true);
              if (searchSeries) setSearchKeypadVisible(true);
            }}
            onBlur={() => {
              if (Platform.OS !== 'web') {
                setSearchFocused(false);
                setSearchKeypadVisible(false);
              }
            }}
            placeholder={searchSeries ? `输入数字，如 ${searchSeries}9` : '输入色系字母或色名，如 A / 浅棕'}
            autoCapitalize="characters"
            keyboardType={searchSeries ? 'number-pad' : 'default'}
            accessibilityLabel="色号搜索"
          />
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.seriesBar}>
          {['ALL', ...MARD_SERIES_ORDER].map((item) => (
            <Pressable key={item} style={[styles.seriesChip, series === item && styles.seriesChipActive]} onPress={() => selectSeries(item)}>
              <Text style={[styles.seriesText, series === item && styles.seriesTextActive]}>{item === 'ALL' ? '全部' : item}</Text>
            </Pressable>
          ))}
        </ScrollView>
        {showSearchNumberPad ? <SearchNumberPad onDigit={appendSearchDigit} onDelete={deleteSearchDigit} onDone={() => setSearchKeypadVisible(false)} /> : null}
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={styles.flex}>
        <View style={styles.list}>
          {filteredColors.map((color) => {
            const stock = getStock(data, color.code);
            const threshold = data.inventory[color.code]?.lowStockThreshold ?? data.settings.defaultLowStockThreshold;
            const low = stock > 0 && stock <= threshold;
            return (
              <Pressable key={color.code} style={[styles.colorRow, selectedColor.code === color.code && styles.colorRowActive]} onPress={() => setSelectedCode(color.code)}>
                <ColorSwatch color={color.hex} />
                <View style={styles.flex}>
                  <Text style={styles.codeText}>{color.code}</Text>
                  <Text style={styles.muted}>
                    {color.nameZh || color.nameEn || '参考色名缺失'}
                    {color.nameEn && color.nameEn !== color.code ? ` · ${color.nameEn}` : ''}
                  </Text>
                </View>
                <View style={styles.right}>
                  <Text style={styles.quantity}>{stock}</Text>
                  <Text style={[styles.miniLabel, low && styles.lowText]}>{low ? '低库存' : '颗'}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

function ProjectsScreen({
  data,
  updateData,
  setNotice,
}: {
  data: AppData;
  updateData: UpdateData;
  setNotice: ShowNotice;
}) {
  const [name, setName] = useState('');
  const [selectedId, setSelectedId] = useState<string | undefined>(data.projects[0]?.id);
  const [itemCode, setItemCode] = useState('G2');
  const [itemQty, setItemQty] = useState('100');
  const [itemNote, setItemNote] = useState('');
  const [pendingCropImageUri, setPendingCropImageUri] = useState<string | undefined>();
  const [cropBusy, setCropBusy] = useState(false);
  const [deductPreviewOpen, setDeductPreviewOpen] = useState(false);

  const selectedProject = data.projects.find((project) => project.id === selectedId) ?? data.projects[0];
  const rows = selectedProject ? buildRequirementRows(data, [selectedProject]) : [];
  const deductRequiredTotal = rows.reduce((sum, row) => sum + row.required, 0);
  const deductCoveredTotal = rows.reduce((sum, row) => sum + Math.min(row.required, row.stock), 0);
  const deductMissingTotal = rows.reduce((sum, row) => sum + row.missing, 0);

  const saveProject = (project: PatternProject, label = `更新图纸：${project.name}`) => updateData((current) => upsertProject(current, project), label);

  const addProject = () => {
    const project = createProject(name);
    updateData((current) => upsertProject(current, project), `新建图纸：${project.name}`);
    setSelectedId(project.id);
    setName('');
    setNotice('已创建图纸项目');
  };

  const addItem = () => {
    if (!selectedProject) return;
    const code = normalizeBeadCode(itemCode);
    const quantity = parseWholeNumber(itemQty);
    if (!isKnownBeadCode(code)) {
      setNotice(`未知 MARD 色号：${itemCode}`);
      return;
    }
    if (!quantity) {
      setNotice('请输入大于 0 的用量');
      return;
    }
    const existing = selectedProject.items.find((item) => normalizeBeadCode(item.code) === code);
    const items = existing
      ? selectedProject.items.map((item) => (item.id === existing.id ? { ...item, quantity: item.quantity + quantity, note: itemNote || item.note } : item))
      : [...selectedProject.items, { id: makeId('item'), code, quantity, note: itemNote } satisfies ProjectItem];
    saveProject({ ...selectedProject, items }, `${selectedProject.name} 添加 ${code}×${quantity}`);
    setItemQty('100');
    setItemNote('');
  };

  const updateItemQuantity = (itemId: string, raw: string) => {
    if (!selectedProject) return;
    const quantity = parseWholeNumber(raw);
    saveProject(
      {
        ...selectedProject,
        items: selectedProject.items.map((item) => (item.id === itemId ? { ...item, quantity } : item)),
      },
      `${selectedProject.name} 修改用量`,
    );
  };

  const removeItem = (itemId: string) => {
    if (!selectedProject) return;
    saveProject({ ...selectedProject, items: selectedProject.items.filter((item) => item.id !== itemId) }, `${selectedProject.name} 移除用量`);
  };

  const pickAndCropPatternImage = async () => {
    if (!selectedProject) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setNotice('需要相册权限才能上传图纸图片');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 1,
    });
    if (result.canceled || !result.assets?.[0]) return;
    setNotice('正在准备图纸图片...');
    try {
      const normalized = await normalizePatternImageForCrop(result.assets[0].uri);
      setPendingCropImageUri(normalized.uri);
      setNotice('请拖动裁剪框，只保留色号和数量区域，然后确认识别');
    } catch {
      setPendingCropImageUri(result.assets[0].uri);
      setNotice('图片预处理失败，已使用原图裁剪；如手机端裁剪偏移，请重新上传或换一张截图');
    }
  };

  const reopenCropFromOriginal = () => {
    if (!selectedProject?.originalImageUri) {
      setNotice('还没有可重新裁剪的原图');
      return;
    }
    setPendingCropImageUri(selectedProject.originalImageUri);
    setNotice('请重新调整裁剪框，确认后会再次 OCR');
  };

  const confirmCropAndRecognize = async (crop: CropPixels) => {
    if (!selectedProject || !pendingCropImageUri) return;
    setCropBusy(true);
    try {
      const originalImageUri = await persistProjectImage(selectedProject.id, pendingCropImageUri, 'original');
      const cropped = await cropPatternImage(pendingCropImageUri, crop);
      const ocrReady = await prepareCroppedImageForOcr(cropped.uri);
      const croppedImageUri = await persistProjectImage(selectedProject.id, ocrReady.uri, 'crop');
      setPendingCropImageUri(undefined);
      setNotice('已裁剪图纸，正在调用 OCR 识别...');
      const ocrResult = await recognizePatternDraft(croppedImageUri, { settings: data.settings });
      const items = ocrResult.status === 'ready' ? mergeRecognizedItems(selectedProject.items, ocrResult.items) : selectedProject.items;
      saveProject(
        {
          ...selectedProject,
          imageUri: croppedImageUri,
          originalImageUri,
          croppedImageUri,
          ocrStatus: ocrResult.status,
          ocrMessage: ocrResult.message,
          ocrRawText: ocrResult.rawText,
          ocrEngine: ocrResult.engine,
          ocrUpdatedAt: new Date().toISOString(),
          items,
        },
        `${selectedProject.name} 裁剪并 OCR`,
      );
      setNotice(ocrResult.message);
    } catch (error) {
      setNotice(`裁剪或 OCR 失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setCropBusy(false);
    }
  };

  const recognizeCroppedPattern = async () => {
    if (!selectedProject) return;
    const imageUri = selectedProject.croppedImageUri ?? selectedProject.imageUri;
    if (!imageUri) {
      setNotice('请先上传并裁剪图纸图片');
      return;
    }
    setNotice('正在调用 OCR 识别裁剪图...');
    const ocrReady = await prepareCroppedImageForOcr(imageUri);
    const finalImageUri = ocrReady.changed ? await persistProjectImage(selectedProject.id, ocrReady.uri, 'crop') : imageUri;
    const ocrResult = await recognizePatternDraft(finalImageUri, { settings: data.settings });
    const items = ocrResult.status === 'ready' ? mergeRecognizedItems(selectedProject.items, ocrResult.items) : selectedProject.items;
    saveProject(
      {
        ...selectedProject,
        imageUri: finalImageUri,
        croppedImageUri: finalImageUri,
        ocrStatus: ocrResult.status,
        ocrMessage: ocrResult.message,
        ocrRawText: ocrResult.rawText,
        ocrEngine: ocrResult.engine,
        ocrUpdatedAt: new Date().toISOString(),
        items,
      },
      `${selectedProject.name} OCR 识别`,
    );
    setNotice(ocrResult.message);
  };

  const openRecognitionImage = () => {
    const uri = selectedProject?.croppedImageUri ?? selectedProject?.imageUri;
    if (!uri) {
      setNotice('还没有可查看的识别图');
      return;
    }
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.open(uri, '_blank', 'noopener,noreferrer');
      return;
    }
    setNotice('当前平台暂不支持直接打开识别图');
  };

  const openDeductPreview = () => {
    if (!selectedProject) return;
    if (!selectedProject.items.length) {
      setNotice('这份图纸还没有用量，无法扣库存');
      return;
    }
    setDeductPreviewOpen(true);
  };

  const applyDeductInventory = () => {
    if (!selectedProject) return;
    updateData(
      (current) => deductProjectInventory(current, selectedProject),
      `${selectedProject.name} ${selectedProject.deductedAt ? '再次扣除库存' : '扣除库存'}`,
    );
    setDeductPreviewOpen(false);
    setNotice(deductMissingTotal ? `已扣库存；其中 ${deductMissingTotal} 颗库存不足，相关色号已扣到 0` : '已按当前用量扣除库存');
  };

  return (
    <>
      <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>新建图纸</Text>
        <View style={styles.inlineForm}>
          <TextInput style={[styles.input, styles.flex]} value={name} onChangeText={setName} placeholder="例如：小熊挂件" />
          <ActionButton label="新建" onPress={addProject} />
        </View>
      </View>

      {data.projects.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.seriesBar}>
          {data.projects.map((project) => (
            <Pressable key={project.id} style={[styles.projectChip, selectedProject?.id === project.id && styles.projectChipActive]} onPress={() => setSelectedId(project.id)}>
              <Text style={[styles.projectChipText, selectedProject?.id === project.id && styles.projectChipTextActive]}>{project.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <EmptyState title="还没有图纸项目" body="先新建一个项目，再录入图纸需要的 MARD 色号和数量。" />
      )}

      {selectedProject ? (
        <View style={styles.panel}>
          <View style={styles.panelHeader}>
            <View style={styles.flex}>
              <Text style={styles.panelTitle}>{selectedProject.name}</Text>
              <Text style={styles.muted}>
                {selectedProject.items.length} 个颜色 · {selectedProject.deductedAt ? '已扣库存' : '规划中，未扣库存'}
              </Text>
            </View>
            <Pressable
              style={styles.textButton}
              onPress={() => {
                updateData((current) => deleteProject(current, selectedProject.id), `删除图纸：${selectedProject.name}`);
                setSelectedId(data.projects.find((project) => project.id !== selectedProject.id)?.id);
              }}
            >
              <Text style={styles.dangerText}>删除</Text>
            </Pressable>
          </View>

          {selectedProject.imageUri ? <Image source={{ uri: selectedProject.imageUri }} style={styles.patternImage} /> : null}
          {selectedProject.imageUri ? <Text style={styles.muted}>上方预览为 OCR 实际识别图；裁剪后会自动加白底留边，避免超宽图片被接口压缩。</Text> : null}
          <Text style={styles.muted}>{selectedProject.ocrMessage ?? '上传图片后会先裁剪，再把识别结果写入用量草稿。'}</Text>
          <View style={styles.buttonRow}>
            <ActionButton label="上传并裁剪图纸" onPress={pickAndCropPatternImage} tone="neutral" />
            {selectedProject.originalImageUri ? <ActionButton label="重新裁剪原图" onPress={reopenCropFromOriginal} tone="neutral" /> : null}
            {selectedProject.imageUri ? <ActionButton label="查看识别图" onPress={openRecognitionImage} tone="neutral" /> : null}
            <ActionButton label="识别裁剪图" onPress={recognizeCroppedPattern} tone="amber" />
            <ActionButton label="一键扣库存" onPress={openDeductPreview} tone="danger" />
          </View>

          {deductPreviewOpen ? (
            <View style={styles.deductPreview}>
              <Text style={styles.sectionTitle}>扣库存确认</Text>
              <View style={styles.statsGrid}>
                <StatCard label="需要扣除" value={`${deductRequiredTotal}`} />
                <StatCard label="当前可扣" value={`${deductCoveredTotal}`} tone="ok" />
                <StatCard label="库存缺口" value={`${deductMissingTotal}`} tone={deductMissingTotal ? 'danger' : 'ok'} />
              </View>
              {selectedProject.deductedAt ? (
                <Text style={styles.warningText}>这份图纸已经扣除过库存。再次确认会按当前用量再扣一次，适合返工、补做或重复制作。</Text>
              ) : (
                <Text style={styles.muted}>只有确认已经开始制作、豆子实际会被消耗时再扣库存。只是规划图纸时不要确认扣除。</Text>
              )}
              {deductMissingTotal ? <Text style={styles.warningText}>库存不足的色号会扣到 0，不会出现负库存。缺口仍会保留在库存对比和采购缺口中。</Text> : null}
              <View style={styles.deductRows}>
                {rows.map((row) => {
                  const color = getColor(row.code);
                  return (
                    <View key={row.code} style={styles.deductRow}>
                      <ColorSwatch color={color?.hex ?? '#ddd'} />
                      <View style={styles.flex}>
                        <Text style={styles.codeText}>{row.code}</Text>
                        <Text style={styles.muted}>需扣 {row.required} · 当前 {row.stock} · 扣后 {Math.max(row.stock - row.required, 0)}</Text>
                      </View>
                      <View style={styles.right}>
                        <Text style={[styles.quantity, row.missing > 0 && styles.dangerText]}>{row.missing}</Text>
                        <Text style={styles.miniLabel}>缺口</Text>
                      </View>
                    </View>
                  );
                })}
              </View>
              <View style={styles.buttonRow}>
                <ActionButton label="取消" onPress={() => setDeductPreviewOpen(false)} tone="neutral" />
                <ActionButton label={selectedProject.deductedAt ? '确认再次扣除' : '确认扣除库存'} onPress={applyDeductInventory} tone="danger" />
              </View>
            </View>
          ) : null}

          <View style={styles.divider} />
          <Text style={styles.sectionTitle}>添加用量</Text>
          <View style={styles.inputGrid}>
            <LabeledInput layout="grid" label="色号" value={itemCode} onChangeText={setItemCode} autoCapitalize="characters" />
            <LabeledInput layout="grid" label="需要颗数" value={itemQty} onChangeText={setItemQty} keyboardType="number-pad" />
          </View>
          <LabeledInput label="备注" value={itemNote} onChangeText={setItemNote} placeholder="可选，例如浪费预留、替换色" />
          <ActionButton label="加入图纸用量" onPress={addItem} />

          <View style={styles.divider} />
          <Text style={styles.sectionTitle}>用量草稿</Text>
          {selectedProject.items.length ? (
            selectedProject.items.map((item) => {
              const color = getColor(item.code);
              return (
                <View key={item.id} style={styles.itemRow}>
                  <ColorSwatch color={color?.hex ?? '#ddd'} />
                  <Text style={styles.codeText}>{item.code}</Text>
                  <TextInput
                    style={[styles.input, styles.qtyInput]}
                    value={String(item.quantity || '')}
                    onChangeText={(value) => updateItemQuantity(item.id, value)}
                    keyboardType="number-pad"
                  />
                  <Pressable style={styles.textButton} onPress={() => removeItem(item.id)}>
                    <Text style={styles.dangerText}>移除</Text>
                  </Pressable>
                </View>
              );
            })
          ) : (
            <Text style={styles.muted}>暂无用量。上传 OCR 后的结果也会先进入这里，确认后再决定是否扣库存。</Text>
          )}

          <View style={styles.divider} />
          <Text style={styles.sectionTitle}>库存对比</Text>
          {rows.map((row) => (
            <RequirementLine key={row.code} row={row} />
          ))}
        </View>
      ) : null}
      </ScrollView>
      <CropModal
        visible={Boolean(pendingCropImageUri)}
        imageUri={pendingCropImageUri}
        busy={cropBusy}
        onCancel={() => {
          if (cropBusy) return;
          setPendingCropImageUri(undefined);
          setNotice('');
        }}
        onConfirm={confirmCropAndRecognize}
      />
    </>
  );
}

function ShoppingScreen({
  data,
  updateData,
  setNotice,
}: {
  data: AppData;
  updateData: UpdateData;
  setNotice: ShowNotice;
}) {
  const [selectedListId, setSelectedListId] = useState(data.purchaseLists[0]?.id);
  const [newListName, setNewListName] = useState('');
  const [itemCode, setItemCode] = useState('G2');
  const [itemQty, setItemQty] = useState('1000');
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>(data.projects.map((project) => project.id));

  const selectedList = data.purchaseLists.find((list) => list.id === selectedListId) ?? data.purchaseLists[0];
  const purchaseRows = selectedList ? buildPurchaseRows(selectedList) : [];
  const purchaseText = formatPurchaseRows(purchaseRows);
  const totalQuantity = purchaseRows.reduce((sum, row) => sum + row.quantity, 0);
  const totalPacks = purchaseRows.reduce((sum, row) => sum + row.packsToBuy, 0);
  const selectedProjects = data.projects.filter((project) => selectedProjectIds.includes(project.id));
  const selectedRequirementRows = selectedList ? buildRequirementRows(data, selectedProjects, selectedList.packSize) : [];
  const shortageRows = selectedRequirementRows.filter((row) => row.missing > 0);
  const selectedRequiredTotal = selectedRequirementRows.reduce((sum, row) => sum + row.required, 0);
  const selectedCoveredTotal = selectedRequirementRows.reduce((sum, row) => sum + Math.min(row.required, row.stock), 0);
  const selectedMissingTotal = selectedRequirementRows.reduce((sum, row) => sum + row.missing, 0);

  useEffect(() => {
    if (!selectedListId || !data.purchaseLists.some((list) => list.id === selectedListId)) {
      setSelectedListId(data.purchaseLists[0]?.id);
    }
  }, [data.purchaseLists, selectedListId]);

  useEffect(() => {
    setSelectedProjectIds((ids) => ids.filter((id) => data.projects.some((project) => project.id === id)));
  }, [data.projects]);

  const createList = () => {
    const list = createPurchaseList(newListName);
    updateData((current) => upsertPurchaseList(current, list), `新建采购表：${list.name}`);
    setSelectedListId(list.id);
    setNewListName('');
    setNotice('已新建采购表');
  };

  const removeList = () => {
    if (!selectedList) return;
    updateData((current) => deletePurchaseList(current, selectedList.id), `删除采购表：${selectedList.name}`);
    setNotice('采购表已删除，可通过历史操作撤销');
  };

  const updateSelectedList = (patch: Partial<PurchaseList>, label = selectedList ? `更新采购表：${selectedList.name}` : '更新采购表') => {
    if (!selectedList) return;
    updateData((current) => upsertPurchaseList(current, { ...selectedList, ...patch }), label);
  };

  const addManualItem = () => {
    if (!selectedList) return;
    const code = normalizeBeadCode(itemCode);
    const quantity = parseWholeNumber(itemQty);
    if (!isKnownBeadCode(code)) {
      setNotice(`未知 MARD 色号：${itemCode}`);
      return;
    }
    if (!quantity) {
      setNotice('请输入大于 0 的采购颗数');
      return;
    }
    updateData((current) => addPurchaseItem(current, selectedList.id, code, quantity), `${selectedList.name} 添加 ${code}×${quantity}`);
    setNotice(`${code} 已加入「${selectedList.name}」`);
  };

  const copyList = async () => {
    if (!purchaseText) {
      setNotice('当前采购表没有采购项');
      return;
    }
    await Clipboard.setStringAsync(purchaseText);
    setNotice('采购清单已复制');
  };

  const toggleProject = (projectId: string) => {
    setSelectedProjectIds((ids) => (ids.includes(projectId) ? ids.filter((id) => id !== projectId) : [...ids, projectId]));
  };

  const addShortage = () => {
    if (!selectedList) return;
    if (!shortageRows.length) {
      setNotice('选中图纸没有缺口可加入');
      return;
    }
    updateData((current) => addProjectShortageToPurchaseList(current, selectedList.id, selectedProjects), `${selectedList.name} 加入图纸缺口`);
    setNotice('已把选中图纸缺口加入当前采购表');
  };

  return (
    <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>采购表</Text>
        <View style={styles.inlineForm}>
          <TextInput style={[styles.input, styles.flex]} value={newListName} onChangeText={setNewListName} placeholder="例如：6月补豆" accessibilityLabel="采购表名称" />
          <ActionButton label="新建" onPress={createList} />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.seriesBar}>
          {data.purchaseLists.map((list) => (
            <Pressable key={list.id} style={[styles.projectChip, selectedList?.id === list.id && styles.projectChipActive]} onPress={() => setSelectedListId(list.id)}>
              <Text style={[styles.projectChipText, selectedList?.id === list.id && styles.projectChipTextActive]}>{list.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {selectedList ? (
        <>
          <View style={styles.panel}>
            <View style={styles.panelHeader}>
              <View style={styles.flex}>
                <Text style={styles.panelTitle}>{selectedList.name}</Text>
                <Text style={styles.muted}>
                  {purchaseRows.length} 个颜色 · 合计 {totalQuantity} 颗 · {totalPacks} 份
                </Text>
              </View>
              <Pressable style={styles.textButton} onPress={removeList}>
                <Text style={styles.dangerText}>删除</Text>
              </Pressable>
            </View>
            <LabeledInput
              label="采购每份颗数"
              value={String(selectedList.packSize || '')}
              onChangeText={(value) => updateSelectedList({ packSize: parseWholeNumber(value) || 1 }, `${selectedList.name} 修改每份颗数`)}
              keyboardType="number-pad"
            />
            <Text style={styles.helpText}>当前采购表按 1 份 = {selectedList.packSize} 颗计算，输出格式保持 G2×1。</Text>
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>手动添加</Text>
            <View style={styles.inputGrid}>
              <LabeledInput layout="grid" label="采购色号" value={itemCode} onChangeText={setItemCode} autoCapitalize="characters" />
              <LabeledInput layout="grid" label="采购颗数" value={itemQty} onChangeText={setItemQty} keyboardType="number-pad" />
            </View>
            <ActionButton label="加入采购表" onPress={addManualItem} />
          </View>

          <View style={styles.panel}>
            <View style={styles.panelHeader}>
              <View>
                <Text style={styles.panelTitle}>可复制清单</Text>
                <Text style={styles.muted}>按当前采购表每份颗数向上取整。</Text>
              </View>
              <ActionButton label="复制" onPress={copyList} />
            </View>
            <View style={styles.purchaseBox}>
              <Text style={styles.purchaseText}>{purchaseText || '暂无采购项'}</Text>
            </View>
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>采购项编辑</Text>
            {selectedList.items.length ? (
              selectedList.items.map((item) => {
                const color = getColor(item.code);
                const packsToBuy = Math.ceil((item.quantity || 0) / Math.max(1, selectedList.packSize || 1));
                return (
                  <View key={item.id} style={styles.itemRow}>
                    <ColorSwatch color={color?.hex ?? '#ddd'} />
                    <View style={styles.flex}>
                      <Text style={styles.codeText}>{item.code}</Text>
                      <Text style={styles.muted}>{color?.nameZh || color?.nameEn || '参考色名缺失'} · {packsToBuy} 份</Text>
                    </View>
                    <TextInput
                      style={[styles.input, styles.qtyInput]}
                      value={String(item.quantity || '')}
                      onChangeText={(value) =>
                        updateData((current) => setPurchaseItemQuantity(current, selectedList.id, item.id, parseWholeNumber(value)), `${selectedList.name} 修改 ${item.code} 采购颗数`)
                      }
                      keyboardType="number-pad"
                      accessibilityLabel={`${item.code}采购颗数`}
                    />
                    <Pressable
                      style={styles.textButton}
                      onPress={() => updateData((current) => removePurchaseItem(current, selectedList.id, item.id), `${selectedList.name} 移除 ${item.code}`)}
                    >
                      <Text style={styles.dangerText}>移除</Text>
                    </Pressable>
                  </View>
                );
              })
            ) : (
              <Text style={styles.muted}>暂无采购项。可以手动添加，也可以从图纸缺口导入。</Text>
            )}
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>从图纸缺口加入</Text>
            <Text style={styles.muted}>选中多个图纸后，会按当前库存计算缺口，并把缺口颗数加入当前采购表。</Text>
            <View style={styles.buttonRow}>
              <ActionButton label="全选图纸" onPress={() => setSelectedProjectIds(data.projects.map((project) => project.id))} tone="neutral" />
              <ActionButton label="清空" onPress={() => setSelectedProjectIds([])} tone="neutral" />
              <ActionButton label="加入缺口" onPress={addShortage} tone="amber" />
            </View>
            {data.projects.length ? (
              data.projects.map((project) => (
                <Pressable key={project.id} style={styles.checkRow} onPress={() => toggleProject(project.id)}>
                  <View style={[styles.checkbox, selectedProjectIds.includes(project.id) && styles.checkboxActive]}>
                    <Text style={styles.checkboxText}>{selectedProjectIds.includes(project.id) ? '✓' : ''}</Text>
                  </View>
                  <View style={styles.flex}>
                    <Text style={styles.codeText}>{project.name}</Text>
                    <Text style={styles.muted}>{project.items.length} 个颜色</Text>
                  </View>
                </Pressable>
              ))
            ) : (
              <Text style={styles.muted}>还没有图纸项目。</Text>
            )}
            {shortageRows.length ? (
              <View style={styles.inlineStats}>
                <Text style={styles.muted}>当前选中图纸缺 {shortageRows.reduce((sum, row) => sum + row.missing, 0)} 颗。</Text>
              </View>
            ) : null}
            {selectedProjects.length ? (
              <View style={styles.requirementCompare}>
                <Text style={styles.sectionTitle}>选中图纸库存对比</Text>
                <View style={styles.statsGrid}>
                  <StatCard label="需要" value={`${selectedRequiredTotal}`} />
                  <StatCard label="库存可用" value={`${selectedCoveredTotal}`} tone="ok" />
                  <StatCard label="缺口" value={`${selectedMissingTotal}`} tone={selectedMissingTotal ? 'danger' : 'ok'} />
                </View>
                {selectedRequirementRows.length ? (
                  selectedRequirementRows.map((row) => <RequirementLine key={row.code} row={row} showPacks />)
                ) : (
                  <Text style={styles.muted}>选中的图纸还没有录入用量。</Text>
                )}
              </View>
            ) : null}
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}

function SettingsScreen({
  data,
  updateData,
  setNotice,
}: {
  data: AppData;
  updateData: UpdateData;
  setNotice: ShowNotice;
}) {
  const [threshold, setThreshold] = useState(String(data.settings.defaultLowStockThreshold));
  const [aiOcrApiKey, setAiOcrApiKey] = useState(data.settings.aiOcrApiKey);
  const [aiOcrEndpoint, setAiOcrEndpoint] = useState(data.settings.aiOcrEndpoint);
  const [aiOcrModel, setAiOcrModel] = useState(data.settings.aiOcrModel);
  const [aiOcrTextApiKey, setAiOcrTextApiKey] = useState(data.settings.aiOcrTextApiKey);
  const [aiOcrTextEndpoint, setAiOcrTextEndpoint] = useState(data.settings.aiOcrTextEndpoint);
  const [aiOcrTextModel, setAiOcrTextModel] = useState(data.settings.aiOcrTextModel);
  const [aiOcrUseSameKey, setAiOcrUseSameKey] = useState(data.settings.aiOcrUseSameKey);
  const [resetCountdown, setResetCountdown] = useState(0);
  const [resetReady, setResetReady] = useState(false);

  useEffect(() => {
    if (resetCountdown <= 0) return;
    const timer = setTimeout(() => {
      setResetCountdown((current) => {
        if (current <= 1) {
          setResetReady(true);
          return 0;
        }
        return current - 1;
      });
    }, 1000);
    return () => clearTimeout(timer);
  }, [resetCountdown]);

  useEffect(() => {
    setThreshold(String(data.settings.defaultLowStockThreshold));
    setAiOcrApiKey(data.settings.aiOcrApiKey || 'helloworld');
    setAiOcrEndpoint(data.settings.aiOcrEndpoint || 'https://api.ocr.space/parse/image');
    setAiOcrModel(data.settings.aiOcrModel || 'ocr.space-engine2');
    setAiOcrTextApiKey(data.settings.aiOcrTextApiKey);
    setAiOcrTextEndpoint(data.settings.aiOcrTextEndpoint);
    setAiOcrTextModel(data.settings.aiOcrTextModel);
    setAiOcrUseSameKey(data.settings.aiOcrEndpoint?.includes('ocr.space') ? false : data.settings.aiOcrUseSameKey);
  }, [data.settings]);

  const saveSettings = () => {
    const nextThreshold = parseWholeNumber(threshold);
    updateData(
      (current) => ({
        ...current,
        settings: {
          ...current.settings,
          defaultLowStockThreshold: nextThreshold,
        },
      }),
      '修改默认低库存阈值',
    );
    setNotice('设置已保存');
  };

  const saveAiOcrSettings = () => {
    updateData(
      (current) => ({
        ...current,
        settings: {
          ...current.settings,
          aiOcrApiKey: aiOcrApiKey.trim(),
          aiOcrEndpoint: aiOcrEndpoint.trim() || 'https://api.ocr.space/parse/image',
          aiOcrModel: aiOcrModel.trim() || 'ocr.space-engine2',
          aiOcrTextApiKey: aiOcrUseSameKey ? '' : aiOcrTextApiKey.trim(),
          aiOcrTextEndpoint: aiOcrTextEndpoint.trim() || 'https://api.deepseek.com/chat/completions',
          aiOcrTextModel: aiOcrTextModel.trim() || 'deepseek-v4-flash',
          aiOcrUseSameKey,
        },
      }),
      '修改 OCR 接口设置',
    );
    setNotice('OCR 接口设置已保存');
  };

  const copyBackup = async () => {
    await Clipboard.setStringAsync(exportAppData(data));
    setNotice('备份数据已复制到剪贴板');
  };

  const exportBackup = async () => {
    const exported = await exportBackupFile(data);
    setNotice(exported);
  };

  const importBackup = async () => {
    const raw = await Clipboard.getStringAsync();
    const parsed = parseImportedData(raw);
    if (!parsed) {
      setNotice('剪贴板里不是有效的豆仓备份 JSON');
      return;
    }
    Alert.alert('导入备份', '导入会覆盖当前本地数据。确定继续吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '确认导入',
        style: 'destructive',
        onPress: () => {
          updateData(() => parsed, '导入备份');
          setNotice('已导入备份');
        },
      },
    ]);
  };

  const resetLocalData = () => {
    if (!resetReady) {
      setResetCountdown(3);
      setNotice('请等待倒计时结束后再次确认清空');
      return;
    }
    updateData(() => createEmptyData(), '清空本地数据');
    setResetReady(false);
    setResetCountdown(0);
    setNotice('本地数据已清空，可通过历史操作撤销');
  };

  const undoHistory = (historyId: string, label: string) => {
    updateData((current) => undoSingleHistoryEntry(current, historyId), `撤销历史：${label}`, { recordHistory: false });
    setNotice(`已撤销：${label}`);
  };

  const rollbackHistory = (historyId: string, label: string) => {
    updateData((current) => rollbackToHistoryEntry(current, historyId), `回退历史：${label}`, { recordHistory: false });
    setNotice(`已回退到「${label}」发生前`);
  };

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>库存设置</Text>
        <LabeledInput label="默认低库存阈值" value={threshold} onChangeText={setThreshold} keyboardType="number-pad" />
        <ActionButton label="保存设置" onPress={saveSettings} />
      </View>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>OCR 接口</Text>
        <Text style={styles.muted}>
          默认使用 OCR.space 免费测试接口先走通图片 OCR；文本整理可以继续接 DeepSeek 或其他 OpenAI-compatible 文本模型。OCR.space 免费测试 key 是
          helloworld，稳定使用建议换成自己的免费 key。
        </Text>
        <LabeledInput label="OCR API Key" value={aiOcrApiKey} onChangeText={setAiOcrApiKey} placeholder="helloworld" secureTextEntry autoCapitalize="none" />
        <LabeledInput
          label="OCR Endpoint"
          value={aiOcrEndpoint}
          onChangeText={setAiOcrEndpoint}
          placeholder="https://api.ocr.space/parse/image"
          autoCapitalize="none"
        />
        <LabeledInput label="OCR 引擎/模型" value={aiOcrModel} onChangeText={setAiOcrModel} placeholder="ocr.space-engine2" autoCapitalize="none" />
        <Pressable style={styles.checkRow} onPress={() => setAiOcrUseSameKey((current) => !current)}>
          <View style={[styles.checkbox, aiOcrUseSameKey && styles.checkboxActive]}>
            <Text style={styles.checkboxText}>{aiOcrUseSameKey ? '✓' : ''}</Text>
          </View>
          <View style={styles.flex}>
            <Text style={styles.codeText}>文本模型复用 OCR API Key</Text>
            <Text style={styles.muted}>关闭后可以为 deepseek-flash / deepseek-v4-flash 单独填写 key。</Text>
          </View>
        </Pressable>
        {aiOcrUseSameKey ? null : (
          <LabeledInput label="文本 API Key" value={aiOcrTextApiKey} onChangeText={setAiOcrTextApiKey} placeholder="sk-..." secureTextEntry autoCapitalize="none" />
        )}
        <LabeledInput
          label="文本 Endpoint"
          value={aiOcrTextEndpoint}
          onChangeText={setAiOcrTextEndpoint}
          placeholder="https://api.deepseek.com/chat/completions"
          autoCapitalize="none"
        />
        <LabeledInput label="文本模型" value={aiOcrTextModel} onChangeText={setAiOcrTextModel} placeholder="deepseek-v4-flash" autoCapitalize="none" />
        <ActionButton label="保存 OCR 设置" onPress={saveAiOcrSettings} tone="amber" />
      </View>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>数据备份</Text>
        <Text style={styles.muted}>本版数据全部保存在本机。备份会导出结构化 JSON，库存记录按色号排序，方便后续迁移。</Text>
        <View style={styles.buttonRow}>
          <ActionButton label="复制备份" onPress={copyBackup} />
          <ActionButton label="导出备份文件" onPress={exportBackup} tone="neutral" />
          <ActionButton label="从剪贴板导入" onPress={importBackup} tone="amber" />
        </View>
      </View>

      <View style={styles.panel}>
        <View style={styles.panelHeader}>
          <View style={styles.flex}>
            <Text style={styles.panelTitle}>历史操作</Text>
            <Text style={styles.muted}>单条撤销只反向恢复该条影响；回退会恢复到该操作发生前的完整状态。</Text>
          </View>
        </View>
        {data.actionHistory.length ? (
          data.actionHistory.slice(0, 30).map((entry) => (
            <View key={entry.id} style={styles.historyRow}>
              <View style={styles.flex}>
                <Text style={[styles.codeText, entry.undoneAt && styles.historyUndone]}>{entry.label}</Text>
                <Text style={styles.muted}>
                  {formatHistoryTime(entry.createdAt)}
                  {entry.undoneAt ? ` · 已恢复 ${formatHistoryTime(entry.undoneAt)}` : ''}
                </Text>
              </View>
              <View style={styles.historyActions}>
                <Pressable style={[styles.smallAction, entry.undoneAt && styles.smallActionDisabled]} disabled={Boolean(entry.undoneAt)} onPress={() => undoHistory(entry.id, entry.label)}>
                  <Text style={styles.smallActionText}>撤销</Text>
                </Pressable>
                <Pressable style={styles.smallAction} onPress={() => rollbackHistory(entry.id, entry.label)}>
                  <Text style={styles.smallActionText}>回退</Text>
                </Pressable>
              </View>
            </View>
          ))
        ) : (
          <Text style={styles.muted}>还没有历史操作。</Text>
        )}
      </View>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>色表来源</Text>
        <Text style={styles.muted}>
          当前内置 MARD 291：A-M 基础 221 色，P/Q/R/T/Y/ZG 扩展 70 色。HEX 只用于屏幕近似展示，库存和采购以色号为准。参考色名来自 Pixel Pattern
          的 MARD 291 code/name 表。
        </Text>
      </View>

      <Pressable style={[styles.resetButton, resetReady && styles.resetButtonReady]} onPress={resetLocalData}>
        <Text style={styles.dangerText}>
          {resetCountdown > 0 ? `${resetCountdown} 秒后可确认清空` : resetReady ? '确认清空全部本地数据' : '清空本地数据'}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

function mergeRecognizedItems(currentItems: ProjectItem[], recognizedItems: Array<{ code: string; quantity: number }>) {
  const nextItems = [...currentItems];
  for (const item of recognizedItems) {
    const code = tryNormalizeBeadCode(item.code);
    const quantity = clampWholeNumber(item.quantity);
    if (!code || !quantity) continue;
    const existingIndex = nextItems.findIndex((current) => normalizeBeadCode(current.code) === code);
    if (existingIndex >= 0) {
      nextItems[existingIndex] = { ...nextItems[existingIndex], code, quantity, note: nextItems[existingIndex].note || 'OCR 识别' };
    } else {
      nextItems.push({ id: makeId('item'), code, quantity, note: 'OCR 识别' });
    }
  }
  return nextItems;
}

async function persistProjectImage(projectId: string, uri: string, kind = 'image') {
  try {
    const directory = new Directory(Paths.document, 'pattern-images');
    if (!directory.exists) directory.create();
    const source = new File(uri);
    const extension = source.extension || '.jpg';
    const target = new File(directory, `${projectId}-${kind}-${Date.now()}${extension}`);
    await source.copy(target);
    return target.uri;
  } catch {
    return uri;
  }
}

async function normalizePatternImageForCrop(uri: string) {
  if (isWebCanvasAvailable()) {
    // On web, we normalize the image through canvas so that display sizing and cropping
    // both work from identical, fully-decoded pixel dimensions. This also bakes in any
    // EXIF orientation the browser applied and caps very large phone photos so toDataURL
    // doesn't blow up memory on mobile.
    try {
      const image = await loadWebImage(uri);
      const sourceWidth = getLoadedImageWidth(image);
      const sourceHeight = getLoadedImageHeight(image);
      if (!sourceWidth || !sourceHeight) return { uri };
      const maxSide = 2200;
      const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
      const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
      const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const context = get2dContext(canvas);
      context.drawImage(image, 0, 0, sourceWidth, sourceHeight, 0, 0, targetWidth, targetHeight);
      return { uri: canvas.toDataURL('image/png') };
    } catch {
      return { uri };
    }
  }
  return ImageManipulator.manipulateAsync(
    uri,
    [],
    { compress: 1, format: ImageManipulator.SaveFormat.PNG },
  );
}

async function cropPatternImage(uri: string, crop: CropPixels) {
  const safeCrop: CropPixels = {
    originX: Math.max(0, Math.floor(crop.originX)),
    originY: Math.max(0, Math.floor(crop.originY)),
    width: Math.max(1, Math.floor(crop.width)),
    height: Math.max(1, Math.floor(crop.height)),
  };
  if (isWebCanvasAvailable()) {
    return cropPatternImageOnWeb(uri, safeCrop);
  }
  return ImageManipulator.manipulateAsync(
    uri,
    [{ crop: safeCrop }],
    { compress: 1, format: ImageManipulator.SaveFormat.PNG },
  );
}

async function prepareCroppedImageForOcr(uri: string) {
  if (!isWebCanvasAvailable()) return { uri, changed: false };
  const image = await loadWebImage(uri);
  const sourceWidth = getLoadedImageWidth(image);
  const sourceHeight = getLoadedImageHeight(image);
  if (!sourceWidth || !sourceHeight) return { uri, changed: false };

  const maxCanvasSide = 2600;
  const padding = 32;
  const maxOutputAspect = 3.5;
  const maxContentSide = maxCanvasSide - padding * 2;
  const minReadableShortSide = 420;
  const sourceLongSide = Math.max(sourceWidth, sourceHeight);
  const sourceShortSide = Math.min(sourceWidth, sourceHeight);
  let scale = Math.max(1, minReadableShortSide / sourceShortSide);
  scale = Math.min(scale, maxContentSide / sourceLongSide);

  const outputWidth = Math.max(1, Math.round(sourceWidth * scale));
  const outputHeight = Math.max(1, Math.round(sourceHeight * scale));
  let canvasWidth = outputWidth + padding * 2;
  let canvasHeight = outputHeight + padding * 2;
  if (canvasWidth / canvasHeight > maxOutputAspect) canvasHeight = Math.ceil(canvasWidth / maxOutputAspect);
  if (canvasHeight / canvasWidth > maxOutputAspect) canvasWidth = Math.ceil(canvasHeight / maxOutputAspect);

  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const context = get2dContext(canvas);
  context.fillStyle = '#FFFFFF';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(
    image,
    0,
    0,
    sourceWidth,
    sourceHeight,
    Math.round((canvasWidth - outputWidth) / 2),
    Math.round((canvasHeight - outputHeight) / 2),
    outputWidth,
    outputHeight,
  );

  return {
    uri: canvas.toDataURL('image/png'),
    changed: true,
  };
}

async function cropPatternImageOnWeb(uri: string, crop: CropPixels) {
  const image = await loadWebImage(uri);
  const sourceWidth = getLoadedImageWidth(image);
  const sourceHeight = getLoadedImageHeight(image);
  const originX = Math.min(Math.max(0, crop.originX), Math.max(0, sourceWidth - 1));
  const originY = Math.min(Math.max(0, crop.originY), Math.max(0, sourceHeight - 1));
  const width = Math.min(crop.width, sourceWidth - originX);
  const height = Math.min(crop.height, sourceHeight - originY);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(width));
  canvas.height = Math.max(1, Math.floor(height));
  const context = get2dContext(canvas);
  context.fillStyle = '#FFFFFF';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, originX, originY, width, height, 0, 0, canvas.width, canvas.height);
  return {
    uri: canvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height,
  };
}

function isWebCanvasAvailable() {
  return Platform.OS === 'web' && typeof document !== 'undefined';
}

function loadWebImage(uri: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = document.createElement('img');
    image.onload = async () => {
      // Wait for full decode to ensure naturalWidth/naturalHeight are accurate
      // This is especially important on mobile browsers
      try {
        if (typeof image.decode === 'function') {
          await image.decode();
        }
      } catch {
        // decode() may fail on some browsers, but image should still be usable
      }
      resolve(image);
    };
    image.onerror = () => reject(new Error('图片加载失败，无法裁剪'));
    image.decoding = 'async';
    image.src = uri;
  });
}

function getLoadedImageWidth(image: HTMLImageElement) {
  return image.naturalWidth || image.width;
}

function getLoadedImageHeight(image: HTMLImageElement) {
  return image.naturalHeight || image.height;
}

function get2dContext(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持 Canvas 图片处理');
  return context;
}

async function exportBackupFile(data: AppData) {
  const fileName = `appPindou-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const content = exportAppData(data);
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    return `已导出备份文件：${fileName}`;
  }
  const target = new File(Paths.document, fileName);
  target.write(content);
  return `备份文件已保存：${target.uri}`;
}

function formatHistoryTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function RequirementLine({ row, showPacks = false }: { row: ReturnType<typeof buildRequirementRows>[number]; showPacks?: boolean }) {
  const color = getColor(row.code);
  return (
    <View style={styles.requirementRow}>
      <ColorSwatch color={color?.hex ?? '#ddd'} />
      <View style={styles.flex}>
        <Text style={styles.codeText}>{row.code}</Text>
        <Text style={styles.muted}>
          需要 {row.required} · 库存 {row.stock}
        </Text>
      </View>
      <View style={styles.right}>
        <Text style={[styles.quantity, row.missing > 0 && styles.dangerText]}>{row.missing}</Text>
        <Text style={styles.miniLabel}>{showPacks ? `${row.packsToBuy} 份` : '缺口'}</Text>
      </View>
    </View>
  );
}

function LabeledInput({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoCapitalize,
  secureTextEntry,
  layout = 'block',
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'number-pad';
  autoCapitalize?: 'none' | 'characters';
  secureTextEntry?: boolean;
  layout?: 'block' | 'grid';
}) {
  return (
    <View style={[styles.inputBlock, layout === 'grid' && styles.inputBlockGrid]}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        secureTextEntry={secureTextEntry}
      />
    </View>
  );
}

function ActionButton({ label, onPress, tone = 'primary' }: { label: string; onPress: () => void; tone?: 'primary' | 'amber' | 'danger' | 'neutral' }) {
  return (
    <Pressable style={[styles.actionButton, styles[`button_${tone}`]]} onPress={onPress}>
      <Text style={[styles.actionButtonText, tone === 'neutral' && styles.neutralButtonText]}>{label}</Text>
    </Pressable>
  );
}

function SearchNumberPad({ onDigit, onDelete, onDone }: { onDigit: (digit: string) => void; onDelete: () => void; onDone: () => void }) {
  return (
    <View style={styles.numberPad}>
      {NUMBER_PAD_KEYS.map((key) => (
        <Pressable key={key} accessibilityLabel={`输入数字${key}`} style={styles.numberPadKey} onPress={() => onDigit(key)}>
          <Text style={styles.numberPadText}>{key}</Text>
        </Pressable>
      ))}
      <Pressable accessibilityLabel="搜索删除" style={styles.numberPadKey} onPress={onDelete}>
        <Text style={styles.numberPadText}>删除</Text>
      </Pressable>
      <Pressable accessibilityLabel="搜索完成" style={styles.numberPadKey} onPress={onDone}>
        <Text style={styles.numberPadText}>完成</Text>
      </Pressable>
    </View>
  );
}

function RoundActionButton({
  label,
  accessibilityLabel,
  tone,
  onPress,
}: {
  label: '+' | '-';
  accessibilityLabel: string;
  tone: 'plus' | 'minus';
  onPress: () => void;
}) {
  return (
    <Pressable accessibilityLabel={accessibilityLabel} style={[styles.roundAction, tone === 'plus' ? styles.roundActionPlus : styles.roundActionMinus]} onPress={onPress}>
      <Text style={styles.roundActionText}>{label}</Text>
    </Pressable>
  );
}

function ColorSwatch({ color }: { color: string }) {
  return <View style={[styles.swatch, { backgroundColor: color }]} />;
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: 'danger' | 'ok' }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={[styles.statValue, tone === 'danger' && styles.dangerText, tone === 'ok' && styles.okText]}>{value}</Text>
    </View>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.muted}>{body}</Text>
    </View>
  );
}

function CropModal({
  visible,
  imageUri,
  busy,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  imageUri?: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (crop: CropPixels) => void;
}) {
  const viewport = useWindowDimensions();
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [cropRect, setCropRect] = useState<DisplayCropRect>({ x: 0, y: 0, width: 1, height: 1 });
  const cropRef = useRef(cropRect);
  const panStartRef = useRef(cropRect);
  const maxCanvasWidth = Math.min(Math.max(viewport.width - 32, 260), 398);
  const maxCanvasHeight = Math.min(Math.max(viewport.height * 0.43, 220), 420);

  useEffect(() => {
    cropRef.current = cropRect;
  }, [cropRect]);

  useEffect(() => {
    if (!visible || !imageUri) return;
    // On web, use loadWebImage to get naturalWidth/naturalHeight consistently
    // This ensures the same dimensions are used for display and cropping
    if (isWebCanvasAvailable()) {
      loadWebImage(imageUri)
        .then((image) => {
          const width = getLoadedImageWidth(image);
          const height = getLoadedImageHeight(image);
          setImageSize({ width, height });
        })
        .catch(() => setImageSize({ width: 0, height: 0 }));
    } else {
      Image.getSize(
        imageUri,
        (width, height) => setImageSize({ width, height }),
        () => setImageSize({ width: 0, height: 0 }),
      );
    }
  }, [imageUri, visible]);

  const displaySize = useMemo(() => {
    if (!imageSize.width || !imageSize.height) return { width: maxCanvasWidth, height: Math.min(maxCanvasHeight, 260) };
    const scale = Math.min(maxCanvasWidth / imageSize.width, maxCanvasHeight / imageSize.height);
    return {
      width: Math.max(1, imageSize.width * scale),
      height: Math.max(1, imageSize.height * scale),
    };
  }, [imageSize.height, imageSize.width, maxCanvasHeight, maxCanvasWidth]);

  const resetCropRect = () => {
    setCropRect({
      x: 0,
      y: 0,
      width: Math.max(48, displaySize.width),
      height: Math.max(48, displaySize.height),
    });
  };

  useEffect(() => {
    if (visible) resetCropRect();
  }, [displaySize.height, displaySize.width, imageUri, visible]);

  const clampCrop = (rect: DisplayCropRect) => clampDisplayCropRect(rect, displaySize.width, displaySize.height);

  const updateCropFromGesture = (mode: CropGestureMode, start: DisplayCropRect, dx: number, dy: number) => {
    setCropRect(clampCrop(getGestureCropRect(mode, start, dx, dy)));
  };

  const makeCropResponder = (mode: CropGestureMode) =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => !busy,
      onMoveShouldSetPanResponder: () => !busy,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponderCapture: () => false,
      onPanResponderGrant: () => {
        panStartRef.current = cropRef.current;
      },
      onPanResponderMove: (_event, gesture) => {
        updateCropFromGesture(mode, panStartRef.current, gesture.dx, gesture.dy);
      },
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
    });

  const makeWebPointerHandlers = (mode: CropGestureMode) => {
    if (Platform.OS !== 'web') return {};
    return {
      onPointerDown: (event: any) => {
        if (busy) return;
        event.preventDefault?.();
        event.stopPropagation?.();
        const pointerId = event.pointerId;
        const currentTarget = event.currentTarget;
        if (typeof currentTarget?.setPointerCapture === 'function' && pointerId !== undefined) {
          try {
            currentTarget.setPointerCapture(pointerId);
          } catch {
            // Some mobile browsers reject pointer capture after synthetic events.
          }
        }
        const start = cropRef.current;
        const startX = event.clientX ?? event.pageX ?? 0;
        const startY = event.clientY ?? event.pageY ?? 0;
        const move = (moveEvent: PointerEvent) => {
          if (pointerId !== undefined && moveEvent.pointerId !== pointerId) return;
          moveEvent.preventDefault?.();
          updateCropFromGesture(mode, start, moveEvent.clientX - startX, moveEvent.clientY - startY);
        };
        const stop = (stopEvent: PointerEvent) => {
          if (pointerId !== undefined && stopEvent.pointerId !== pointerId) return;
          if (typeof currentTarget?.releasePointerCapture === 'function' && pointerId !== undefined) {
            try {
              currentTarget.releasePointerCapture(pointerId);
            } catch {
              // Pointer capture may already be released by the browser.
            }
          }
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
          window.removeEventListener('pointercancel', stop);
        };
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', stop);
        window.addEventListener('pointercancel', stop);
      },
    };
  };

  const moveResponder = useMemo(() => makeCropResponder('move'), [busy, displaySize.height, displaySize.width]);
  const topLeftResponder = useMemo(() => makeCropResponder('top-left'), [busy, displaySize.height, displaySize.width]);
  const topRightResponder = useMemo(() => makeCropResponder('top-right'), [busy, displaySize.height, displaySize.width]);
  const bottomLeftResponder = useMemo(() => makeCropResponder('bottom-left'), [busy, displaySize.height, displaySize.width]);
  const bottomRightResponder = useMemo(() => makeCropResponder('bottom-right'), [busy, displaySize.height, displaySize.width]);
  const moveNativeHandlers = Platform.OS === 'web' ? {} : moveResponder.panHandlers;
  const topLeftNativeHandlers = Platform.OS === 'web' ? {} : topLeftResponder.panHandlers;
  const topRightNativeHandlers = Platform.OS === 'web' ? {} : topRightResponder.panHandlers;
  const bottomLeftNativeHandlers = Platform.OS === 'web' ? {} : bottomLeftResponder.panHandlers;
  const bottomRightNativeHandlers = Platform.OS === 'web' ? {} : bottomRightResponder.panHandlers;
  const moveWebHandlers = useMemo(() => makeWebPointerHandlers('move'), [busy, displaySize.height, displaySize.width]);
  const topLeftWebHandlers = useMemo(() => makeWebPointerHandlers('top-left'), [busy, displaySize.height, displaySize.width]);
  const topRightWebHandlers = useMemo(() => makeWebPointerHandlers('top-right'), [busy, displaySize.height, displaySize.width]);
  const bottomLeftWebHandlers = useMemo(() => makeWebPointerHandlers('bottom-left'), [busy, displaySize.height, displaySize.width]);
  const bottomRightWebHandlers = useMemo(() => makeWebPointerHandlers('bottom-right'), [busy, displaySize.height, displaySize.width]);

  const adjustCrop = (producer: (rect: DisplayCropRect) => DisplayCropRect) => {
    if (busy) return;
    setCropRect((current) => clampCrop(producer(current)));
  };

  const nudgeCrop = (dx: number, dy: number) => {
    adjustCrop((rect) => ({ ...rect, x: rect.x + dx, y: rect.y + dy }));
  };

  const resizeCrop = (deltaWidth: number, deltaHeight: number) => {
    adjustCrop((rect) => ({
      x: rect.x - deltaWidth / 2,
      y: rect.y - deltaHeight / 2,
      width: rect.width + deltaWidth,
      height: rect.height + deltaHeight,
    }));
  };

  const confirmCrop = () => {
    if (!imageSize.width || !imageSize.height || busy) return;
    const scaleX = imageSize.width / displaySize.width;
    const scaleY = imageSize.height / displaySize.height;
    const originX = Math.max(0, Math.floor(cropRect.x * scaleX));
    const originY = Math.max(0, Math.floor(cropRect.y * scaleY));
    const width = Math.min(imageSize.width - originX, Math.max(1, Math.floor(cropRect.width * scaleX)));
    const height = Math.min(imageSize.height - originY, Math.max(1, Math.floor(cropRect.height * scaleY)));
    onConfirm({ originX, originY, width, height });
  };

  const cropContent = (
    <View style={styles.cropModalPanel}>
      <View style={styles.cropTitleRow}>
        <View style={styles.flex}>
          <Text style={styles.panelTitle}>裁剪图纸</Text>
          <Text style={styles.muted}>拖动裁剪框，只保留色号和数量区域。</Text>
        </View>
      </View>
      <View style={[styles.cropCanvas, { width: displaySize.width, height: displaySize.height }]}>
        {imageUri ? <Image source={{ uri: imageUri }} style={[styles.cropImage, { width: displaySize.width, height: displaySize.height }]} resizeMode="contain" /> : null}
        <View style={[styles.cropSelection, { left: cropRect.x, top: cropRect.y, width: cropRect.width, height: cropRect.height }]}>
          {Platform.OS === 'web' ? (
            <>
              {createElement(
                'div',
                { 'aria-label': '拖动裁剪框', style: webCropMovePadStyle, ...moveWebHandlers },
                createElement('span', { style: webCropMoveHintStyle }, '拖动'),
              )}
              {createElement('div', { 'aria-label': '缩放左上角', style: { ...webCropHandleStyle, ...webCropHandleTopLeftStyle }, ...topLeftWebHandlers })}
              {createElement('div', { 'aria-label': '缩放右上角', style: { ...webCropHandleStyle, ...webCropHandleTopRightStyle }, ...topRightWebHandlers })}
              {createElement('div', { 'aria-label': '缩放左下角', style: { ...webCropHandleStyle, ...webCropHandleBottomLeftStyle }, ...bottomLeftWebHandlers })}
              {createElement('div', { 'aria-label': '缩放右下角', style: { ...webCropHandleStyle, ...webCropHandleBottomRightStyle }, ...bottomRightWebHandlers })}
            </>
          ) : (
            <>
              <View accessible accessibilityLabel="拖动裁剪框" style={styles.cropMovePad} {...moveNativeHandlers}>
                <Text style={styles.cropMoveHint}>拖动</Text>
              </View>
              <View accessible accessibilityLabel="缩放左上角" style={[styles.cropHandle, styles.cropHandleTopLeft]} {...topLeftNativeHandlers} />
              <View accessible accessibilityLabel="缩放右上角" style={[styles.cropHandle, styles.cropHandleTopRight]} {...topRightNativeHandlers} />
              <View accessible accessibilityLabel="缩放左下角" style={[styles.cropHandle, styles.cropHandleBottomLeft]} {...bottomLeftNativeHandlers} />
              <View accessible accessibilityLabel="缩放右下角" style={[styles.cropHandle, styles.cropHandleBottomRight]} {...bottomRightNativeHandlers} />
            </>
          )}
        </View>
      </View>
      <View style={styles.cropAdjustPanel}>
        <View style={styles.cropAdjustRow}>
          <CropAdjustButton label="左移" onPress={() => nudgeCrop(-18, 0)} />
          <CropAdjustButton label="上移" onPress={() => nudgeCrop(0, -18)} />
          <CropAdjustButton label="下移" onPress={() => nudgeCrop(0, 18)} />
          <CropAdjustButton label="右移" onPress={() => nudgeCrop(18, 0)} />
        </View>
        <View style={styles.cropAdjustRow}>
          <CropAdjustButton label="宽-" onPress={() => resizeCrop(-36, 0)} />
          <CropAdjustButton label="宽+" onPress={() => resizeCrop(36, 0)} />
          <CropAdjustButton label="高-" onPress={() => resizeCrop(0, -36)} />
          <CropAdjustButton label="高+" onPress={() => resizeCrop(0, 36)} />
        </View>
      </View>
      <View style={styles.cropFooter}>
        <ActionButton label="取消" onPress={onCancel} tone="neutral" />
        <ActionButton label="重置裁剪框" onPress={resetCropRect} tone="neutral" />
        <ActionButton label={busy ? '裁剪识别中...' : '确认裁剪并识别'} onPress={confirmCrop} />
      </View>
    </View>
  );

  if (Platform.OS === 'web') {
    return visible ? createElement('div', { style: webCropOverlayStyle }, cropContent) : null;
  }

  return (
    <Modal visible={visible} transparent={false} animationType="slide" onRequestClose={onCancel}>
      <SafeAreaView style={styles.cropModalBackdrop}>
        {cropContent}
      </SafeAreaView>
    </Modal>
  );
}

function clampDisplayCropRect(rect: DisplayCropRect, maxWidth: number, maxHeight: number) {
  const minSize = 48;
  let width = Math.min(Math.max(rect.width, minSize), maxWidth);
  let height = Math.min(Math.max(rect.height, minSize), maxHeight);
  const x = Math.min(Math.max(0, rect.x), Math.max(0, maxWidth - width));
  const y = Math.min(Math.max(0, rect.y), Math.max(0, maxHeight - height));
  width = Math.min(width, maxWidth - x);
  height = Math.min(height, maxHeight - y);
  return { x, y, width, height };
}

function getGestureCropRect(mode: CropGestureMode, start: DisplayCropRect, dx: number, dy: number) {
  if (mode === 'move') {
    return { ...start, x: start.x + dx, y: start.y + dy };
  }
  if (mode === 'top-left') {
    return { x: start.x + dx, y: start.y + dy, width: start.width - dx, height: start.height - dy };
  }
  if (mode === 'top-right') {
    return { x: start.x, y: start.y + dy, width: start.width + dx, height: start.height - dy };
  }
  if (mode === 'bottom-left') {
    return { x: start.x + dx, y: start.y, width: start.width - dx, height: start.height + dy };
  }
  return { x: start.x, y: start.y, width: start.width + dx, height: start.height + dy };
}

function CropAdjustButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityLabel={`裁剪${label}`} style={styles.cropAdjustButton} onPress={onPress}>
      <Text style={styles.cropAdjustButtonText}>{label}</Text>
    </Pressable>
  );
}

const colors = {
  ink: '#20201E',
  muted: '#6E6A60',
  line: '#E4DED0',
  bg: '#F7F2E8',
  panel: '#FFFDF8',
  green: '#317A66',
  greenDark: '#245B4C',
  amber: '#A06120',
  red: '#B94A3E',
  blue: '#366A8D',
};

const webCropMovePadStyle = {
  position: 'absolute',
  inset: 0,
  zIndex: 3,
  minWidth: 78,
  minHeight: 48,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'move',
  userSelect: 'none',
  touchAction: 'none',
} as const;

const webCropOverlayStyle = {
  position: 'fixed',
  inset: 0,
  zIndex: 2147483647,
  backgroundColor: colors.bg,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-start',
  alignItems: 'center',
  padding: 12,
  boxSizing: 'border-box',
  overflow: 'auto',
} as const;

const webCropMoveHintStyle = {
  color: '#FFFFFF',
  backgroundColor: 'rgba(0, 0, 0, 0.38)',
  padding: '4px 8px',
  borderRadius: 8,
  fontWeight: 800,
  userSelect: 'none',
} as const;

const webCropHandleStyle = {
  position: 'absolute',
  width: 44,
  height: 44,
  borderRadius: 22,
  backgroundColor: '#FFFFFF',
  border: `2px solid ${colors.green}`,
  zIndex: 5,
  cursor: 'nwse-resize',
  touchAction: 'none',
  userSelect: 'none',
  boxSizing: 'border-box',
} as const;

const webCropHandleTopLeftStyle = { left: 6, top: 6, cursor: 'nwse-resize' } as const;
const webCropHandleTopRightStyle = { right: 6, top: 6, cursor: 'nesw-resize' } as const;
const webCropHandleBottomLeftStyle = { left: 6, bottom: 6, cursor: 'nesw-resize' } as const;
const webCropHandleBottomRightStyle = { right: 6, bottom: 6, cursor: 'nwse-resize' } as const;

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  webShell: {
    width: '100%',
    maxWidth: 430,
    alignSelf: 'center',
    marginLeft: 'auto',
    marginRight: 'auto',
    overflow: 'hidden',
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.line,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  header: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  brand: {
    fontSize: 26,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: 0,
  },
  headerSub: {
    color: colors.muted,
    marginTop: 3,
  },
  badge: {
    backgroundColor: '#E7F0DD',
    borderColor: '#BED1A8',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
  },
  badgeText: {
    color: colors.greenDark,
    fontWeight: '700',
  },
  notice: {
    marginHorizontal: 18,
    marginBottom: 8,
    padding: 10,
    backgroundColor: '#FFF0CF',
    borderWidth: 1,
    borderColor: '#E9C169',
    borderRadius: 8,
  },
  noticeInline: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  noticeText: {
    color: '#63420D',
    flexShrink: 1,
    lineHeight: 20,
  },
  noticeActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  noticeButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#F7DFA3',
  },
  noticeButtonText: {
    color: '#4D3309',
    fontWeight: '800',
  },
  content: {
    flex: 1,
    paddingHorizontal: 14,
    zIndex: 1,
  },
  panel: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    marginBottom: 12,
  },
  stickyPanel: {
    marginBottom: 10,
  },
  stickyPanelCompact: {
    padding: 10,
    overflow: 'hidden',
  },
  stickyPanelContentCompact: {
    paddingBottom: 2,
  },
  inventoryScreen: {
    flex: 1,
  },
  panelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 10,
  },
  panelTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: 0,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.ink,
    marginBottom: 8,
  },
  muted: {
    color: colors.muted,
    lineHeight: 19,
  },
  helpText: {
    color: colors.muted,
    lineHeight: 19,
    marginTop: -2,
    marginBottom: 10,
  },
  flex: {
    flex: 1,
  },
  selectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  bigCode: {
    fontSize: 23,
    fontWeight: '900',
    color: colors.ink,
    letterSpacing: 0,
  },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#9B9587',
  },
  inputGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  inventoryActionGrid: {
    gap: 7,
    marginBottom: 4,
  },
  inputBlock: {
    marginBottom: 10,
  },
  inputBlockGrid: {
    flex: 1,
    minWidth: 140,
  },
  actionInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  actionInput: {
    flex: 1,
    minWidth: 0,
  },
  roundAction: {
    width: 36,
    height: 38,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundActionPlus: {
    backgroundColor: colors.green,
  },
  roundActionMinus: {
    backgroundColor: colors.red,
  },
  roundActionText: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '900',
    lineHeight: 24,
  },
  auditButton: {
    minHeight: 38,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D4C8B2',
    backgroundColor: '#EFE8DA',
    alignItems: 'center',
    justifyContent: 'center',
  },
  auditButtonText: {
    color: colors.ink,
    fontWeight: '800',
  },
  packLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  packHint: {
    color: colors.greenDark,
    fontSize: 12,
    fontWeight: '800',
    marginBottom: 5,
  },
  packEditor: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  packEditorInput: {
    flex: 1,
  },
  label: {
    color: colors.muted,
    fontSize: 12,
    marginBottom: 5,
    fontWeight: '700',
  },
  input: {
    minHeight: 38,
    borderWidth: 1,
    borderColor: '#D7CFBE',
    backgroundColor: '#FFFEFB',
    borderRadius: 8,
    paddingHorizontal: 10,
    color: colors.ink,
    fontSize: 15,
  },
  qtyInput: {
    width: 84,
    minHeight: 38,
    textAlign: 'center',
  },
  buttonGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  compactButtonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  actionButton: {
    minHeight: 40,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  actionButtonText: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
  neutralButtonText: {
    color: colors.ink,
  },
  button_primary: {
    backgroundColor: colors.green,
  },
  button_amber: {
    backgroundColor: colors.amber,
  },
  button_danger: {
    backgroundColor: colors.red,
  },
  button_neutral: {
    backgroundColor: '#EFE8DA',
    borderWidth: 1,
    borderColor: '#D4C8B2',
  },
  toolbar: {
    marginBottom: 8,
  },
  frozenFilters: {
    marginBottom: 8,
  },
  searchInput: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: '#FFFDF8',
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  numberPad: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: -2,
    marginBottom: 8,
  },
  numberPadKey: {
    width: '23.5%',
    minHeight: 34,
    borderRadius: 8,
    backgroundColor: '#EFE8DA',
    borderWidth: 1,
    borderColor: '#D4C8B2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  numberPadText: {
    color: colors.ink,
    fontWeight: '900',
  },
  seriesBar: {
    marginBottom: 10,
  },
  miniSelector: {
    marginBottom: 10,
  },
  purchasePickerBlock: {
    marginBottom: 2,
  },
  purchasePickerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  purchaseSelect: {
    flex: 1,
    minWidth: 150,
    minHeight: 38,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D4C8B2',
    backgroundColor: '#FFFEFB',
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  purchaseSelectText: {
    color: colors.ink,
    fontWeight: '800',
    flexShrink: 1,
  },
  purchaseSelectHint: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '800',
  },
  purchaseDropdown: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#FFFEFB',
  },
  purchaseDropdownItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#EFE6D5',
  },
  purchaseDropdownItemActive: {
    backgroundColor: '#F1FAF1',
  },
  purchaseDropdownText: {
    color: colors.ink,
    fontWeight: '700',
  },
  purchaseDropdownTextActive: {
    color: colors.greenDark,
    fontWeight: '900',
  },
  seriesChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#ECE3D2',
    borderRadius: 8,
    marginRight: 8,
  },
  seriesChipActive: {
    backgroundColor: colors.ink,
  },
  seriesText: {
    color: colors.ink,
    fontWeight: '700',
  },
  seriesTextActive: {
    color: '#FFFFFF',
  },
  list: {
    gap: 8,
    paddingBottom: 24,
  },
  colorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 11,
    backgroundColor: colors.panel,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
  },
  colorRowActive: {
    borderColor: colors.green,
    backgroundColor: '#F1FAF1',
  },
  codeText: {
    fontSize: 16,
    color: colors.ink,
    fontWeight: '800',
    letterSpacing: 0,
  },
  right: {
    alignItems: 'flex-end',
    minWidth: 56,
  },
  quantity: {
    color: colors.ink,
    fontWeight: '900',
    fontSize: 18,
  },
  miniLabel: {
    color: colors.muted,
    fontSize: 11,
  },
  lowText: {
    color: colors.red,
    fontWeight: '800',
  },
  dangerText: {
    color: colors.red,
    fontWeight: '800',
  },
  warningText: {
    color: colors.red,
    fontWeight: '800',
    lineHeight: 19,
  },
  okText: {
    color: colors.green,
  },
  inlineForm: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
  },
  projectChip: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    backgroundColor: '#ECE3D2',
    borderRadius: 8,
    marginRight: 8,
    maxWidth: 180,
  },
  projectChipActive: {
    backgroundColor: colors.green,
  },
  projectChipText: {
    color: colors.ink,
    fontWeight: '800',
  },
  projectChipTextActive: {
    color: '#FFFFFF',
  },
  textButton: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  patternImage: {
    width: '100%',
    height: 190,
    borderRadius: 8,
    backgroundColor: '#EEE7DA',
    marginBottom: 10,
  },
  deductPreview: {
    marginTop: 12,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E1C46F',
    backgroundColor: '#FFF8E6',
    gap: 10,
  },
  deductRows: {
    borderTopWidth: 1,
    borderTopColor: '#E8D9B1',
  },
  deductRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: '#E8D9B1',
  },
  cropModalBackdrop: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'flex-start',
    padding: 12,
  },
  cropModalPanel: {
    width: '100%',
    maxWidth: 430,
    flex: 1,
    borderRadius: 8,
    backgroundColor: colors.bg,
    padding: 6,
    gap: 10,
  },
  cropTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  cropCanvas: {
    alignSelf: 'center',
    backgroundColor: '#211F1C',
    overflow: 'hidden',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
  },
  cropImage: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  cropSelection: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#FFFFFF',
    backgroundColor: 'rgba(49, 122, 102, 0.16)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  cropMovePad: {
    minWidth: 78,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cropMoveHint: {
    color: '#FFFFFF',
    backgroundColor: 'rgba(0, 0, 0, 0.38)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    fontWeight: '800',
    overflow: 'hidden',
  },
  cropHandle: {
    position: 'absolute',
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: colors.green,
    zIndex: 5,
  },
  cropHandleTopLeft: {
    left: 6,
    top: 6,
  },
  cropHandleTopRight: {
    right: 6,
    top: 6,
  },
  cropHandleBottomLeft: {
    left: 6,
    bottom: 6,
  },
  cropHandleBottomRight: {
    right: 6,
    bottom: 6,
  },
  cropAdjustPanel: {
    gap: 8,
  },
  cropAdjustRow: {
    flexDirection: 'row',
    gap: 8,
  },
  cropAdjustButton: {
    flex: 1,
    minHeight: 38,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D4C8B2',
    backgroundColor: '#EFE8DA',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  cropAdjustButtonText: {
    color: colors.ink,
    fontWeight: '900',
  },
  cropFooter: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'flex-end',
  },
  divider: {
    height: 1,
    backgroundColor: colors.line,
    marginVertical: 14,
  },
  itemRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  inlineStats: {
    marginTop: 10,
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#F4ECDC',
  },
  requirementCompare: {
    marginTop: 12,
  },
  requirementRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: '#EFE6D5',
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: '#EFE6D5',
  },
  checkbox: {
    width: 26,
    height: 26,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#C9BDA8',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFEFB',
  },
  checkboxActive: {
    backgroundColor: colors.green,
    borderColor: colors.green,
  },
  checkboxText: {
    color: '#FFFFFF',
    fontWeight: '900',
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  statCard: {
    flex: 1,
    minWidth: 96,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
  },
  statValue: {
    fontSize: 24,
    color: colors.ink,
    fontWeight: '900',
    marginTop: 5,
  },
  purchaseBox: {
    backgroundColor: '#25231F',
    borderRadius: 8,
    padding: 14,
    marginTop: 12,
    minHeight: 110,
  },
  purchaseText: {
    color: '#F8F1DF',
    fontSize: 18,
    lineHeight: 28,
    fontWeight: '800',
  },
  empty: {
    padding: 24,
    alignItems: 'center',
  },
  emptyTitle: {
    color: colors.ink,
    fontWeight: '900',
    fontSize: 17,
    marginBottom: 6,
  },
  resetButton: {
    alignItems: 'center',
    padding: 16,
    marginBottom: 30,
  },
  resetButtonReady: {
    backgroundColor: '#FFF0CF',
    borderWidth: 1,
    borderColor: '#E9C169',
    borderRadius: 8,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#EFE6D5',
  },
  historyActions: {
    flexDirection: 'row',
    gap: 6,
  },
  smallAction: {
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#EFE8DA',
    borderWidth: 1,
    borderColor: '#D4C8B2',
  },
  smallActionDisabled: {
    opacity: 0.45,
  },
  smallActionText: {
    color: colors.ink,
    fontWeight: '800',
    fontSize: 12,
  },
  historyUndone: {
    color: colors.muted,
    textDecorationLine: 'line-through',
  },
  tabbar: {
    flexDirection: 'row',
    gap: 6,
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: '#FFFDF8',
    zIndex: 0,
  },
  tab: {
    flex: 1,
    minHeight: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabActive: {
    backgroundColor: colors.ink,
  },
  tabText: {
    color: colors.muted,
    fontWeight: '800',
  },
  tabTextActive: {
    color: '#FFFFFF',
  },
});
