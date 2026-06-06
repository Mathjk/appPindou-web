export type BeadBrand = 'MARD';

export type BeadColor = {
  brand: BeadBrand;
  palette: 'MARD_291';
  code: string;
  aliases: string[];
  nameZh?: string;
  nameEn?: string;
  series: string;
  number: number;
  sortOrder: number;
  hex: string;
  rgb: { r: number; g: number; b: number };
  inMard221: boolean;
  sourceRefs: string[];
};

export type InventoryEntry = {
  quantity: number;
  lowStockThreshold?: number;
};

export type StockLogType = 'purchase' | 'use' | 'adjust' | 'project-deduct';

export type StockLog = {
  id: string;
  type: StockLogType;
  code: string;
  delta: number;
  before: number;
  after: number;
  note?: string;
  projectId?: string;
  createdAt: string;
};

export type ProjectItem = {
  id: string;
  code: string;
  quantity: number;
  note?: string;
};

export type PatternProject = {
  id: string;
  name: string;
  status: 'planning' | 'active' | 'completed';
  imageUri?: string;
  originalImageUri?: string;
  croppedImageUri?: string;
  ocrStatus: 'not-started' | 'pending' | 'ready' | 'failed';
  ocrMessage?: string;
  ocrRawText?: string;
  ocrEngine?: string;
  ocrUpdatedAt?: string;
  items: ProjectItem[];
  deductedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type AppSettings = {
  inventoryPackSize: number;
  defaultLowStockThreshold: number;
  aiOcrApiKey: string;
  aiOcrEndpoint: string;
  aiOcrModel: string;
  aiOcrTextApiKey: string;
  aiOcrTextEndpoint: string;
  aiOcrTextModel: string;
  aiOcrUseSameKey: boolean;
};

export type PurchaseItem = {
  id: string;
  code: string;
  quantity: number;
};

export type PurchaseList = {
  id: string;
  name: string;
  packSize: number;
  items: PurchaseItem[];
  createdAt: string;
  updatedAt: string;
};

export type AppDataCore = {
  version: 1;
  settings: AppSettings;
  inventory: Record<string, InventoryEntry>;
  stockLogs: StockLog[];
  projects: PatternProject[];
  purchaseLists: PurchaseList[];
};

export type AppDataSnapshot = AppDataCore;

export type ActionHistoryEntry = {
  id: string;
  label: string;
  createdAt: string;
  undoneAt?: string;
  before: AppDataSnapshot;
  after: AppDataSnapshot;
};

export type AppData = AppDataCore & {
  actionHistory: ActionHistoryEntry[];
};

export type RequirementRow = {
  code: string;
  required: number;
  stock: number;
  missing: number;
  packsToBuy: number;
};

export type PurchaseRow = {
  code: string;
  quantity: number;
  packsToBuy: number;
};

export type OcrDraftResult = {
  status: 'ready' | 'failed';
  message: string;
  engine?: string;
  rawText?: string;
  items: Array<{ code: string; quantity: number; confidence?: number }>;
};
