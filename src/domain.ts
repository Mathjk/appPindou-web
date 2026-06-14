import { MARD_291_COLORS, getColor, normalizeBeadCode } from './data/mard291';
import type {
  ActionHistoryEntry,
  AppData,
  AppDataSnapshot,
  AppSettings,
  InventoryEntry,
  PatternProject,
  ProjectItem,
  PurchaseItem,
  PurchaseList,
  PurchaseRow,
  RequirementRow,
  StockLog,
  StockLogType,
} from './types';

export const DEFAULT_SETTINGS: AppSettings = {
  inventoryPackSize: 1000,
  defaultLowStockThreshold: 100,
  aiOcrApiKey: 'helloworld',
  aiOcrEndpoint: 'https://api.ocr.space/parse/image',
  aiOcrModel: 'ocr.space-engine2',
  aiOcrTextApiKey: '',
  aiOcrTextEndpoint: 'https://api.deepseek.com/chat/completions',
  aiOcrTextModel: 'deepseek-v4-flash',
  aiOcrTextEnabled: true,
  aiOcrProviderKeys: {},
  aiOcrTextProviderKeys: {},
  aiOcrUseSameKey: false,
  cloudAutoSyncIntervalMinutes: 5,
  projectSafetyBuffer: 50,
};

const HISTORY_LIMIT = 80;

export function createEmptyData(): AppData {
  return {
    version: 1,
    settings: DEFAULT_SETTINGS,
    inventory: {},
    stockLogs: [],
    projects: [],
    purchaseLists: [createPurchaseList('默认采购表')],
    actionHistory: [],
  };
}

export function makeId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function clampWholeNumber(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export function parseWholeNumber(value: string) {
  return clampWholeNumber(Number(value.replace(/[^\d.]/g, '')));
}

export function snapshotAppData(data: AppData | AppDataSnapshot): AppDataSnapshot {
  return JSON.parse(
    JSON.stringify({
      version: data.version,
      settings: data.settings,
      inventory: data.inventory,
      stockLogs: data.stockLogs,
      projects: data.projects.map(stripProjectImages),
      purchaseLists: data.purchaseLists,
    }),
  ) as AppDataSnapshot;
}

// History snapshots must not carry image base64 data URLs. Each project holds up to three
// base64 images (original/cropped/OCR), and storing before+after copies across many history
// entries quickly overflows the ~5MB localStorage quota on web, which surfaces as
// "本地保存失败". Images are derived artifacts that undo/rollback never need to restore,
// so we drop them from snapshots.
function stripProjectImages(project: PatternProject): PatternProject {
  const { imageUri, originalImageUri, croppedImageUri, ...rest } = project;
  return rest;
}

export function recordActionHistory(before: AppData, after: AppData, label = '数据变更'): AppData {
  const beforeSnapshot = snapshotAppData(before);
  const afterSnapshot = snapshotAppData(after);
  if (JSON.stringify(beforeSnapshot) === JSON.stringify(afterSnapshot)) return after;

  const entry: ActionHistoryEntry = {
    id: makeId('history'),
    label,
    createdAt: new Date().toISOString(),
    before: beforeSnapshot,
    after: afterSnapshot,
  };

  // Return the full `after` state (which still carries project image data URLs) so OCR/crop
  // results are preserved in the live state; only the history entry uses the image-stripped
  // snapshots to keep storage small.
  return {
    ...after,
    actionHistory: [entry, ...(before.actionHistory ?? [])].slice(0, HISTORY_LIMIT),
  };
}

export function undoSingleHistoryEntry(data: AppData, historyId: string): AppData {
  const entry = data.actionHistory.find((item) => item.id === historyId);
  if (!entry || entry.undoneAt) return data;
  const now = new Date().toISOString();
  const afterUndo: AppData = {
    ...data,
    settings: undoSettings(data.settings, entry.before.settings, entry.after.settings),
    inventory: undoInventory(data.inventory, entry.before.inventory, entry.after.inventory),
    purchaseLists: undoPurchaseLists(data.purchaseLists, entry.before.purchaseLists, entry.after.purchaseLists),
    projects: undoProjects(data.projects, entry.before.projects, entry.after.projects),
  };
  return {
    ...afterUndo,
    actionHistory: data.actionHistory.map((item) => (item.id === historyId ? { ...item, undoneAt: now } : item)),
  };
}

export function rollbackToHistoryEntry(data: AppData, historyId: string): AppData {
  const entry = data.actionHistory.find((item) => item.id === historyId);
  if (!entry) return data;
  const now = new Date().toISOString();
  const restored = snapshotAppData(entry.before);
  // Snapshots no longer store image data URLs, so re-attach the current image fields to any
  // project that still exists, keeping uploaded/cropped images visible after a rollback.
  const currentImagesById = new Map(data.projects.map((project) => [project.id, project]));
  return {
    ...restored,
    projects: restored.projects.map((project) => {
      const current = currentImagesById.get(project.id);
      if (!current) return project;
      return {
        ...project,
        imageUri: current.imageUri,
        originalImageUri: current.originalImageUri,
        croppedImageUri: current.croppedImageUri,
      };
    }),
    actionHistory: data.actionHistory.map((item) => (item.createdAt >= entry.createdAt ? { ...item, undoneAt: item.undoneAt ?? now } : item)),
  };
}

function undoSettings(current: AppSettings, before: AppSettings, after: AppSettings): AppSettings {
  return {
    inventoryPackSize: current.inventoryPackSize === after.inventoryPackSize ? before.inventoryPackSize : current.inventoryPackSize,
    defaultLowStockThreshold:
      current.defaultLowStockThreshold === after.defaultLowStockThreshold ? before.defaultLowStockThreshold : current.defaultLowStockThreshold,
    aiOcrApiKey: current.aiOcrApiKey === after.aiOcrApiKey ? before.aiOcrApiKey : current.aiOcrApiKey,
    aiOcrEndpoint: current.aiOcrEndpoint === after.aiOcrEndpoint ? before.aiOcrEndpoint : current.aiOcrEndpoint,
    aiOcrModel: current.aiOcrModel === after.aiOcrModel ? before.aiOcrModel : current.aiOcrModel,
    aiOcrTextApiKey: current.aiOcrTextApiKey === after.aiOcrTextApiKey ? before.aiOcrTextApiKey : current.aiOcrTextApiKey,
    aiOcrTextEndpoint: current.aiOcrTextEndpoint === after.aiOcrTextEndpoint ? before.aiOcrTextEndpoint : current.aiOcrTextEndpoint,
    aiOcrTextModel: current.aiOcrTextModel === after.aiOcrTextModel ? before.aiOcrTextModel : current.aiOcrTextModel,
    aiOcrTextEnabled: current.aiOcrTextEnabled === after.aiOcrTextEnabled ? before.aiOcrTextEnabled : current.aiOcrTextEnabled,
    aiOcrProviderKeys: sameRecord(current.aiOcrProviderKeys, after.aiOcrProviderKeys) ? before.aiOcrProviderKeys : current.aiOcrProviderKeys,
    aiOcrTextProviderKeys: sameRecord(current.aiOcrTextProviderKeys, after.aiOcrTextProviderKeys)
      ? before.aiOcrTextProviderKeys
      : current.aiOcrTextProviderKeys,
    aiOcrUseSameKey: current.aiOcrUseSameKey === after.aiOcrUseSameKey ? before.aiOcrUseSameKey : current.aiOcrUseSameKey,
    cloudAutoSyncIntervalMinutes:
      current.cloudAutoSyncIntervalMinutes === after.cloudAutoSyncIntervalMinutes
        ? before.cloudAutoSyncIntervalMinutes
        : current.cloudAutoSyncIntervalMinutes,
    projectSafetyBuffer: current.projectSafetyBuffer === after.projectSafetyBuffer ? before.projectSafetyBuffer : current.projectSafetyBuffer,
  };
}

function sameRecord(left: Record<string, string>, right: Record<string, string>) {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}

function undoInventory(
  current: Record<string, InventoryEntry>,
  before: Record<string, InventoryEntry>,
  after: Record<string, InventoryEntry>,
): Record<string, InventoryEntry> {
  const next: Record<string, InventoryEntry> = JSON.parse(JSON.stringify(current));
  const codes = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const code of codes) {
    const beforeEntry = before[code];
    const afterEntry = after[code];
    const currentEntry = next[code] ?? { quantity: 0 };
    const delta = (afterEntry?.quantity ?? 0) - (beforeEntry?.quantity ?? 0);
    if (delta) {
      currentEntry.quantity = Math.max(0, (currentEntry.quantity ?? 0) - delta);
    }
    if (beforeEntry?.lowStockThreshold !== afterEntry?.lowStockThreshold && currentEntry.lowStockThreshold === afterEntry?.lowStockThreshold) {
      currentEntry.lowStockThreshold = beforeEntry?.lowStockThreshold;
    }
    if (!currentEntry.quantity && currentEntry.lowStockThreshold === undefined) {
      delete next[code];
    } else {
      next[code] = currentEntry;
    }
  }
  return next;
}

function undoPurchaseLists(current: PurchaseList[], before: PurchaseList[], after: PurchaseList[]): PurchaseList[] {
  let next: PurchaseList[] = JSON.parse(JSON.stringify(current));
  const beforeById = new Map(before.map((list) => [list.id, list]));
  const afterById = new Map(after.map((list) => [list.id, list]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);

  for (const id of ids) {
    const beforeList = beforeById.get(id);
    const afterList = afterById.get(id);
    const currentIndex = next.findIndex((list) => list.id === id);

    if (!beforeList && afterList) {
      next = next.filter((list) => list.id !== id);
      continue;
    }
    if (beforeList && !afterList) {
      if (currentIndex === -1) next = [beforeList, ...next];
      continue;
    }
    if (!beforeList || !afterList || currentIndex === -1) continue;

    const currentList = next[currentIndex];
    const restored: PurchaseList = {
      ...currentList,
      name: currentList.name === afterList.name ? beforeList.name : currentList.name,
      packSize: currentList.packSize === afterList.packSize ? beforeList.packSize : currentList.packSize,
      items: undoPurchaseItems(currentList.items, beforeList.items, afterList.items),
      updatedAt: currentList.updatedAt === afterList.updatedAt ? beforeList.updatedAt : currentList.updatedAt,
    };
    next[currentIndex] = restored;
  }

  return next.length ? next : [createPurchaseList('默认采购表')];
}

function undoPurchaseItems(current: PurchaseItem[], before: PurchaseItem[], after: PurchaseItem[]): PurchaseItem[] {
  let next: PurchaseItem[] = JSON.parse(JSON.stringify(current));
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const afterById = new Map(after.map((item) => [item.id, item]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);

  for (const id of ids) {
    const beforeItem = beforeById.get(id);
    const afterItem = afterById.get(id);
    const currentIndex = next.findIndex((item) => item.id === id);

    if (beforeItem && !afterItem) {
      if (currentIndex === -1) next = [...next, beforeItem];
      continue;
    }
    if (!afterItem) continue;

    const delta = afterItem.quantity - (beforeItem?.quantity ?? 0);
    if (!beforeItem && currentIndex !== -1) {
      const nextQuantity = next[currentIndex].quantity - delta;
      if (nextQuantity <= 0) next = next.filter((item) => item.id !== id);
      else next[currentIndex] = { ...next[currentIndex], quantity: nextQuantity };
      continue;
    }
    if (beforeItem && currentIndex !== -1) {
      next[currentIndex] = {
        ...next[currentIndex],
        code: next[currentIndex].code === afterItem.code ? beforeItem.code : next[currentIndex].code,
        quantity: Math.max(0, next[currentIndex].quantity - delta),
      };
    }
  }

  return next.filter((item) => item.quantity > 0);
}

function undoProjects(current: PatternProject[], before: PatternProject[], after: PatternProject[]): PatternProject[] {
  let next: PatternProject[] = JSON.parse(JSON.stringify(current));
  const beforeById = new Map(before.map((project) => [project.id, project]));
  const afterById = new Map(after.map((project) => [project.id, project]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);

  for (const id of ids) {
    const beforeProject = beforeById.get(id);
    const afterProject = afterById.get(id);
    const currentIndex = next.findIndex((project) => project.id === id);

    if (!beforeProject && afterProject) {
      next = next.filter((project) => project.id !== id);
      continue;
    }
    if (beforeProject && !afterProject) {
      if (currentIndex === -1) next = [beforeProject, ...next];
      continue;
    }
    if (!beforeProject || !afterProject || currentIndex === -1) continue;
    const currentProject = next[currentIndex];
    if (JSON.stringify(next[currentIndex]) === JSON.stringify(afterProject)) {
      next[currentIndex] = beforeProject;
    } else {
      next[currentIndex] = {
        ...currentProject,
        name: undoField(currentProject.name, beforeProject.name, afterProject.name),
        status: undoField(currentProject.status, beforeProject.status, afterProject.status),
        ocrStatus: undoField(currentProject.ocrStatus, beforeProject.ocrStatus, afterProject.ocrStatus),
        ocrMessage: undoField(currentProject.ocrMessage, beforeProject.ocrMessage, afterProject.ocrMessage),
        ocrRawText: undoField(currentProject.ocrRawText, beforeProject.ocrRawText, afterProject.ocrRawText),
        ocrEngine: undoField(currentProject.ocrEngine, beforeProject.ocrEngine, afterProject.ocrEngine),
        ocrUpdatedAt: undoField(currentProject.ocrUpdatedAt, beforeProject.ocrUpdatedAt, afterProject.ocrUpdatedAt),
        deductedAt: undoField(currentProject.deductedAt, beforeProject.deductedAt, afterProject.deductedAt),
        deductCount: undoField(currentProject.deductCount, beforeProject.deductCount, afterProject.deductCount),
        updatedAt: undoField(currentProject.updatedAt, beforeProject.updatedAt, afterProject.updatedAt),
        items: undoProjectItems(currentProject.items, beforeProject.items, afterProject.items),
      };
    }
  }
  return next;
}

function undoField<T>(current: T, before: T, after: T): T {
  return JSON.stringify(current) === JSON.stringify(after) ? before : current;
}

function undoProjectItems(current: ProjectItem[], before: ProjectItem[], after: ProjectItem[]): ProjectItem[] {
  let next: ProjectItem[] = JSON.parse(JSON.stringify(current));
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const afterById = new Map(after.map((item) => [item.id, item]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);

  for (const id of ids) {
    const beforeItem = beforeById.get(id);
    const afterItem = afterById.get(id);
    const currentIndex = next.findIndex((item) => item.id === id);
    if (beforeItem && !afterItem) {
      if (currentIndex === -1) next = [...next, beforeItem];
      continue;
    }
    if (!afterItem) continue;
    const delta = afterItem.quantity - (beforeItem?.quantity ?? 0);
    if (!beforeItem && currentIndex !== -1) {
      const nextQuantity = next[currentIndex].quantity - delta;
      if (nextQuantity <= 0) next = next.filter((item) => item.id !== id);
      else next[currentIndex] = { ...next[currentIndex], quantity: nextQuantity };
      continue;
    }
    if (beforeItem && currentIndex !== -1) {
      next[currentIndex] = {
        ...next[currentIndex],
        code: next[currentIndex].code === afterItem.code ? beforeItem.code : next[currentIndex].code,
        quantity: Math.max(0, next[currentIndex].quantity - delta),
        note: next[currentIndex].note === afterItem.note ? beforeItem.note : next[currentIndex].note,
      };
    }
  }
  return next.filter((item) => item.quantity > 0);
}

export function getStock(data: AppData, code: string) {
  return data.inventory[normalizeBeadCode(code)]?.quantity ?? 0;
}

export function getThreshold(data: AppData, code: string) {
  return data.inventory[normalizeBeadCode(code)]?.lowStockThreshold ?? data.settings.defaultLowStockThreshold;
}

export function applyStockChange(
  data: AppData,
  codeInput: string,
  delta: number,
  type: StockLogType,
  note?: string,
  projectId?: string,
) {
  const code = normalizeBeadCode(codeInput);
  const before = getStock(data, code);
  const after = Math.max(0, before + Math.trunc(delta));
  const safeDelta = after - before;
  const log: StockLog = {
    id: makeId('log'),
    type,
    code,
    delta: safeDelta,
    before,
    after,
    note,
    projectId,
    createdAt: new Date().toISOString(),
  };
  return {
    ...data,
    inventory: {
      ...data.inventory,
      [code]: {
        ...(data.inventory[code] ?? {}),
        quantity: after,
      },
    },
    stockLogs: [log, ...data.stockLogs].slice(0, 500),
  };
}

export function adjustStock(data: AppData, codeInput: string, targetQuantity: number, note?: string) {
  const code = normalizeBeadCode(codeInput);
  const before = getStock(data, code);
  return applyStockChange(data, code, clampWholeNumber(targetQuantity) - before, 'adjust', note);
}

export function sumProjectItems(projects: PatternProject[]) {
  const totals: Record<string, number> = {};
  for (const project of projects) {
    for (const item of project.items) {
      const code = normalizeBeadCode(item.code);
      totals[code] = (totals[code] ?? 0) + clampWholeNumber(item.quantity);
    }
  }
  return totals;
}

export function buildRequirementRows(data: AppData, projects: PatternProject[], packSize = 1): RequirementRow[] {
  const totals = sumProjectItems(projects);
  const safePackSize = Math.max(1, clampWholeNumber(packSize));
  const safetyBuffer = Math.max(0, clampWholeNumber(data.settings.projectSafetyBuffer));
  return Object.entries(totals)
    .map(([code, required]) => {
      const stock = getStock(data, code);
      const missing = Math.max(required - stock, 0);
      const remaining = stock - required;
      return {
        code,
        required,
        stock,
        missing,
        remaining,
        safetyBuffer,
        safetyWarning: missing === 0 && remaining < safetyBuffer,
        packsToBuy: missing > 0 ? Math.ceil(missing / safePackSize) : 0,
      };
    })
    .filter((row) => getColor(row.code))
    .sort((a, b) => (getColor(a.code)?.sortOrder ?? 9999) - (getColor(b.code)?.sortOrder ?? 9999));
}

export function formatPurchaseList(rows: RequirementRow[]) {
  return rows
    .filter((row) => row.packsToBuy > 0)
    .map((row) => `${row.code}×${row.packsToBuy}`)
    .join('\n');
}

export function createPurchaseList(name: string, packSize = 1000): PurchaseList {
  const now = new Date().toISOString();
  return {
    id: makeId('purchase'),
    name: name.trim() || `采购表 ${new Date().toLocaleDateString()}`,
    packSize: Math.max(1, clampWholeNumber(packSize) || 1000),
    items: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function upsertPurchaseList(data: AppData, list: PurchaseList) {
  const exists = data.purchaseLists.some((item) => item.id === list.id);
  const updated = { ...list, updatedAt: new Date().toISOString() };
  return {
    ...data,
    purchaseLists: exists ? data.purchaseLists.map((item) => (item.id === list.id ? updated : item)) : [updated, ...data.purchaseLists],
  };
}

export function deletePurchaseList(data: AppData, listId: string) {
  const nextLists = data.purchaseLists.filter((list) => list.id !== listId);
  return {
    ...data,
    purchaseLists: nextLists.length ? nextLists : [createPurchaseList('默认采购表')],
  };
}

export function addPurchaseItem(data: AppData, listId: string, codeInput: string, quantity: number) {
  const code = normalizeBeadCode(codeInput);
  const safeQuantity = clampWholeNumber(quantity);
  if (!safeQuantity || !getColor(code)) return data;
  const list = data.purchaseLists.find((item) => item.id === listId) ?? data.purchaseLists[0] ?? createPurchaseList('默认采购表');
  const existing = list.items.find((item) => normalizeBeadCode(item.code) === code);
  const items = existing
    ? list.items.map((item) => (item.id === existing.id ? { ...item, quantity: item.quantity + safeQuantity } : item))
    : [...list.items, { id: makeId('purchaseItem'), code, quantity: safeQuantity }];
  return upsertPurchaseList(data, { ...list, items });
}

export function setPurchaseItemQuantity(data: AppData, listId: string, itemId: string, quantity: number) {
  const list = data.purchaseLists.find((item) => item.id === listId);
  if (!list) return data;
  return upsertPurchaseList(data, {
    ...list,
    items: list.items.map((item) => (item.id === itemId ? { ...item, quantity: clampWholeNumber(quantity) } : item)),
  });
}

export function removePurchaseItem(data: AppData, listId: string, itemId: string) {
  const list = data.purchaseLists.find((item) => item.id === listId);
  if (!list) return data;
  return upsertPurchaseList(data, {
    ...list,
    items: list.items.filter((item) => item.id !== itemId),
  });
}

export function buildPurchaseRows(list: PurchaseList): PurchaseRow[] {
  const packSize = Math.max(1, clampWholeNumber(list.packSize) || 1000);
  const totals: Record<string, number> = {};
  for (const item of list.items) {
    const code = normalizeBeadCode(item.code);
    if (getColor(code)) {
      totals[code] = (totals[code] ?? 0) + clampWholeNumber(item.quantity);
    }
  }
  return Object.entries(totals)
    .map(([code, quantity]) => ({
      code,
      quantity,
      packsToBuy: quantity > 0 ? Math.ceil(quantity / packSize) : 0,
    }))
    .sort((a, b) => (getColor(a.code)?.sortOrder ?? 9999) - (getColor(b.code)?.sortOrder ?? 9999));
}

export function formatPurchaseRows(rows: PurchaseRow[]) {
  return rows
    .filter((row) => row.packsToBuy > 0)
    .map((row) => `${row.code}×${row.packsToBuy}`)
    .join('\n');
}

export function addProjectShortageToPurchaseList(data: AppData, listId: string, projects: PatternProject[]) {
  const list = data.purchaseLists.find((item) => item.id === listId) ?? data.purchaseLists[0];
  if (!list) return data;
  let next = data;
  for (const row of buildRequirementRows(data, projects, list.packSize).filter((item) => item.missing > 0)) {
    next = addPurchaseItem(next, list.id, row.code, row.missing);
  }
  return next;
}

export function completePurchaseList(data: AppData, listId: string) {
  const list = data.purchaseLists.find((item) => item.id === listId);
  if (!list) return data;
  const rows = buildPurchaseRows(list);
  if (!rows.length) return data;
  let next = data;
  for (const row of rows) {
    next = applyStockChange(next, row.code, row.quantity, 'purchase', `采购入库：${list.name}`);
  }
  const latestList = next.purchaseLists.find((item) => item.id === list.id) ?? list;
  return upsertPurchaseList(next, { ...latestList, items: [] });
}

export function createProject(name: string): PatternProject {
  const now = new Date().toISOString();
  return {
    id: makeId('project'),
    name: name.trim() || `新图纸 ${new Date().toLocaleDateString()}`,
    status: 'planning',
    ocrStatus: 'not-started',
    items: [],
    deductCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function upsertProject(data: AppData, project: PatternProject) {
  const exists = data.projects.some((item) => item.id === project.id);
  const updated = { ...project, updatedAt: new Date().toISOString() };
  return {
    ...data,
    projects: exists ? data.projects.map((item) => (item.id === project.id ? updated : item)) : [updated, ...data.projects],
  };
}

export function deleteProject(data: AppData, projectId: string) {
  return {
    ...data,
    projects: data.projects.filter((project) => project.id !== projectId),
  };
}

export function deductProjectInventory(data: AppData, project: PatternProject) {
  const currentProject = data.projects.find((item) => item.id === project.id) ?? project;
  let next = data;
  for (const item of currentProject.items) {
    next = applyStockChange(next, item.code, -clampWholeNumber(item.quantity), 'project-deduct', `扣除：${currentProject.name}`, currentProject.id);
  }
  const deductCount = getProjectDeductCount(currentProject) + 1;
  return upsertProject(next, {
    ...currentProject,
    status: currentProject.status === 'completed' ? 'completed' : 'active',
    deductedAt: new Date().toISOString(),
    deductCount,
  });
}

export function getProjectDeductCount(project: PatternProject) {
  return Math.max(0, clampWholeNumber(project.deductCount ?? (project.deductedAt ? 1 : 0)));
}

export function getInventoryStats(data: AppData) {
  const stocked = MARD_291_COLORS.filter((color) => getStock(data, color.code) > 0).length;
  const totalBeads = MARD_291_COLORS.reduce((sum, color) => sum + getStock(data, color.code), 0);
  const low = MARD_291_COLORS.filter((color) => {
    const stock = getStock(data, color.code);
    return stock > 0 && stock <= getThreshold(data, color.code);
  }).length;
  return { stocked, totalBeads, low, totalColors: MARD_291_COLORS.length };
}
