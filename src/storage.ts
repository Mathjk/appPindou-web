import AsyncStorage from '@react-native-async-storage/async-storage';

import { createEmptyData, createPurchaseList } from './domain';
import type { ActionHistoryEntry, AppData, AppDataSnapshot, InventoryEntry } from './types';

const STORAGE_KEY = 'appPindou:data:v1';

export async function loadAppData(): Promise<AppData> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return createEmptyData();
  try {
    const parsed = JSON.parse(raw) as AppData;
    if (parsed.version !== 1) return createEmptyData();
    return normalizeAppData(parsed);
  } catch {
    return createEmptyData();
  }
}

export async function saveAppData(data: AppData) {
  const persistable = prepareDataForStorage(data);
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
  } catch (error) {
    // If storage is full (e.g. localStorage quota on web), retry without the action history,
    // which is the only unbounded, non-essential part of the payload. Inventory, projects,
    // and purchase lists are preserved.
    if (isQuotaError(error)) {
      const trimmed: AppData = { ...persistable, actionHistory: [] };
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
      return;
    }
    throw error;
  }
}

function prepareDataForStorage(data: AppData): AppData {
  return {
    ...data,
    // Project image data URLs can exceed localStorage quota on mobile browsers. The live
    // React state keeps them for preview/re-crop during the current session; persistent
    // storage keeps the OCR result, editable bead counts, inventory, and purchase data.
    projects: data.projects.map(stripProjectImageFields),
    actionHistory: data.actionHistory.map((entry) => ({
      ...entry,
      before: normalizeSnapshot(entry.before),
      after: normalizeSnapshot(entry.after),
    })),
  };
}

function isQuotaError(error: unknown) {
  if (!error) return false;
  const name = (error as { name?: string }).name ?? '';
  const message = (error as { message?: string }).message ?? '';
  return /quota|exceeded|storage/i.test(`${name} ${message}`);
}

export function exportAppData(data: AppData) {
  return JSON.stringify(createBackupPayload(data), null, 2);
}

export function parseImportedData(raw: string): AppData | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const imported = (parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed) as Partial<AppData>;
    if (imported.version !== 1 || !imported.settings || !imported.inventory || !Array.isArray(imported.projects)) {
      return null;
    }
    return normalizeAppData(imported);
  } catch {
    return null;
  }
}

function createBackupPayload(data: AppData) {
  return {
    format: 'appPindou.backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      ...data,
      settings: redactSettings(data.settings),
      inventory: compactInventory(data.inventory),
      actionHistory: data.actionHistory.map((entry) => ({
        ...entry,
        before: compactSnapshot(entry.before),
        after: compactSnapshot(entry.after),
      })),
    },
  };
}

function compactSnapshot(snapshot: AppDataSnapshot) {
  return {
    ...snapshot,
    settings: redactSettings(snapshot.settings),
    inventory: compactInventory(snapshot.inventory),
  };
}

function redactSettings(settings: AppData['settings']) {
  return {
    ...settings,
    aiOcrApiKey: '',
    aiOcrTextApiKey: '',
  };
}

function compactInventory(inventory: Record<string, InventoryEntry>) {
  return Object.entries(inventory)
    .filter(([, entry]) => entry.quantity || entry.lowStockThreshold !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, entry]) => ({
      code,
      quantity: entry.quantity,
      lowStockThreshold: entry.lowStockThreshold,
    }));
}

function normalizeAppData(
  parsed: Partial<AppData> & {
    settings?: AppData['settings'] & { packSize?: number };
    inventory?: AppData['inventory'] | Array<InventoryEntry & { code: string }>;
  },
): AppData {
  const empty = createEmptyData();
  const inventoryPackSize = parsed.settings?.inventoryPackSize ?? parsed.settings?.packSize ?? empty.settings.inventoryPackSize;
  const purchaseLists = Array.isArray(parsed.purchaseLists) && parsed.purchaseLists.length ? parsed.purchaseLists : [createPurchaseList('默认采购表')];
  const stockLogs = Array.isArray(parsed.stockLogs) ? parsed.stockLogs : [];
  const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
  const actionHistory = Array.isArray(parsed.actionHistory) ? normalizeActionHistory(parsed.actionHistory) : [];
  return {
    ...empty,
    ...parsed,
    settings: {
      ...empty.settings,
      ...parsed.settings,
      inventoryPackSize,
    },
    inventory: normalizeInventory(parsed.inventory),
    stockLogs,
    projects,
    purchaseLists,
    actionHistory,
  };
}

function normalizeActionHistory(entries: ActionHistoryEntry[]): ActionHistoryEntry[] {
  return entries
    .filter((entry) => entry.id && entry.before && entry.after)
    .map((entry) => ({
      ...entry,
      before: normalizeSnapshot(entry.before),
      after: normalizeSnapshot(entry.after),
    }))
    .slice(0, 80);
}

function normalizeSnapshot(snapshot: AppDataSnapshot & { inventory?: AppData['inventory'] | Array<InventoryEntry & { code: string }> }): AppDataSnapshot {
  const empty = createEmptyData();
  return {
    version: 1,
    settings: { ...empty.settings, ...snapshot.settings },
    inventory: normalizeInventory(snapshot.inventory),
    stockLogs: Array.isArray(snapshot.stockLogs) ? snapshot.stockLogs : [],
    // Drop any image data URLs carried by legacy history snapshots so previously bloated
    // localStorage shrinks on next save (see stripProjectImages in domain.ts).
    projects: Array.isArray(snapshot.projects) ? snapshot.projects.map(stripProjectImageFields) : [],
    purchaseLists: Array.isArray(snapshot.purchaseLists) && snapshot.purchaseLists.length ? snapshot.purchaseLists : [createPurchaseList('默认采购表')],
  };
}

function stripProjectImageFields<T extends Record<string, unknown>>(project: T): T {
  const { imageUri, originalImageUri, croppedImageUri, ...rest } = project as Record<string, unknown>;
  return rest as T;
}

function normalizeInventory(inventory: AppData['inventory'] | Array<InventoryEntry & { code: string }> | undefined): AppData['inventory'] {
  if (!inventory) return {};
  if (Array.isArray(inventory)) {
    return inventory.reduce<AppData['inventory']>((next, entry) => {
      if (entry.code) {
        next[entry.code] = {
          quantity: Number(entry.quantity) || 0,
          lowStockThreshold: entry.lowStockThreshold,
        };
      }
      return next;
    }, {});
  }
  return inventory;
}
