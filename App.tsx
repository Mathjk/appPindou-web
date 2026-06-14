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
  accountErrorMessage,
  ensureProfileForSession,
  fetchAccountProfile,
  fetchCloudSnapshotMeta,
  getCurrentAccountSession,
  isSupabaseConfigured,
  loadCloudSnapshot,
  saveCloudSnapshot,
  signInWithUsername,
  signOutAccount,
  signUpWithUsername,
  subscribeToAccountChanges,
  validateAccountPassword,
  validateAccountUsername,
} from './src/account';
import {
  adjustStock,
  addProjectShortageToPurchaseList,
  addPurchaseItem,
  applyStockChange,
  buildPurchaseRows,
  buildRequirementRows,
  clampWholeNumber,
  completePurchaseList,
  createEmptyData,
  createPurchaseList,
  createProject,
  deductProjectInventory,
  deletePurchaseList,
  deleteProject,
  formatPurchaseRows,
  getInventoryStats,
  getProjectDeductCount,
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
import { exportAppData, loadAppData, parseImportedData, prepareAppDataForPersistence, saveAppData } from './src/storage';
import type { AccountProfile } from './src/account';
import type { AppData, AppSettings, PatternProject, ProjectItem, PurchaseList } from './src/types';

type TabKey = 'inventory' | 'projects' | 'shopping' | 'settings';
type UpdateData = (producer: (current: AppData) => AppData, label?: string, options?: { recordHistory?: boolean }) => string | undefined;
type ShowNotice = (message: string) => void;
type SettingsLeaveGuard = {
  hasUnsavedChanges: () => boolean;
  saveChanges: () => void;
  discardChanges: () => void;
};
type AccountStatus = 'unconfigured' | 'loading' | 'signed-out' | 'signed-in';
type AccountPanelState = {
  status: AccountStatus;
  profile?: AccountProfile;
  userId?: string;
  busy: boolean;
  syncing: boolean;
  message?: string;
  cloudUpdatedAt?: string;
  cloudSummary?: AppDataSummary;
  lastCloudCheckedAt?: string;
  lastSyncedAt?: string;
  pendingCloudSync: boolean;
  nextAutoSyncAt?: string;
  autoSyncReady: boolean;
};
type AccountActions = {
  signUp: (username: string, password: string, recoveryEmail?: string) => Promise<void>;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  uploadCloud: () => Promise<void>;
  restoreCloud: () => Promise<void>;
  refreshCloud: () => Promise<void>;
};
type AppDataSummary = {
  stockedColors: number;
  totalStock: number;
  projects: number;
  projectItems: number;
  purchaseLists: number;
  purchaseItems: number;
};
type OcrProgressStage = 'prepare' | 'vision' | 'text' | 'local';
type OcrProgressState = {
  stage: OcrProgressStage;
  startedAt: number;
  stageStartedAt: number;
  elapsedSeconds: number;
  stageElapsedSeconds: number;
};
type CropPixels = { originX: number; originY: number; width: number; height: number };
type DisplayCropRect = { x: number; y: number; width: number; height: number };
type CropGestureMode = 'move' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: 'inventory', label: '豆仓' },
  { key: 'projects', label: '图纸' },
  { key: 'shopping', label: '采购' },
  { key: 'settings', label: '设置' },
];

const CLOUD_SYNC_INTERVAL_OPTIONS = [
  { minutes: 0, label: '关闭' },
  { minutes: 5, label: '5 分钟' },
  { minutes: 15, label: '15 分钟' },
  { minutes: 30, label: '30 分钟' },
  { minutes: 60, label: '60 分钟' },
];

const SEARCH_SERIES_ORDER = [...MARD_SERIES_ORDER].sort((left, right) => right.length - left.length);
const NUMBER_PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
const ENABLE_SEARCH_NUMBER_PAD = false;

type AiPreset = {
  id: string;
  title: string;
  tag: string;
  endpoint: string;
  model: string;
  note: string;
  models: AiModelOption[];
};

type AiModelOption = {
  label: string;
  model: string;
  endpoint?: string;
  note?: string;
};

const TEXT_MODEL_PRESETS: AiPreset[] = [
  {
    id: 'openrouter-free',
    title: 'OpenRouter',
    tag: '免费路由',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'openrouter/free',
    note: '最适合先试用，会自动选择可用免费模型；稳定性取决于当前免费池。',
    models: [
      { label: 'Free Router', model: 'openrouter/free', note: '自动选择当前可用免费聊天模型。' },
      { label: 'Auto Router', model: 'openrouter/auto', note: '按请求自动路由，可能产生费用。' },
    ],
  },
  {
    id: 'deepseek-v4-flash',
    title: 'DeepSeek',
    tag: '默认推荐',
    endpoint: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-v4-flash',
    note: '适合把 OCR 原文整理成 JSON，用量低、中文指令稳定。',
    models: [
      { label: 'DeepSeek V4 Flash', model: 'deepseek-v4-flash', note: '当前默认。' },
      { label: 'DeepSeek Chat', model: 'deepseek-chat' },
      { label: 'DeepSeek Reasoner', model: 'deepseek-reasoner' },
    ],
  },
  {
    id: 'mistral-small',
    title: 'Mistral AI Studio',
    tag: '免费额度',
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    model: 'mistral-small-latest',
    note: '免费模式适合评估和原型；长期使用需要关注限额。',
    models: [
      { label: 'Mistral Small Latest', model: 'mistral-small-latest' },
      { label: 'Mistral Medium Latest', model: 'mistral-medium-latest' },
      { label: 'Mistral Large Latest', model: 'mistral-large-latest' },
    ],
  },
  {
    id: 'groq-llama',
    title: 'GroqCloud',
    tag: '高速',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    note: 'OpenAI-compatible，适合低延迟文本整理。',
    models: [
      { label: 'Llama 3.3 70B Versatile', model: 'llama-3.3-70b-versatile' },
      { label: 'Llama 3.1 8B Instant', model: 'llama-3.1-8b-instant' },
      { label: 'GPT OSS 120B', model: 'openai/gpt-oss-120b' },
      { label: 'GPT OSS 20B', model: 'openai/gpt-oss-20b' },
    ],
  },
  {
    id: 'hf-router',
    title: 'Hugging Face',
    tag: '模型多',
    endpoint: 'https://router.huggingface.co/v1/chat/completions',
    model: 'openai/gpt-oss-120b:fastest',
    note: '可换成 HF Inference Providers 里当前可用的聊天模型。',
    models: [
      { label: 'GPT OSS 120B Fastest', model: 'openai/gpt-oss-120b:fastest' },
      { label: 'GPT OSS 20B Fastest', model: 'openai/gpt-oss-20b:fastest' },
      { label: 'Qwen2.5 7B Instruct', model: 'Qwen/Qwen2.5-7B-Instruct:fastest' },
    ],
  },
  {
    id: 'cohere-command',
    title: 'Cohere',
    tag: '企业向',
    endpoint: 'https://api.cohere.ai/compatibility/v1/chat/completions',
    model: 'command-a-plus-05-2026',
    note: '通过 Compatibility API 接入，适合文本整理和结构化输出。',
    models: [
      { label: 'Command A Plus', model: 'command-a-plus-05-2026' },
      { label: 'Command A', model: 'command-a-03-2025' },
      { label: 'Command R Plus', model: 'command-r-plus' },
    ],
  },
  {
    id: 'cloudflare-workers',
    title: 'Cloudflare Workers AI',
    tag: '需账号ID',
    endpoint: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions',
    model: '@cf/meta/llama-3.1-8b-instruct',
    note: '需要把 {account_id} 替换成自己的 Cloudflare Account ID。',
    models: [
      { label: 'Llama 3.1 8B Instruct', model: '@cf/meta/llama-3.1-8b-instruct' },
      { label: 'Llama 3.1 70B Instruct', model: '@cf/meta/llama-3.1-70b-instruct' },
      { label: 'Llama 3.3 70B Fast', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
    ],
  },
  {
    id: 'cerebras-gpt-oss',
    title: 'Cerebras Inference',
    tag: '高速',
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    model: 'gpt-oss-120b',
    note: 'OpenAI-compatible，适合大模型高速文本整理。',
    models: [
      { label: 'GPT OSS 120B', model: 'gpt-oss-120b' },
      { label: 'GPT OSS 20B', model: 'gpt-oss-20b' },
      { label: 'Llama 3.3 70B', model: 'llama-3.3-70b' },
    ],
  },
  {
    id: 'openai-mini',
    title: 'OpenAI',
    tag: '主流',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4.1-mini',
    note: '主流稳定方案，成本低于旗舰模型，也可换成账号内可用的新模型。',
    models: [
      { label: 'GPT-4.1 Mini', model: 'gpt-4.1-mini' },
      { label: 'GPT-4.1', model: 'gpt-4.1' },
      { label: 'GPT-4o Mini', model: 'gpt-4o-mini' },
    ],
  },
  {
    id: 'gemini-flash',
    title: 'Google Gemini',
    tag: '主流',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-2.5-flash',
    note: 'Gemini OpenAI compatibility 接口，可用于文本整理。',
    models: [
      { label: 'Gemini 2.5 Flash', model: 'gemini-2.5-flash' },
      { label: 'Gemini 2.5 Pro', model: 'gemini-2.5-pro' },
      { label: 'Gemini 2.0 Flash', model: 'gemini-2.0-flash' },
    ],
  },
  {
    id: 'anthropic-claude',
    title: 'Anthropic Claude',
    tag: '已适配',
    endpoint: 'https://api.anthropic.com/v1/messages',
    model: 'claude-sonnet-4-20250514',
    note: '使用 Anthropic Messages API，文本整理和视觉识别都已单独适配。',
    models: [
      { label: 'Claude Sonnet 4', model: 'claude-sonnet-4-20250514' },
      { label: 'Claude Opus 4.1', model: 'claude-opus-4-1-20250805' },
      { label: 'Claude 3.5 Haiku', model: 'claude-3-5-haiku-latest' },
    ],
  },
];

const VISION_MODEL_PRESETS: AiPreset[] = [
  {
    id: 'ocr-space',
    title: 'OCR.space',
    tag: '免费测试',
    endpoint: 'https://api.ocr.space/parse/image',
    model: 'ocr.space-engine2',
    note: '当前默认方案；免费测试 key 可走通流程，稳定使用建议换自己的 key。',
    models: [
      { label: 'Engine 2', model: 'ocr.space-engine2' },
      { label: 'Engine 1', model: 'ocr.space-engine1' },
      { label: 'Engine 3', model: 'ocr.space-engine3' },
    ],
  },
  {
    id: 'openrouter-vision',
    title: 'OpenRouter Vision',
    tag: '免费路由',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'openrouter/free',
    note: '当前代码支持 image_url 消息；路由会筛选支持图片理解的免费模型。',
    models: [
      { label: 'Free Vision Router', model: 'openrouter/free' },
      { label: 'Auto Router', model: 'openrouter/auto' },
    ],
  },
  {
    id: 'groq-vision',
    title: 'GroqCloud Vision',
    tag: '高速',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    note: '支持 image_url 的视觉模型；裁剪图过大时需要注意请求大小限制。',
    models: [
      { label: 'Llama 4 Scout Vision', model: 'meta-llama/llama-4-scout-17b-16e-instruct' },
      { label: 'Llama 4 Maverick Vision', model: 'meta-llama/llama-4-maverick-17b-128e-instruct' },
    ],
  },
  {
    id: 'mistral-vision',
    title: 'Mistral Vision',
    tag: '免费额度',
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    model: 'mistral-small-2506',
    note: '走 Mistral Chat Completions 视觉模型；不同于 Mistral 专用 OCR 接口。',
    models: [
      { label: 'Mistral Small 2506 Vision', model: 'mistral-small-2506' },
      { label: 'Pixtral 12B', model: 'pixtral-12b-latest' },
      { label: 'Pixtral Large', model: 'pixtral-large-latest' },
    ],
  },
  {
    id: 'mistral-ocr',
    title: 'Mistral OCR',
    tag: '已适配',
    endpoint: 'https://api.mistral.ai/v1/ocr',
    model: 'mistral-ocr-latest',
    note: '使用 Mistral 专用 OCR API，适合直接抽取图中文字。',
    models: [
      { label: 'Mistral OCR Latest', model: 'mistral-ocr-latest' },
    ],
  },
  {
    id: 'openai-vision',
    title: 'OpenAI Vision',
    tag: '主流',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4.1-mini',
    note: '适合直接从裁剪图里识别色号和数量；需要 OpenAI API key。',
    models: [
      { label: 'GPT-4.1 Mini Vision', model: 'gpt-4.1-mini' },
      { label: 'GPT-4.1 Vision', model: 'gpt-4.1' },
      { label: 'GPT-4o Mini Vision', model: 'gpt-4o-mini' },
    ],
  },
  {
    id: 'gemini-vision',
    title: 'Google Gemini Vision',
    tag: '主流',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-2.5-flash',
    note: 'Gemini OpenAI compatibility 支持图片输入，可作为 OCR.space 的替代。',
    models: [
      { label: 'Gemini 2.5 Flash Vision', model: 'gemini-2.5-flash' },
      { label: 'Gemini 2.5 Pro Vision', model: 'gemini-2.5-pro' },
      { label: 'Gemini 2.0 Flash Vision', model: 'gemini-2.0-flash' },
    ],
  },
  {
    id: 'hf-vlm',
    title: 'Hugging Face VLM',
    tag: '可选',
    endpoint: 'https://router.huggingface.co/v1/chat/completions',
    model: 'Qwen/Qwen2.5-VL-3B-Instruct:fastest',
    note: '适合尝试开源视觉语言模型；可换成 HF 当前可用的 VLM。',
    models: [
      { label: 'Qwen2.5 VL 3B Fastest', model: 'Qwen/Qwen2.5-VL-3B-Instruct:fastest' },
      { label: 'Llama 3.2 11B Vision', model: 'meta-llama/Llama-3.2-11B-Vision-Instruct:fastest' },
    ],
  },
  {
    id: 'azure-vision-read',
    title: 'Azure AI Vision',
    tag: '已适配',
    endpoint: 'https://{resource}.cognitiveservices.azure.com/imageanalysis:analyze?features=read&api-version=2024-02-01',
    model: 'azure-vision-read-2024-02-01',
    note: '使用 Image Analysis 4.0 Read OCR，同步返回 readResult；需要替换 {resource}。',
    models: [
      { label: 'Read OCR 2024-02-01', model: 'azure-vision-read-2024-02-01' },
    ],
  },
  {
    id: 'anthropic-vision',
    title: 'Anthropic Claude',
    tag: '已适配',
    endpoint: 'https://api.anthropic.com/v1/messages',
    model: 'claude-sonnet-4-20250514',
    note: '使用 Anthropic Messages API 视觉格式，图片以 base64 块发送。',
    models: [
      { label: 'Claude Sonnet 4 Vision', model: 'claude-sonnet-4-20250514' },
      { label: 'Claude Opus 4.1 Vision', model: 'claude-opus-4-1-20250805' },
      { label: 'Claude 3.5 Haiku Vision', model: 'claude-3-5-haiku-latest' },
    ],
  },
  {
    id: 'cloudflare-vision',
    title: 'Cloudflare Workers AI 视觉',
    tag: '已适配',
    endpoint: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/meta/llama-3.2-11b-vision-instruct',
    model: '@cf/meta/llama-3.2-11b-vision-instruct',
    note: '使用 Workers AI 原生 /ai/run 视觉模型；需要替换 {account_id}。',
    models: [
      { label: 'Llama 3.2 11B Vision', model: '@cf/meta/llama-3.2-11b-vision-instruct' },
    ],
  },
];

function normalizeSearchQuery(value: string) {
  return value.replace(/[a-z]/g, (letter) => letter.toUpperCase()).trimStart();
}

function getSearchSeries(value: string) {
  const normalized = normalizeSearchQuery(value).trim();
  return SEARCH_SERIES_ORDER.find((item) => normalized === item || new RegExp(`^${item}\\d*$`).test(normalized));
}

function getAiModelOptions(preset?: AiPreset) {
  return preset?.models?.length
    ? preset.models
    : preset
      ? [{ label: preset.model, model: preset.model, note: preset.note }]
      : [];
}

function findAiPreset(presets: AiPreset[], endpoint: string, model: string) {
  const trimmedEndpoint = endpoint.trim();
  const trimmedModel = model.trim();
  return (
    presets.find((preset) => preset.endpoint === trimmedEndpoint && preset.model === trimmedModel) ??
    presets.find((preset) => preset.endpoint === trimmedEndpoint && getAiModelOptions(preset).some((option) => option.model === trimmedModel)) ??
    presets.find((preset) => preset.endpoint === trimmedEndpoint)
  );
}

function findAiModelOption(preset: AiPreset | undefined, model: string) {
  return getAiModelOptions(preset).find((option) => option.model === model.trim());
}

function getAiServiceKey(preset: AiPreset | undefined, endpoint: string) {
  const trimmedEndpoint = endpoint.trim();
  return preset?.id ?? (trimmedEndpoint ? `custom:${trimmedEndpoint}` : 'custom');
}

function getStoredApiKey(keyMap: Record<string, string>, serviceKey: string, fallback = '') {
  return Object.prototype.hasOwnProperty.call(keyMap, serviceKey) ? keyMap[serviceKey] : fallback;
}

function rememberApiKey(keyMap: Record<string, string>, serviceKey: string, apiKey: string) {
  return {
    ...keyMap,
    [serviceKey]: apiKey,
  };
}

function compactKeyMap(keyMap: Record<string, string>) {
  return Object.entries(keyMap).reduce<Record<string, string>>((next, [key, value]) => {
    const trimmed = value.trim();
    if (trimmed || key === 'ocr-space') next[key] = trimmed;
    return next;
  }, {});
}

function makeDatedName(prefix: string) {
  return `${prefix} ${new Date().toLocaleDateString()}`;
}

function makeUniqueName(baseName: string, existingNames: string[]) {
  const trimmedBase = baseName.trim();
  const usedNames = new Set(existingNames.map((item) => item.trim()).filter(Boolean));
  if (!usedNames.has(trimmedBase)) return trimmedBase;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${trimmedBase}（${index}）`;
    if (!usedNames.has(candidate)) return candidate;
  }
  return `${trimmedBase}（${Date.now().toString(36)}）`;
}

function getOcrStageTitle(stage: OcrProgressStage) {
  switch (stage) {
    case 'prepare':
      return '准备识别图';
    case 'vision':
      return '图片 OCR 识别中';
    case 'text':
      return '文本 AI 整理中';
    case 'local':
      return '本地解析 OCR 文本';
  }
}

function getOcrStageNotice(stage: OcrProgressStage) {
  switch (stage) {
    case 'prepare':
      return '正在准备识别图...';
    case 'vision':
      return '图片 OCR 识别中...';
    case 'text':
      return '图片 OCR 已完成，正在调用文本 AI 整理...';
    case 'local':
      return '图片 OCR 已完成，正在用本地规则解析...';
  }
}

function formatDuration(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return minutes ? `${minutes}分${seconds.toString().padStart(2, '0')}秒` : `${seconds}秒`;
}

function summarizeAppData(data: AppData): AppDataSummary {
  const inventoryEntries = Object.values(data.inventory);
  return {
    stockedColors: inventoryEntries.filter((entry) => (entry.quantity ?? 0) > 0).length,
    totalStock: inventoryEntries.reduce((sum, entry) => sum + Math.max(0, entry.quantity ?? 0), 0),
    projects: data.projects.length,
    projectItems: data.projects.reduce((sum, project) => sum + project.items.length, 0),
    purchaseLists: data.purchaseLists.length,
    purchaseItems: data.purchaseLists.reduce((sum, list) => sum + list.items.length, 0),
  };
}

function formatDataSummary(summary: AppDataSummary) {
  return `库存 ${summary.stockedColors} 色/${summary.totalStock} 颗 · 图纸 ${summary.projects} 份/${summary.projectItems} 项 · 采购 ${summary.purchaseLists} 表/${summary.purchaseItems} 项`;
}

function normalizeCloudSyncIntervalMinutes(value: unknown) {
  const minutes = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 5;
  return CLOUD_SYNC_INTERVAL_OPTIONS.some((option) => option.minutes === minutes) ? minutes : 5;
}

function getCloudSyncIntervalMs(minutes: number) {
  return normalizeCloudSyncIntervalMinutes(minutes) * 60 * 1000;
}

function createCloudSyncSignature(data: AppData) {
  return JSON.stringify(prepareAppDataForPersistence(data));
}

function createOcrProgress(stage: OcrProgressStage, previous?: OcrProgressState): OcrProgressState {
  const now = Date.now();
  const startedAt = previous?.startedAt ?? now;
  return {
    stage,
    startedAt,
    stageStartedAt: now,
    elapsedSeconds: Math.floor((now - startedAt) / 1000),
    stageElapsedSeconds: 0,
  };
}

function useResponsiveViewport() {
  const viewport = useWindowDimensions();
  const [webViewportHeight, setWebViewportHeight] = useState(viewport.height);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const updateHeight = () => {
      setWebViewportHeight(Math.round(window.visualViewport?.height ?? window.innerHeight ?? viewport.height));
    };
    updateHeight();
    window.visualViewport?.addEventListener('resize', updateHeight);
    window.addEventListener('resize', updateHeight);
    return () => {
      window.visualViewport?.removeEventListener('resize', updateHeight);
      window.removeEventListener('resize', updateHeight);
    };
  }, [viewport.height]);

  return {
    ...viewport,
    height: Platform.OS === 'web' ? webViewportHeight : viewport.height,
  };
}

function useWebViewportKeyboardResize() {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    const content = meta.getAttribute('content') ?? '';
    if (content.includes('interactive-widget=')) return;
    meta.setAttribute('content', `${content}, interactive-widget=resizes-content`);
  }, []);
}

export default function App() {
  const viewport = useResponsiveViewport();
  const [tab, setTab] = useState<TabKey>('inventory');
  const [data, setData] = useState<AppData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState('');
  const [noticeUndoId, setNoticeUndoId] = useState<string | undefined>();
  const [pendingSettingsTab, setPendingSettingsTab] = useState<TabKey | undefined>();
  const [account, setAccount] = useState<AccountPanelState>(() => ({
    status: isSupabaseConfigured ? 'loading' : 'unconfigured',
    busy: false,
    syncing: false,
    pendingCloudSync: false,
    autoSyncReady: false,
    message: isSupabaseConfigured ? '正在检查登录状态...' : 'Supabase 尚未配置',
  }));
  const lastHistoryIdRef = useRef<string | undefined>(undefined);
  const settingsLeaveGuardRef = useRef<SettingsLeaveGuard | undefined>(undefined);
  const dataRef = useRef<AppData | null>(null);
  const autoSyncTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastCloudSyncSignatureRef = useRef<string | undefined>(undefined);
  const pendingCloudSyncRef = useRef(false);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const loadAccountForSession = async (
    session: Awaited<ReturnType<typeof getCurrentAccountSession>>,
    message?: string,
    options?: { keepAutoSync?: boolean },
  ) => {
    if (!options?.keepAutoSync) {
      clearAutoSyncTimer();
      lastCloudSyncSignatureRef.current = undefined;
      pendingCloudSyncRef.current = false;
    }
    if (!isSupabaseConfigured) {
      setAccount({
        status: 'unconfigured',
        busy: false,
        syncing: false,
        pendingCloudSync: false,
        autoSyncReady: false,
        message: 'Supabase 尚未配置',
      });
      return;
    }
    if (!session?.user) {
      setAccount({
        status: 'signed-out',
        busy: false,
        syncing: false,
        pendingCloudSync: false,
        autoSyncReady: false,
        message: message ?? '未登录，当前仍使用本地数据',
      });
      return;
    }

    setAccount((current) => ({
      ...current,
      status: 'signed-in',
      userId: session.user.id,
      busy: false,
      syncing: false,
      message: message ?? current.message,
      pendingCloudSync: options?.keepAutoSync ? current.pendingCloudSync : false,
      nextAutoSyncAt: options?.keepAutoSync ? current.nextAutoSyncAt : undefined,
      autoSyncReady: options?.keepAutoSync ? current.autoSyncReady : false,
    }));

    try {
      await ensureProfileForSession(session).catch(() => undefined);
      const [profile, cloudMeta] = await Promise.all([fetchAccountProfile(), fetchCloudSnapshotMeta()]);
      const fallbackProfile: AccountProfile = {
        id: session.user.id,
        username: String(session.user.user_metadata?.username ?? '未命名账号'),
        recovery_email: String(session.user.user_metadata?.recovery_email ?? '') || null,
      };
      setAccount((current) => ({
        ...current,
        status: 'signed-in',
        userId: session.user.id,
        profile: profile ?? fallbackProfile,
        cloudUpdatedAt: cloudMeta?.updated_at ?? cloudMeta?.client_updated_at ?? undefined,
        cloudSummary: cloudMeta && current.userId === session.user.id ? current.cloudSummary : undefined,
        lastCloudCheckedAt: cloudMeta && current.userId === session.user.id ? current.lastCloudCheckedAt : undefined,
        busy: false,
        syncing: false,
        message: message ?? (cloudMeta ? '已登录，云端已有数据，可选择恢复或上传覆盖' : '已登录，云端还没有快照'),
        pendingCloudSync: options?.keepAutoSync ? current.pendingCloudSync : false,
        nextAutoSyncAt: options?.keepAutoSync ? current.nextAutoSyncAt : undefined,
        autoSyncReady: options?.keepAutoSync ? current.autoSyncReady : false,
      }));
    } catch (error) {
      setAccount((current) => ({
        ...current,
        status: 'signed-in',
        userId: session.user.id,
        busy: false,
        syncing: false,
        pendingCloudSync: current.pendingCloudSync,
        message: accountErrorMessage(error),
      }));
    }
  };

  useEffect(() => {
    loadAppData()
      .then(setData)
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    let alive = true;
    if (!isSupabaseConfigured) return;
    getCurrentAccountSession()
      .then((session) => {
        if (alive) void loadAccountForSession(session);
      })
      .catch((error) => {
        if (!alive) return;
        setAccount((current) => ({
          ...current,
          status: 'signed-out',
          busy: false,
          syncing: false,
          message: accountErrorMessage(error),
        }));
      });
    const unsubscribe = subscribeToAccountChanges((session) => {
      if (alive) void loadAccountForSession(session, undefined, { keepAutoSync: true });
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  useWebViewportKeyboardResize();

  useEffect(() => {
    if (loaded && data) {
      saveAppData(data).catch(() => {
        setNotice('本地保存失败，请稍后重试');
        setNoticeUndoId(undefined);
      });
    }
  }, [data, loaded]);

  const clearAutoSyncTimer = () => {
    if (autoSyncTimerRef.current) {
      clearTimeout(autoSyncTimerRef.current);
      autoSyncTimerRef.current = undefined;
    }
  };

  const syncCurrentDataToCloud = async (mode: 'auto' | 'manual' | 'logout') => {
    const currentData = dataRef.current;
    if (!currentData) {
      setAccount((current) => ({ ...current, busy: false, syncing: false, message: '没有可同步的数据' }));
      return false;
    }

    clearAutoSyncTimer();
    const syncingMessage = mode === 'logout' ? '退出前正在同步到云端...' : mode === 'auto' ? '正在自动同步到云端...' : '正在上传本机数据到云端...';
    setAccount((current) => ({
      ...current,
      busy: mode !== 'auto',
      syncing: true,
      message: syncingMessage,
    }));

    try {
      const meta = await saveCloudSnapshot(currentData);
      const syncedAt = new Date().toISOString();
      const summary = summarizeAppData(currentData);
      lastCloudSyncSignatureRef.current = createCloudSyncSignature(currentData);
      pendingCloudSyncRef.current = false;
      setAccount((current) => ({
        ...current,
        busy: false,
        syncing: false,
        pendingCloudSync: false,
        nextAutoSyncAt: undefined,
        autoSyncReady: true,
        cloudUpdatedAt: meta.updated_at ?? meta.client_updated_at ?? syncedAt,
        cloudSummary: summary,
        lastCloudCheckedAt: syncedAt,
        lastSyncedAt: syncedAt,
        message: mode === 'logout' ? '退出前已同步到云端' : mode === 'auto' ? '已自动同步到云端' : '已上传本机数据，并开启本次自动同步',
      }));
      if (mode === 'manual') setNotice('本机数据已上传到云端');
      return true;
    } catch (error) {
      const message = accountErrorMessage(error);
      setAccount((current) => ({
        ...current,
        busy: false,
        syncing: false,
        message,
      }));
      setNotice(message);
      return false;
    }
  };

  useEffect(() => {
    if (!loaded || !data || account.status !== 'signed-in' || !account.autoSyncReady) return;
    const currentSignature = createCloudSyncSignature(data);
    if (lastCloudSyncSignatureRef.current === currentSignature) {
      if (pendingCloudSyncRef.current || account.pendingCloudSync) {
        pendingCloudSyncRef.current = false;
        setAccount((current) => ({ ...current, pendingCloudSync: false, nextAutoSyncAt: undefined }));
      }
      return;
    }

    pendingCloudSyncRef.current = true;
    const intervalMs = getCloudSyncIntervalMs(data.settings.cloudAutoSyncIntervalMinutes);
    const nextAutoSyncAt = intervalMs > 0 ? new Date(Date.now() + intervalMs).toISOString() : undefined;
    clearAutoSyncTimer();
    setAccount((current) => ({
      ...current,
      pendingCloudSync: true,
      nextAutoSyncAt,
      message: intervalMs > 0 ? `本机有未同步更改，将在 ${formatCloudTime(nextAutoSyncAt ?? '')} 自动同步` : '本机有未同步更改，自动同步已关闭',
    }));
    if (!intervalMs) return;

    autoSyncTimerRef.current = setTimeout(() => {
      void syncCurrentDataToCloud('auto');
    }, intervalMs);
    return clearAutoSyncTimer;
  }, [data, loaded, account.status, account.userId, account.autoSyncReady]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      const currentData = dataRef.current;
      const hasUnsyncedChanges =
        account.status === 'signed-in' &&
        account.autoSyncReady &&
        currentData &&
        (pendingCloudSyncRef.current || lastCloudSyncSignatureRef.current !== createCloudSyncSignature(currentData));
      if (!hasUnsyncedChanges) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [account.status, account.autoSyncReady, account.userId]);

  const showNotice: ShowNotice = (message) => {
    setNotice(message);
    setNoticeUndoId(message ? lastHistoryIdRef.current : undefined);
    lastHistoryIdRef.current = undefined;
  };

  const requestTabChange = (nextTab: TabKey) => {
    if (nextTab === tab) return;
    if (tab === 'settings' && settingsLeaveGuardRef.current?.hasUnsavedChanges()) {
      setPendingSettingsTab(nextTab);
      return;
    }
    setTab(nextTab);
  };

  const completeSettingsNavigation = (mode: 'save' | 'discard') => {
    const nextTab = pendingSettingsTab;
    if (mode === 'save') {
      settingsLeaveGuardRef.current?.saveChanges();
    } else {
      settingsLeaveGuardRef.current?.discardChanges();
    }
    setPendingSettingsTab(undefined);
    if (nextTab) setTab(nextTab);
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

  const markAccountBusy = (message: string) => {
    setAccount((current) => ({ ...current, busy: true, message }));
  };

  const completeAccountLogin = async (session: Awaited<ReturnType<typeof getCurrentAccountSession>>, successNotice: string) => {
    if (!session?.user) {
      setAccount({
        status: 'signed-out',
        busy: false,
        syncing: false,
        pendingCloudSync: false,
        autoSyncReady: false,
        message: '注册已提交，但当前 Supabase 项目要求邮箱确认；请关闭 Auth 邮箱确认后再使用用户名登录',
      });
      showNotice('注册已提交，但需要先关闭 Supabase 邮箱确认');
      return;
    }

    await loadAccountForSession(session, successNotice);
    try {
      const cloudMeta = await fetchCloudSnapshotMeta();
      const currentData = dataRef.current;
      if (!cloudMeta && currentData) {
        const savedMeta = await saveCloudSnapshot(currentData);
        lastCloudSyncSignatureRef.current = createCloudSyncSignature(currentData);
        pendingCloudSyncRef.current = false;
        setAccount((current) => ({
          ...current,
          busy: false,
          autoSyncReady: true,
          pendingCloudSync: false,
          nextAutoSyncAt: undefined,
          cloudUpdatedAt: savedMeta.updated_at ?? savedMeta.client_updated_at ?? new Date().toISOString(),
          cloudSummary: summarizeAppData(currentData),
          lastCloudCheckedAt: new Date().toISOString(),
          lastSyncedAt: new Date().toISOString(),
          message: '已创建云端快照，并开启本次自动同步',
        }));
        showNotice(`${successNotice}，已创建云端备份`);
        return;
      }
      setAccount((current) => ({
        ...current,
        busy: false,
        autoSyncReady: false,
        cloudUpdatedAt: cloudMeta?.updated_at ?? cloudMeta?.client_updated_at ?? current.cloudUpdatedAt,
        cloudSummary: cloudMeta ? current.cloudSummary : undefined,
        message: cloudMeta ? '已登录，云端已有快照，请选择恢复或上传覆盖' : successNotice,
      }));
      showNotice(cloudMeta ? '已登录；云端已有数据，先选择恢复或上传' : successNotice);
    } catch (error) {
      setAccount((current) => ({
        ...current,
        busy: false,
        message: accountErrorMessage(error),
      }));
      showNotice(accountErrorMessage(error));
    }
  };

  const accountActions: AccountActions = {
    signUp: async (username, password, recoveryEmail) => {
      markAccountBusy('正在注册账号...');
      try {
        const result = await signUpWithUsername(username, password, recoveryEmail);
        await completeAccountLogin(result.session, '注册并登录成功');
      } catch (error) {
        const message = accountErrorMessage(error);
        setAccount((current) => ({ ...current, busy: false, message }));
        showNotice(message);
      }
    },
    signIn: async (username, password) => {
      markAccountBusy('正在登录...');
      try {
        const result = await signInWithUsername(username, password);
        await completeAccountLogin(result.session, '登录成功');
      } catch (error) {
        const message = accountErrorMessage(error);
        setAccount((current) => ({ ...current, busy: false, message }));
        showNotice(message);
      }
    },
    signOut: async () => {
      markAccountBusy('正在退出登录...');
      try {
        clearAutoSyncTimer();
        const currentData = dataRef.current;
        const hasUnsyncedChanges =
          account.autoSyncReady &&
          currentData &&
          (pendingCloudSyncRef.current || lastCloudSyncSignatureRef.current !== createCloudSyncSignature(currentData));
        if (hasUnsyncedChanges) {
          const synced = await syncCurrentDataToCloud('logout');
          if (!synced) return;
        }
        setAccount((current) => ({ ...current, busy: true, syncing: false, message: '正在退出登录...' }));
        await signOutAccount();
        lastCloudSyncSignatureRef.current = undefined;
        pendingCloudSyncRef.current = false;
        setAccount({
          status: 'signed-out',
          busy: false,
          syncing: false,
          pendingCloudSync: false,
          autoSyncReady: false,
          message: '已退出登录，本机数据仍保留',
        });
        showNotice('已退出登录');
      } catch (error) {
        const message = accountErrorMessage(error);
        setAccount((current) => ({ ...current, busy: false, message }));
        showNotice(message);
      }
    },
    uploadCloud: async () => {
      await syncCurrentDataToCloud('manual');
    },
    restoreCloud: async () => {
      markAccountBusy('正在从云端恢复...');
      try {
        const snapshot = await loadCloudSnapshot();
        if (!snapshot) {
          setAccount((current) => ({
            ...current,
            busy: false,
            cloudUpdatedAt: undefined,
            cloudSummary: undefined,
            lastCloudCheckedAt: new Date().toISOString(),
            message: '云端还没有快照。可以先点“上传本机数据”。',
          }));
          showNotice('云端还没有快照');
          return;
        }
        setData(snapshot.data);
        const restoredSummary = summarizeAppData(snapshot.data);
        lastCloudSyncSignatureRef.current = createCloudSyncSignature(snapshot.data);
        pendingCloudSyncRef.current = false;
        setAccount((current) => ({
          ...current,
          busy: false,
          autoSyncReady: true,
          pendingCloudSync: false,
          nextAutoSyncAt: undefined,
          cloudUpdatedAt: snapshot.meta.updated_at ?? snapshot.meta.client_updated_at ?? current.cloudUpdatedAt,
          cloudSummary: restoredSummary,
          lastCloudCheckedAt: new Date().toISOString(),
          lastSyncedAt: new Date().toISOString(),
          message: `已从云端恢复：${formatDataSummary(restoredSummary)}`,
        }));
        showNotice(`已从云端恢复：${formatDataSummary(restoredSummary)}`);
      } catch (error) {
        const message = accountErrorMessage(error);
        setAccount((current) => ({ ...current, busy: false, message }));
        showNotice(message);
      }
    },
    refreshCloud: async () => {
      markAccountBusy('正在刷新云端状态...');
      try {
        const session = await getCurrentAccountSession();
        if (!session?.user) {
          await loadAccountForSession(session, '未登录，无法刷新云端状态', { keepAutoSync: true });
          showNotice('未登录，无法刷新云端状态');
          return;
        }
        const [profile, snapshot] = await Promise.all([fetchAccountProfile(), loadCloudSnapshot()]);
        const checkedAt = new Date().toISOString();
        if (!snapshot) {
          setAccount((current) => ({
            ...current,
            status: 'signed-in',
            userId: session.user.id,
            profile: profile ?? current.profile,
            busy: false,
            syncing: false,
            cloudUpdatedAt: undefined,
            cloudSummary: undefined,
            lastCloudCheckedAt: checkedAt,
            message: '云端还没有快照。可以先点“上传本机数据”。',
          }));
          showNotice('云端还没有快照，可以先上传本机数据');
          return;
        }
        const summary = summarizeAppData(snapshot.data);
        setAccount((current) => ({
          ...current,
          status: 'signed-in',
          userId: session.user.id,
          profile: profile ?? current.profile,
          busy: false,
          syncing: false,
          cloudUpdatedAt: snapshot.meta.updated_at ?? snapshot.meta.client_updated_at ?? undefined,
          cloudSummary: summary,
          lastCloudCheckedAt: checkedAt,
          message: `云端状态已刷新：${formatDataSummary(summary)}`,
          autoSyncReady: current.autoSyncReady,
        }));
        showNotice(`云端状态已刷新：${formatDataSummary(summary)}`);
      } catch (error) {
        const message = accountErrorMessage(error);
        setAccount((current) => ({ ...current, busy: false, message }));
        showNotice(message);
      }
    },
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
        {tab === 'inventory' ? (
          <View style={styles.header}>
            <Text style={[styles.brand, styles.headerBrand]}>MARD 豆仓</Text>
            <View style={styles.headerCoverage}>
              <Text style={styles.headerCoverageText}>
                {stats.stocked}/{stats.totalColors}
              </Text>
            </View>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{stats.low} 低库存</Text>
            </View>
          </View>
        ) : null}

        {notice ? (
          <View style={styles.notice}>
            <View style={styles.noticeInline}>
              <Text style={styles.noticeText}>{notice}</Text>
              <View style={styles.noticeActions}>
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
          </View>
        ) : null}

        <View style={styles.content}>
          {tab === 'inventory' ? <InventoryScreen data={data} updateData={updateData} setNotice={showNotice} /> : null}
          {tab === 'projects' ? <ProjectsScreen data={data} updateData={updateData} setNotice={showNotice} /> : null}
          {tab === 'shopping' ? <ShoppingScreen data={data} updateData={updateData} setNotice={showNotice} /> : null}
          {tab === 'settings' ? (
            <SettingsScreen
              data={data}
              updateData={updateData}
              setNotice={showNotice}
              account={account}
              accountActions={accountActions}
              registerLeaveGuard={(guard) => {
                settingsLeaveGuardRef.current = guard;
              }}
            />
          ) : null}
        </View>

        <View style={styles.tabbar}>
          {tabs.map((item) => (
            <Pressable key={item.key} style={[styles.tab, tab === item.key && styles.tabActive]} onPress={() => requestTabChange(item.key)}>
              <Text style={[styles.tabText, tab === item.key && styles.tabTextActive]}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
        <UnsavedSettingsPrompt
          visible={Boolean(pendingSettingsTab)}
          onSave={() => completeSettingsNavigation('save')}
          onDiscard={() => completeSettingsNavigation('discard')}
          onCancel={() => setPendingSettingsTab(undefined)}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function UnsavedSettingsPrompt({
  visible,
  onSave,
  onDiscard,
  onCancel,
}: {
  visible: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.promptBackdrop}>
        <View style={styles.promptPanel}>
          <Text style={styles.panelTitle}>设置尚未保存</Text>
          <Text style={styles.muted}>离开设置页前，选择保存本次更改，或者放弃未保存内容。</Text>
          <View style={styles.promptActions}>
            <ActionButton label="继续编辑" onPress={onCancel} tone="neutral" />
            <ActionButton label="不保存" onPress={onDiscard} tone="danger" />
            <ActionButton label="保存" onPress={onSave} tone="amber" />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function CloudRestorePrompt({
  visible,
  cloudUpdatedAt,
  cloudSummary,
  localSummary,
  busy,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  cloudUpdatedAt?: string;
  cloudSummary?: AppDataSummary;
  localSummary: AppDataSummary;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.promptBackdrop}>
        <View style={styles.promptPanel}>
          <Text style={styles.panelTitle}>从云端恢复</Text>
          <Text style={styles.muted}>确认后会从 Supabase 读取最新快照，并覆盖当前本机数据。继续前建议先导出一份本地备份。</Text>
          <View style={styles.restoreCompare}>
            <View style={styles.restoreColumn}>
              <Text style={styles.accountSnapshotTitle}>当前本机</Text>
              <Text style={styles.accountSnapshotText}>{formatDataSummary(localSummary)}</Text>
            </View>
            <View style={styles.restoreColumn}>
              <Text style={styles.accountSnapshotTitle}>云端快照</Text>
              <Text style={styles.accountSnapshotText}>{cloudSummary ? formatDataSummary(cloudSummary) : '确认时会重新查询云端'}</Text>
              <Text style={styles.accountSnapshotMeta}>{cloudUpdatedAt ? formatCloudTime(cloudUpdatedAt) : '尚未读取到快照时间'}</Text>
            </View>
          </View>
          <View style={styles.promptActions}>
            <ActionButton label="取消" onPress={onCancel} tone="neutral" />
            <ActionButton label={busy ? '恢复中...' : '确认恢复'} onPress={busy ? () => undefined : onConfirm} tone="danger" />
          </View>
        </View>
      </View>
    </Modal>
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
  const viewport = useResponsiveViewport();
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
  const keyboardCompactInventory = compactInventory && searchFocused;
  const searchMode = keyboardCompactInventory;
  const stickyPanelMaxHeight = compactInventory
    ? searchMode
      ? 66
      : Math.max(218, Math.min(250, viewport.height * 0.32))
    : undefined;
  const showSearchNumberPad = ENABLE_SEARCH_NUMBER_PAD && Platform.OS === 'web' && searchFocused && searchKeypadVisible && Boolean(searchSeries);

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
    setSearchKeypadVisible(ENABLE_SEARCH_NUMBER_PAD && Boolean(inferredSeries));
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
          searchMode && styles.stickyPanelSearchMode,
          compactInventory && { maxHeight: stickyPanelMaxHeight },
        ]}
      >
        <ScrollView
          scrollEnabled={compactInventory && !searchMode}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={compactInventory && !searchMode}
          contentContainerStyle={compactInventory ? styles.stickyPanelContentCompact : undefined}
        >
        <View style={[styles.selectedRow, searchMode && styles.selectedRowSearchMode]}>
          <ColorSwatch color={selectedColor.hex} compact />
          <View style={styles.flex}>
            <Text style={styles.selectedCodeText}>{selectedColor.code}</Text>
            <Text style={[styles.muted, styles.selectedColorMeta]}>
              {selectedColor.nameZh || selectedColor.nameEn || '参考色名缺失'} · 当前库存 {selectedStock} 颗
            </Text>
          </View>
        </View>

        {searchMode ? null : (
          <>
        <View style={styles.inventoryActionGrid}>
          <View style={styles.inputBlockGrid}>
            <Text style={styles.label}>颗数</Text>
            <View style={styles.actionInputRow}>
              <TextInput style={[styles.input, styles.actionInput]} value={amount} onChangeText={setAmount} keyboardType="number-pad" accessibilityLabel="颗数" />
              <RoundActionButton label="+" accessibilityLabel="按颗增加" tone="plus" onPress={() => mutateSelected('amount-add')} />
              <RoundActionButton label="-" accessibilityLabel="按颗减少" tone="minus" onPress={() => mutateSelected('amount-remove')} />
            </View>
          </View>
          <View style={styles.inputBlockGrid}>
            <Pressable
              style={styles.packLabelRow}
              accessibilityLabel="修改份规格"
              onPress={() => {
                setInventoryPackSize(String(data.settings.inventoryPackSize));
                setEditingPackSize(true);
              }}
            >
              <Text style={styles.label}>
                份数（当前每份<Text style={styles.packSizeLink}>{packSize}</Text>颗）
              </Text>
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
          <View style={[styles.purchasePickerBlock, compactInventory && styles.purchasePickerBlockCompact]}>
            {compactInventory ? null : <Text style={styles.label}>加入采购表</Text>}
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
          </>
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
              if (ENABLE_SEARCH_NUMBER_PAD && searchSeries) setSearchKeypadVisible(true);
            }}
            onBlur={() => {
              setSearchFocused(false);
              setSearchKeypadVisible(false);
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
                <ColorSwatch color={color.hex} compact />
                <View style={styles.flex}>
                  <Text style={styles.inventoryCodeText}>{color.code}</Text>
                  <Text style={[styles.muted, styles.inventoryColorMeta]}>
                    {color.nameZh || color.nameEn || '参考色名缺失'}
                    {color.nameEn && color.nameEn !== color.code ? ` · ${color.nameEn}` : ''}
                  </Text>
                </View>
                <View style={styles.right}>
                  <Text style={styles.inventoryQuantity}>{stock}</Text>
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
  const [recognitionPreviewUri, setRecognitionPreviewUri] = useState<string | undefined>();
  const [ocrProgress, setOcrProgress] = useState<OcrProgressState | undefined>();
  const [editingProjectName, setEditingProjectName] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState('');
  const projectNameCommitGuardRef = useRef(false);

  const selectedProject = data.projects.find((project) => project.id === selectedId) ?? data.projects[0];
  const rows = selectedProject ? buildRequirementRows(data, [selectedProject]) : [];
  const projectDeductCount = selectedProject ? getProjectDeductCount(selectedProject) : 0;
  const deductRequiredTotal = rows.reduce((sum, row) => sum + row.required, 0);
  const deductCoveredTotal = rows.reduce((sum, row) => sum + Math.min(row.required, row.stock), 0);
  const deductMissingTotal = rows.reduce((sum, row) => sum + row.missing, 0);
  const safetyWarningRows = rows.filter((row) => row.safetyWarning);
  const safetyWarningTotal = safetyWarningRows.reduce((sum, row) => sum + Math.max(row.remaining, 0), 0);

  useEffect(() => {
    if (!ocrProgress) return;
    const timer = setInterval(() => {
      setOcrProgress((current) => {
        if (!current) return current;
        const now = Date.now();
        return {
          ...current,
          elapsedSeconds: Math.floor((now - current.startedAt) / 1000),
          stageElapsedSeconds: Math.floor((now - current.stageStartedAt) / 1000),
        };
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [ocrProgress?.startedAt]);

  const saveProject = (project: PatternProject, label = `更新图纸：${project.name}`) => updateData((current) => upsertProject(current, project), label);

  useEffect(() => {
    setEditingProjectName(false);
    setProjectNameDraft(selectedProject?.name ?? '');
    projectNameCommitGuardRef.current = false;
  }, [selectedProject?.id]);

  const startProjectNameEdit = (project = selectedProject) => {
    if (!project) return;
    setSelectedId(project.id);
    setProjectNameDraft(project.name);
    setEditingProjectName(true);
  };

  const saveProjectName = () => {
    if (projectNameCommitGuardRef.current) return;
    projectNameCommitGuardRef.current = true;
    setTimeout(() => {
      projectNameCommitGuardRef.current = false;
    }, 250);
    if (!selectedProject) return;
    const trimmed = projectNameDraft.trim();
    if (!trimmed) {
      setProjectNameDraft(selectedProject.name);
      setEditingProjectName(false);
      setNotice('图纸名称不能为空，已保留原名称');
      return;
    }
    const nextName = makeUniqueName(
      trimmed,
      data.projects.filter((project) => project.id !== selectedProject.id).map((project) => project.name),
    );
    if (nextName !== selectedProject.name) {
      saveProject({ ...selectedProject, name: nextName }, `重命名图纸：${selectedProject.name} → ${nextName}`);
      setNotice(`图纸已重命名为「${nextName}」`);
    }
    setProjectNameDraft(nextName);
    setEditingProjectName(false);
  };

  const updateOcrStage = (stage: OcrProgressStage) => {
    setOcrProgress((current) => createOcrProgress(stage, current));
    setNotice(getOcrStageNotice(stage));
  };

  const addProject = () => {
    const projectName = makeUniqueName(name.trim() || makeDatedName('新图纸'), data.projects.map((project) => project.name));
    const project = createProject(projectName);
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
      const ocrResult = await recognizePatternDraft(croppedImageUri, { settings: data.settings, onProgress: ({ stage }) => updateOcrStage(stage) });
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
      setOcrProgress(undefined);
      setCropBusy(false);
    }
  };

  const recognizeCroppedPattern = async () => {
    if (!selectedProject) return;
    if (ocrProgress) return;
    const imageUri = selectedProject.croppedImageUri ?? selectedProject.imageUri;
    if (!imageUri) {
      setNotice('请先上传并裁剪图纸图片');
      return;
    }
    try {
      const ocrReady = await prepareCroppedImageForOcr(imageUri);
      const finalImageUri = ocrReady.changed ? await persistProjectImage(selectedProject.id, ocrReady.uri, 'crop') : imageUri;
      const ocrResult = await recognizePatternDraft(finalImageUri, { settings: data.settings, onProgress: ({ stage }) => updateOcrStage(stage) });
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
    } catch (error) {
      setNotice(`OCR 识别失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setOcrProgress(undefined);
    }
  };

  const openRecognitionImage = () => {
    const uri = selectedProject?.croppedImageUri ?? selectedProject?.imageUri;
    if (!uri) {
      setNotice('还没有可查看的识别图');
      return;
    }
    setRecognitionPreviewUri(uri);
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
      `${selectedProject.name} ${projectDeductCount ? '再次扣除库存' : '扣除库存'}`,
    );
    setDeductPreviewOpen(false);
    setNotice(
      deductMissingTotal
        ? `已扣库存；其中 ${deductMissingTotal} 颗库存不足，相关色号已扣到 0`
        : `已按当前用量扣除库存；累计扣除 ${projectDeductCount + 1} 次`,
    );
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
            <Pressable
              key={project.id}
              style={[styles.projectChip, selectedProject?.id === project.id && styles.projectChipActive]}
              onPress={() => (selectedProject?.id === project.id ? startProjectNameEdit(project) : setSelectedId(project.id))}
            >
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
              {editingProjectName ? (
                <View style={styles.nameEditBlock}>
                  <TextInput
                    style={[styles.input, styles.nameEditInput]}
                    value={projectNameDraft}
                    onChangeText={setProjectNameDraft}
                    accessibilityLabel="编辑图纸名称输入"
                    autoFocus
                    onBlur={saveProjectName}
                    onSubmitEditing={saveProjectName}
                  />
                </View>
              ) : (
                <Pressable accessibilityLabel="重命名当前图纸" onPress={() => startProjectNameEdit()}>
                  <Text style={styles.panelTitle}>{selectedProject.name}</Text>
                </Pressable>
              )}
              <Text style={styles.muted}>
                {selectedProject.items.length} 个颜色 · {projectDeductCount ? `已扣 ${projectDeductCount} 次` : '规划中，未扣库存'}
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
          {ocrProgress ? (
            <View style={styles.ocrProgressPanel}>
              <Text style={styles.ocrProgressTitle}>{getOcrStageTitle(ocrProgress.stage)}</Text>
              <Text style={styles.ocrProgressText}>
                总计 {formatDuration(ocrProgress.elapsedSeconds)} · 当前阶段 {formatDuration(ocrProgress.stageElapsedSeconds)}
              </Text>
            </View>
          ) : null}
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
                <StatCard label="余量预警" value={`${safetyWarningRows.length}`} tone={safetyWarningRows.length ? 'danger' : 'ok'} />
              </View>
              {projectDeductCount ? (
                <Text style={styles.warningText}>这份图纸已经扣除 {projectDeductCount} 次库存。再次确认会按当前用量再扣一次，适合返工、补做或重复制作。</Text>
              ) : (
                <Text style={styles.muted}>只有确认已经开始制作、豆子实际会被消耗时再扣库存。只是规划图纸时不要确认扣除。</Text>
              )}
              {deductMissingTotal ? <Text style={styles.warningText}>库存不足的色号会扣到 0，不会出现负库存。缺口仍会保留在库存对比和采购缺口中。</Text> : null}
              {safetyWarningRows.length ? (
                <Text style={styles.warningText}>
                  {safetyWarningRows.length} 个颜色虽然不缺豆，但库存余量低于 {data.settings.projectSafetyBuffer} 颗，拼豆损耗后可能不够。
                  当前这些颜色合计余量 {safetyWarningTotal} 颗。
                </Text>
              ) : null}
              <View style={styles.deductRows}>
                {rows.map((row) => {
                  const color = getColor(row.code);
                  const rowWarning = row.missing > 0 || row.safetyWarning;
                  return (
                    <View key={row.code} style={styles.deductRow}>
                      <ColorSwatch color={color?.hex ?? '#ddd'} />
                      <View style={styles.flex}>
                        <Text style={styles.codeText}>{row.code}</Text>
                        <Text style={row.safetyWarning ? styles.warningText : styles.muted}>
                          需扣 {row.required} · 当前 {row.stock} · 扣后 {Math.max(row.remaining, 0)}
                          {row.safetyWarning ? ` · 低于余量阈值 ${row.safetyBuffer}` : ''}
                        </Text>
                      </View>
                      <View style={styles.right}>
                        <Text style={[styles.quantity, rowWarning && styles.dangerText]}>{row.missing > 0 ? row.missing : Math.max(row.remaining, 0)}</Text>
                        <Text style={styles.miniLabel}>{row.missing > 0 ? '缺口' : row.safetyWarning ? '余量低' : '余量'}</Text>
                      </View>
                    </View>
                  );
                })}
              </View>
              <View style={styles.buttonRow}>
                <ActionButton label="取消" onPress={() => setDeductPreviewOpen(false)} tone="neutral" />
                <ActionButton label={projectDeductCount ? '确认再次扣除' : '确认扣除库存'} onPress={applyDeductInventory} tone="danger" />
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
      <RecognitionImagePreview uri={recognitionPreviewUri} onClose={() => setRecognitionPreviewUri(undefined)} />
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
  const [editingListName, setEditingListName] = useState(false);
  const [listNameDraft, setListNameDraft] = useState('');
  const listNameCommitGuardRef = useRef(false);

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

  useEffect(() => {
    setEditingListName(false);
    setListNameDraft(selectedList?.name ?? '');
    listNameCommitGuardRef.current = false;
  }, [selectedList?.id]);

  const createList = () => {
    const listName = makeUniqueName(newListName.trim() || makeDatedName('采购表'), data.purchaseLists.map((list) => list.name));
    const list = createPurchaseList(listName);
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

  const startListNameEdit = (list = selectedList) => {
    if (!list) return;
    setSelectedListId(list.id);
    setListNameDraft(list.name);
    setEditingListName(true);
  };

  const saveListName = () => {
    if (listNameCommitGuardRef.current) return;
    listNameCommitGuardRef.current = true;
    setTimeout(() => {
      listNameCommitGuardRef.current = false;
    }, 250);
    if (!selectedList) return;
    const trimmed = listNameDraft.trim();
    if (!trimmed) {
      setListNameDraft(selectedList.name);
      setEditingListName(false);
      setNotice('采购表名称不能为空，已保留原名称');
      return;
    }
    const nextName = makeUniqueName(
      trimmed,
      data.purchaseLists.filter((list) => list.id !== selectedList.id).map((list) => list.name),
    );
    if (nextName !== selectedList.name) {
      updateSelectedList({ name: nextName }, `重命名采购表：${selectedList.name} → ${nextName}`);
      setNotice(`采购表已重命名为「${nextName}」`);
    }
    setListNameDraft(nextName);
    setEditingListName(false);
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

  const completeSelectedPurchase = () => {
    if (!selectedList) return;
    if (!purchaseRows.length) {
      setNotice('当前采购表没有可入库的采购项');
      return;
    }
    updateData((current) => completePurchaseList(current, selectedList.id), `${selectedList.name} 采购完成入库`);
    setNotice(`已将 ${purchaseRows.length} 个颜色、合计 ${totalQuantity} 颗加入豆仓，并清空当前采购表`);
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
            <Pressable
              key={list.id}
              style={[styles.projectChip, selectedList?.id === list.id && styles.projectChipActive]}
              onPress={() => (selectedList?.id === list.id ? startListNameEdit(list) : setSelectedListId(list.id))}
            >
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
                {editingListName ? (
                  <View style={styles.nameEditBlock}>
                    <TextInput
                      style={[styles.input, styles.nameEditInput]}
                      value={listNameDraft}
                      onChangeText={setListNameDraft}
                      accessibilityLabel="编辑采购表名称输入"
                      autoFocus
                      onBlur={saveListName}
                      onSubmitEditing={saveListName}
                    />
                  </View>
                ) : (
                  <Pressable accessibilityLabel="重命名当前采购表" onPress={() => startListNameEdit()}>
                    <Text style={styles.panelTitle}>{selectedList.name}</Text>
                  </Pressable>
                )}
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
            <View style={styles.buttonRow}>
              <ActionButton label="采购完成入库" onPress={completeSelectedPurchase} tone="amber" />
            </View>
            <Text style={styles.helpText}>完成入库会把当前采购项加入豆仓，并清空这张采购表；可通过顶部提示或历史操作撤销。</Text>
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
  account,
  accountActions,
  registerLeaveGuard,
}: {
  data: AppData;
  updateData: UpdateData;
  setNotice: ShowNotice;
  account: AccountPanelState;
  accountActions: AccountActions;
  registerLeaveGuard: (guard: SettingsLeaveGuard | undefined) => void;
}) {
  const [threshold, setThreshold] = useState(String(data.settings.defaultLowStockThreshold));
  const [projectSafetyBuffer, setProjectSafetyBuffer] = useState(String(data.settings.projectSafetyBuffer));
  const [aiOcrApiKey, setAiOcrApiKey] = useState(data.settings.aiOcrApiKey);
  const [aiOcrEndpoint, setAiOcrEndpoint] = useState(data.settings.aiOcrEndpoint);
  const [aiOcrModel, setAiOcrModel] = useState(data.settings.aiOcrModel);
  const [aiOcrTextApiKey, setAiOcrTextApiKey] = useState(data.settings.aiOcrTextApiKey);
  const [aiOcrTextEndpoint, setAiOcrTextEndpoint] = useState(data.settings.aiOcrTextEndpoint);
  const [aiOcrTextModel, setAiOcrTextModel] = useState(data.settings.aiOcrTextModel);
  const [aiOcrTextEnabled, setAiOcrTextEnabled] = useState(data.settings.aiOcrTextEnabled);
  const [aiOcrProviderKeys, setAiOcrProviderKeys] = useState(data.settings.aiOcrProviderKeys);
  const [aiOcrTextProviderKeys, setAiOcrTextProviderKeys] = useState(data.settings.aiOcrTextProviderKeys);
  const [visionProviderOpen, setVisionProviderOpen] = useState(false);
  const [visionModelOpen, setVisionModelOpen] = useState(false);
  const [textProviderOpen, setTextProviderOpen] = useState(false);
  const [textModelOpen, setTextModelOpen] = useState(false);
  const [accountMode, setAccountMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [accountUsername, setAccountUsername] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [accountRecoveryEmail, setAccountRecoveryEmail] = useState('');
  const [restorePromptVisible, setRestorePromptVisible] = useState(false);
  const [resetCountdown, setResetCountdown] = useState(0);
  const [resetReady, setResetReady] = useState(false);
  const activeVisionPreset = findAiPreset(VISION_MODEL_PRESETS, aiOcrEndpoint, aiOcrModel);
  const activeTextPreset = findAiPreset(TEXT_MODEL_PRESETS, aiOcrTextEndpoint, aiOcrTextModel);
  const activeVisionModel = findAiModelOption(activeVisionPreset, aiOcrModel);
  const activeTextModel = findAiModelOption(activeTextPreset, aiOcrTextModel);
  const activeVisionServiceKey = getAiServiceKey(activeVisionPreset, aiOcrEndpoint);
  const activeTextServiceKey = getAiServiceKey(activeTextPreset, aiOcrTextEndpoint);
  const localDataSummary = summarizeAppData(data);
  const activeCloudSyncInterval = normalizeCloudSyncIntervalMinutes(data.settings.cloudAutoSyncIntervalMinutes);

  const resetDraftFromSettings = (settings: AppSettings) => {
    const visionPreset = findAiPreset(VISION_MODEL_PRESETS, settings.aiOcrEndpoint, settings.aiOcrModel);
    const textPreset = findAiPreset(TEXT_MODEL_PRESETS, settings.aiOcrTextEndpoint, settings.aiOcrTextModel);
    const visionServiceKey = getAiServiceKey(visionPreset, settings.aiOcrEndpoint);
    const textServiceKey = getAiServiceKey(textPreset, settings.aiOcrTextEndpoint);
    const visionKeys = rememberApiKey(settings.aiOcrProviderKeys ?? {}, visionServiceKey, settings.aiOcrApiKey || '');
    const textKeys = rememberApiKey(settings.aiOcrTextProviderKeys ?? {}, textServiceKey, settings.aiOcrTextApiKey || '');

    setThreshold(String(settings.defaultLowStockThreshold));
    setProjectSafetyBuffer(String(settings.projectSafetyBuffer ?? 50));
    setAiOcrEndpoint(settings.aiOcrEndpoint || 'https://api.ocr.space/parse/image');
    setAiOcrModel(settings.aiOcrModel || 'ocr.space-engine2');
    setAiOcrTextEndpoint(settings.aiOcrTextEndpoint || 'https://api.deepseek.com/chat/completions');
    setAiOcrTextModel(settings.aiOcrTextModel || 'deepseek-v4-flash');
    setAiOcrTextEnabled(settings.aiOcrTextEnabled ?? true);
    setAiOcrProviderKeys(visionKeys);
    setAiOcrTextProviderKeys(textKeys);
    setAiOcrApiKey(getStoredApiKey(visionKeys, visionServiceKey, settings.aiOcrApiKey || 'helloworld'));
    setAiOcrTextApiKey(getStoredApiKey(textKeys, textServiceKey, settings.aiOcrTextApiKey || ''));
  };

  const buildDraftSettings = (): AppSettings => {
    const nextVisionKeys = compactKeyMap(rememberApiKey(aiOcrProviderKeys, activeVisionServiceKey, aiOcrApiKey));
    const nextTextKeys = compactKeyMap(rememberApiKey(aiOcrTextProviderKeys, activeTextServiceKey, aiOcrTextApiKey));
    return {
      ...data.settings,
      defaultLowStockThreshold: parseWholeNumber(threshold),
      projectSafetyBuffer: parseWholeNumber(projectSafetyBuffer),
      aiOcrApiKey: aiOcrApiKey.trim(),
      aiOcrEndpoint: aiOcrEndpoint.trim() || 'https://api.ocr.space/parse/image',
      aiOcrModel: aiOcrModel.trim() || 'ocr.space-engine2',
      aiOcrTextApiKey: aiOcrTextApiKey.trim(),
      aiOcrTextEndpoint: aiOcrTextEndpoint.trim() || 'https://api.deepseek.com/chat/completions',
      aiOcrTextModel: aiOcrTextModel.trim() || 'deepseek-v4-flash',
      aiOcrTextEnabled,
      aiOcrProviderKeys: nextVisionKeys,
      aiOcrTextProviderKeys: nextTextKeys,
      aiOcrUseSameKey: false,
    };
  };

  const buildSavedSettings = () => {
    const savedVisionPreset = findAiPreset(VISION_MODEL_PRESETS, data.settings.aiOcrEndpoint, data.settings.aiOcrModel);
    const savedTextPreset = findAiPreset(TEXT_MODEL_PRESETS, data.settings.aiOcrTextEndpoint, data.settings.aiOcrTextModel);
    const savedVisionKey = getAiServiceKey(savedVisionPreset, data.settings.aiOcrEndpoint);
    const savedTextKey = getAiServiceKey(savedTextPreset, data.settings.aiOcrTextEndpoint);
    return {
      ...data.settings,
      aiOcrTextEnabled: data.settings.aiOcrTextEnabled ?? true,
      aiOcrProviderKeys: compactKeyMap(rememberApiKey(data.settings.aiOcrProviderKeys ?? {}, savedVisionKey, data.settings.aiOcrApiKey || '')),
      aiOcrTextProviderKeys: compactKeyMap(
        rememberApiKey(data.settings.aiOcrTextProviderKeys ?? {}, savedTextKey, data.settings.aiOcrTextApiKey || ''),
      ),
      aiOcrUseSameKey: false,
    };
  };

  const hasUnsavedSettings = () => JSON.stringify(buildDraftSettings()) !== JSON.stringify(buildSavedSettings());

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
    resetDraftFromSettings(data.settings);
  }, [data.settings]);

  const saveAllSettings = (notice = '设置已保存') => {
    const nextSettings = buildDraftSettings();
    updateData(
      (current) => ({
        ...current,
        settings: {
          ...current.settings,
          ...nextSettings,
        },
      }),
      '修改设置',
    );
    setNotice(notice);
  };

  const saveSettings = () => saveAllSettings('设置已保存');

  useEffect(() => {
    registerLeaveGuard({
      hasUnsavedChanges: hasUnsavedSettings,
      saveChanges: () => saveAllSettings('设置已保存'),
      discardChanges: () => {
        resetDraftFromSettings(data.settings);
        setNotice('已放弃未保存设置');
      },
    });
    return () => registerLeaveGuard(undefined);
  });

  const applyVisionPreset = (preset: AiPreset) => {
    const currentKeyMap = rememberApiKey(aiOcrProviderKeys, activeVisionServiceKey, aiOcrApiKey);
    const nextServiceKey = getAiServiceKey(preset, preset.endpoint);
    const defaultModel = getAiModelOptions(preset)[0]?.model ?? preset.model;
    setAiOcrProviderKeys(currentKeyMap);
    setAiOcrApiKey(getStoredApiKey(currentKeyMap, nextServiceKey, preset.id === 'ocr-space' ? 'helloworld' : ''));
    setAiOcrEndpoint(preset.endpoint);
    setAiOcrModel(defaultModel);
    setVisionProviderOpen(false);
    setVisionModelOpen(true);
    setNotice(`已选择图片识别供应商：${preset.title}`);
  };

  const applyVisionModel = (option: AiModelOption) => {
    if (option.endpoint) setAiOcrEndpoint(option.endpoint);
    setAiOcrModel(option.model);
    setVisionModelOpen(false);
    setNotice(`已选择图片识别模型：${option.label}`);
  };

  const applyTextPreset = (preset: AiPreset) => {
    const currentKeyMap = rememberApiKey(aiOcrTextProviderKeys, activeTextServiceKey, aiOcrTextApiKey);
    const nextServiceKey = getAiServiceKey(preset, preset.endpoint);
    const defaultModel = getAiModelOptions(preset)[0]?.model ?? preset.model;
    setAiOcrTextProviderKeys(currentKeyMap);
    setAiOcrTextApiKey(getStoredApiKey(currentKeyMap, nextServiceKey, ''));
    setAiOcrTextEndpoint(preset.endpoint);
    setAiOcrTextModel(defaultModel);
    setTextProviderOpen(false);
    setTextModelOpen(true);
    setNotice(`已选择文本模型供应商：${preset.title}`);
  };

  const applyTextModel = (option: AiModelOption) => {
    if (option.endpoint) setAiOcrTextEndpoint(option.endpoint);
    setAiOcrTextModel(option.model);
    setTextModelOpen(false);
    setNotice(`已选择文本模型：${option.label}`);
  };

  const updateVisionApiKey = (value: string) => {
    setAiOcrApiKey(value);
    setAiOcrProviderKeys((current) => rememberApiKey(current, activeVisionServiceKey, value));
  };

  const updateTextApiKey = (value: string) => {
    setAiOcrTextApiKey(value);
    setAiOcrTextProviderKeys((current) => rememberApiKey(current, activeTextServiceKey, value));
  };

  const saveAiOcrSettings = () => saveAllSettings('OCR 接口设置已保存');

  const submitAccountForm = () => {
    const usernameError = validateAccountUsername(accountUsername);
    if (usernameError) {
      setNotice(usernameError);
      return;
    }
    const passwordError = validateAccountPassword(accountPassword);
    if (passwordError) {
      setNotice(passwordError);
      return;
    }
    if (accountMode === 'sign-up') {
      void accountActions.signUp(accountUsername, accountPassword, accountRecoveryEmail).then(() => setAccountPassword(''));
      return;
    }
    void accountActions.signIn(accountUsername, accountPassword).then(() => setAccountPassword(''));
  };

  const confirmCloudRestore = () => {
    setRestorePromptVisible(true);
  };

  const updateCloudAutoSyncInterval = (minutes: number) => {
    const nextMinutes = normalizeCloudSyncIntervalMinutes(minutes);
    updateData(
      (current) => ({
        ...current,
        settings: {
          ...current.settings,
          cloudAutoSyncIntervalMinutes: nextMinutes,
        },
      }),
      `修改云端自动同步间隔为 ${nextMinutes ? `${nextMinutes} 分钟` : '关闭'}`,
    );
    setNotice(nextMinutes ? `自动同步间隔已改为 ${nextMinutes} 分钟` : '已关闭自动同步；退出登录前仍会尝试同步未保存更改');
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
    <>
    <ScrollView showsVerticalScrollIndicator={false}>
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>库存设置</Text>
        <LabeledInput label="默认低库存阈值" value={threshold} onChangeText={setThreshold} keyboardType="number-pad" />
        <LabeledInput label="图纸余量预警阈值" value={projectSafetyBuffer} onChangeText={setProjectSafetyBuffer} keyboardType="number-pad" />
        <Text style={styles.helpText}>当图纸需要量和库存差值低于该阈值时，即使不缺豆也会提示可能因损耗不够用。默认 50 颗。</Text>
        <ActionButton label="保存设置" onPress={saveSettings} />
      </View>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>OCR 与模型</Text>
        <Text style={styles.muted}>
          图片识别先把图纸裁剪区转成文本，文本模型再把 OCR 原文整理成 MARD 色号和颗数。OpenAI-compatible
          /chat/completions 可直接使用；Azure、Anthropic、Mistral OCR、Cloudflare Workers AI 已内置单独适配。
        </Text>

        <AiConfigSelector
          title="图片识别"
          providerLabel="识别服务"
          modelLabel="识别模型"
          presets={VISION_MODEL_PRESETS}
          selectedPreset={activeVisionPreset}
          selectedModel={activeVisionModel}
          customModel={aiOcrModel}
          providerOpen={visionProviderOpen}
          modelOpen={visionModelOpen}
          onToggleProvider={() => {
            setVisionProviderOpen((open) => !open);
            setVisionModelOpen(false);
          }}
          onToggleModel={() => {
            setVisionModelOpen((open) => !open);
            setVisionProviderOpen(false);
          }}
          onSelectProvider={applyVisionPreset}
          onSelectModel={applyVisionModel}
        />

        <LabeledInput label="OCR API Key" value={aiOcrApiKey} onChangeText={updateVisionApiKey} placeholder="helloworld" secureTextEntry autoCapitalize="none" />
        <LabeledInput
          label="OCR Endpoint"
          value={aiOcrEndpoint}
          onChangeText={setAiOcrEndpoint}
          placeholder="https://api.ocr.space/parse/image"
          autoCapitalize="none"
        />
        <LabeledInput label="OCR 引擎/模型" value={aiOcrModel} onChangeText={setAiOcrModel} placeholder="ocr.space-engine2" autoCapitalize="none" />

        <View style={styles.divider} />

        <Pressable style={styles.toggleRow} onPress={() => setAiOcrTextEnabled((enabled) => !enabled)}>
          <View style={[styles.checkbox, aiOcrTextEnabled && styles.checkboxActive]}>
            <Text style={styles.checkboxText}>{aiOcrTextEnabled ? '✓' : ''}</Text>
          </View>
          <View style={styles.flex}>
            <Text style={styles.codeText}>启用文本模型整理</Text>
            <Text style={styles.muted}>关闭后只使用 OCR 原文和本地规则解析，不调用文本模型。</Text>
          </View>
        </Pressable>

        <AiConfigSelector
          title="文本整理"
          providerLabel="文本服务"
          modelLabel="文本模型"
          presets={TEXT_MODEL_PRESETS}
          selectedPreset={activeTextPreset}
          selectedModel={activeTextModel}
          customModel={aiOcrTextModel}
          providerOpen={textProviderOpen}
          modelOpen={textModelOpen}
          onToggleProvider={() => {
            setTextProviderOpen((open) => !open);
            setTextModelOpen(false);
          }}
          onToggleModel={() => {
            setTextModelOpen((open) => !open);
            setTextProviderOpen(false);
          }}
          onSelectProvider={applyTextPreset}
          onSelectModel={applyTextModel}
        />

        <LabeledInput label="文本 API Key" value={aiOcrTextApiKey} onChangeText={updateTextApiKey} placeholder="sk-..." secureTextEntry autoCapitalize="none" />
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
        <View style={styles.panelHeader}>
          <View style={styles.flex}>
            <Text style={styles.panelTitle}>账号与云端同步</Text>
            <Text style={styles.muted}>未登录时继续保存到本机；登录后可把本机数据上传到 Supabase，或从云端恢复。</Text>
          </View>
          {account.status === 'signed-in' ? (
            <View style={styles.accountStatusPill}>
              <Text style={styles.accountStatusText}>{account.syncing ? '同步中' : account.pendingCloudSync ? '待同步' : account.autoSyncReady ? '已同步' : '已登录'}</Text>
            </View>
          ) : null}
        </View>

        {account.status === 'unconfigured' ? (
          <Text style={styles.warningText}>{account.message}</Text>
        ) : null}

        {account.status === 'loading' ? <Text style={styles.muted}>{account.message ?? '正在检查登录状态...'}</Text> : null}

        {account.status === 'signed-out' ? (
          <>
            <View style={styles.segmentedRow}>
              <Pressable style={[styles.segmentButton, accountMode === 'sign-in' && styles.segmentButtonActive]} onPress={() => setAccountMode('sign-in')}>
                <Text style={[styles.segmentButtonText, accountMode === 'sign-in' && styles.segmentButtonTextActive]}>登录</Text>
              </Pressable>
              <Pressable style={[styles.segmentButton, accountMode === 'sign-up' && styles.segmentButtonActive]} onPress={() => setAccountMode('sign-up')}>
                <Text style={[styles.segmentButtonText, accountMode === 'sign-up' && styles.segmentButtonTextActive]}>注册</Text>
              </Pressable>
            </View>
            <LabeledInput
              label="用户名"
              value={accountUsername}
              onChangeText={setAccountUsername}
              placeholder="例如 mard_01"
              autoCapitalize="none"
            />
            <LabeledInput
              label="密码"
              value={accountPassword}
              onChangeText={setAccountPassword}
              placeholder="至少 6 位"
              secureTextEntry
              autoCapitalize="none"
            />
            {accountMode === 'sign-up' ? (
              <LabeledInput
                label="找回邮箱（可选）"
                value={accountRecoveryEmail}
                onChangeText={setAccountRecoveryEmail}
                placeholder="只作为个人记录，当前版本不自动找回"
                autoCapitalize="none"
              />
            ) : null}
            <Text style={styles.helpText}>用户名支持 3-32 位小写字母、数字、下划线或短横线。注册前请在 Supabase Auth 里关闭邮箱确认。</Text>
            <ActionButton label={accountMode === 'sign-up' ? '注册并登录' : '登录'} onPress={submitAccountForm} tone="amber" />
          </>
        ) : null}

        {account.status === 'signed-in' ? (
          <>
            <View style={styles.accountSummary}>
              <View style={styles.flex}>
                <Text style={styles.codeText}>{account.profile?.username ?? '未命名账号'}</Text>
                <Text style={styles.muted}>
                  云端快照：{account.cloudUpdatedAt ? formatCloudTime(account.cloudUpdatedAt) : '暂无'}
                  {account.lastSyncedAt ? ` · 本次同步 ${formatCloudTime(account.lastSyncedAt)}` : ''}
                </Text>
                <Text style={styles.helpText}>
                  {account.pendingCloudSync
                    ? account.nextAutoSyncAt
                      ? `本机有待同步更改，预计 ${formatCloudTime(account.nextAutoSyncAt)} 自动同步。`
                      : '本机有待同步更改；自动同步已关闭，手动上传或退出登录前会同步。'
                    : account.autoSyncReady
                      ? '本次登录已启用云端同步。'
                      : '云端已有数据时，需要先手动选择上传或恢复，避免误覆盖。'}
                </Text>
              </View>
            </View>
            <View style={styles.syncIntervalBlock}>
              <Text style={styles.accountSnapshotTitle}>自动同步间隔</Text>
              <View style={styles.syncIntervalOptions}>
                {CLOUD_SYNC_INTERVAL_OPTIONS.map((option) => (
                  <Pressable
                    key={option.minutes}
                    style={[styles.syncIntervalOption, activeCloudSyncInterval === option.minutes && styles.syncIntervalOptionActive]}
                    onPress={() => updateCloudAutoSyncInterval(option.minutes)}
                  >
                    <Text style={[styles.syncIntervalOptionText, activeCloudSyncInterval === option.minutes && styles.syncIntervalOptionTextActive]}>
                      {option.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <View style={styles.accountSnapshotGrid}>
              <View style={styles.accountSnapshotCard}>
                <Text style={styles.accountSnapshotTitle}>本机数据</Text>
                <Text style={styles.accountSnapshotText}>{formatDataSummary(localDataSummary)}</Text>
              </View>
              <View style={styles.accountSnapshotCard}>
                <Text style={styles.accountSnapshotTitle}>云端数据</Text>
                <Text style={styles.accountSnapshotText}>{account.cloudSummary ? formatDataSummary(account.cloudSummary) : '未读取快照内容'}</Text>
                {account.lastCloudCheckedAt ? <Text style={styles.accountSnapshotMeta}>刷新 {formatCloudTime(account.lastCloudCheckedAt)}</Text> : null}
              </View>
            </View>
            <View style={styles.buttonRow}>
              <ActionButton label="刷新状态" onPress={() => void accountActions.refreshCloud()} tone="neutral" />
              <ActionButton label="上传本机数据" onPress={() => void accountActions.uploadCloud()} tone="amber" />
              <ActionButton label="从云端恢复" onPress={confirmCloudRestore} tone="neutral" />
              <ActionButton label="退出登录" onPress={() => void accountActions.signOut()} tone="danger" />
            </View>
          </>
        ) : null}

        {account.busy || account.syncing ? <Text style={styles.muted}>{account.busy ? '账号操作处理中...' : '正在同步...'}</Text> : null}
        {account.message && account.status !== 'loading' && account.status !== 'unconfigured' ? (
          <Text style={account.message.includes('失败') || account.message.includes('配置') ? styles.warningText : styles.muted}>{account.message}</Text>
        ) : null}
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
          <ScrollView style={styles.historyScrollBox} nestedScrollEnabled showsVerticalScrollIndicator>
            {data.actionHistory.slice(0, 30).map((entry) => (
              <View key={entry.id} style={styles.historyRow}>
                <View style={styles.flex}>
                  <Text style={[styles.historyLabel, entry.undoneAt && styles.historyUndone]}>{entry.label}</Text>
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
            ))}
          </ScrollView>
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
    <CloudRestorePrompt
      visible={restorePromptVisible}
      cloudUpdatedAt={account.cloudUpdatedAt}
      cloudSummary={account.cloudSummary}
      localSummary={localDataSummary}
      busy={account.busy}
      onCancel={() => setRestorePromptVisible(false)}
      onConfirm={() => {
        setRestorePromptVisible(false);
        void accountActions.restoreCloud();
      }}
    />
    </>
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

function formatCloudTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function RequirementLine({ row, showPacks = false }: { row: ReturnType<typeof buildRequirementRows>[number]; showPacks?: boolean }) {
  const color = getColor(row.code);
  const rowWarning = row.missing > 0 || row.safetyWarning;
  return (
    <View style={styles.requirementRow}>
      <ColorSwatch color={color?.hex ?? '#ddd'} />
      <View style={styles.flex}>
        <Text style={styles.codeText}>{row.code}</Text>
        <Text style={row.safetyWarning ? styles.warningText : styles.muted}>
          需要 {row.required} · 库存 {row.stock} · 余量 {Math.max(row.remaining, 0)}
          {row.safetyWarning ? ` · 低于预警阈值 ${row.safetyBuffer}` : ''}
        </Text>
      </View>
      <View style={styles.right}>
        <Text style={[styles.quantity, rowWarning && styles.dangerText]}>{row.missing > 0 ? row.missing : Math.max(row.remaining, 0)}</Text>
        <Text style={styles.miniLabel}>{row.missing > 0 ? (showPacks ? `${row.packsToBuy} 份` : '缺口') : row.safetyWarning ? '余量低' : '余量'}</Text>
      </View>
    </View>
  );
}

function RecognitionImagePreview({ uri, onClose }: { uri?: string; onClose: () => void }) {
  return (
    <Modal visible={Boolean(uri)} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.imagePreviewBackdrop}>
        <View style={styles.imagePreviewPanel}>
          <View style={styles.cropTitleRow}>
            <Text style={styles.panelTitle}>识别图</Text>
            <ActionButton label="关闭" onPress={onClose} tone="neutral" />
          </View>
          {uri ? <Image source={{ uri }} style={styles.imagePreview} resizeMode="contain" /> : null}
        </View>
      </View>
    </Modal>
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

function AiConfigSelector({
  title,
  providerLabel,
  modelLabel,
  presets,
  selectedPreset,
  selectedModel,
  customModel,
  providerOpen,
  modelOpen,
  onToggleProvider,
  onToggleModel,
  onSelectProvider,
  onSelectModel,
}: {
  title: string;
  providerLabel: string;
  modelLabel: string;
  presets: AiPreset[];
  selectedPreset?: AiPreset;
  selectedModel?: AiModelOption;
  customModel: string;
  providerOpen: boolean;
  modelOpen: boolean;
  onToggleProvider: () => void;
  onToggleModel: () => void;
  onSelectProvider: (preset: AiPreset) => void;
  onSelectModel: (option: AiModelOption) => void;
}) {
  const modelOptions = getAiModelOptions(selectedPreset);
  return (
    <View style={styles.aiSelector}>
      <Text style={styles.aiSectionTitle}>{title}</Text>

      <Pressable style={[styles.selectSummary, providerOpen && styles.selectSummaryOpen]} onPress={onToggleProvider}>
        <View style={styles.flex}>
          <Text style={styles.selectLabel}>{providerLabel}</Text>
          <Text style={styles.selectValue}>{selectedPreset?.title ?? '自定义接口'}</Text>
          <Text style={styles.muted} numberOfLines={2}>{selectedPreset?.note ?? '当前 endpoint 未匹配内置供应商，可继续手动填写。'}</Text>
        </View>
        <Text style={styles.selectChevron}>{providerOpen ? '收起' : '选择'}</Text>
      </Pressable>

      {providerOpen ? (
        <View style={styles.optionList}>
          {presets.map((preset) => (
            <Pressable key={preset.id} style={[styles.optionRow, selectedPreset?.id === preset.id && styles.optionRowActive]} onPress={() => onSelectProvider(preset)}>
              <View style={styles.flex}>
                <View style={styles.optionHeader}>
                  <Text style={[styles.optionTitle, selectedPreset?.id === preset.id && styles.optionTitleActive]}>{preset.title}</Text>
                  <Text style={[styles.optionTag, selectedPreset?.id === preset.id && styles.optionTagActive]}>{preset.tag}</Text>
                </View>
                <Text style={styles.optionNote}>{preset.note}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}

      <Pressable style={[styles.selectSummary, modelOpen && styles.selectSummaryOpen]} onPress={onToggleModel}>
        <View style={styles.flex}>
          <Text style={styles.selectLabel}>{modelLabel}</Text>
          <Text style={styles.selectValue}>{selectedModel?.label ?? (customModel || '自定义模型')}</Text>
          <Text style={styles.optionModel} numberOfLines={1}>{customModel || '未填写'}</Text>
        </View>
        <Text style={styles.selectChevron}>{modelOpen ? '收起' : '选择'}</Text>
      </Pressable>

      {modelOpen ? (
        <View style={styles.optionList}>
          {modelOptions.map((option) => (
            <Pressable key={`${option.endpoint ?? selectedPreset?.endpoint ?? 'custom'}:${option.model}`} style={[styles.optionRow, option.model === customModel && styles.optionRowActive]} onPress={() => onSelectModel(option)}>
              <View style={styles.flex}>
                <Text style={[styles.optionTitle, option.model === customModel && styles.optionTitleActive]}>{option.label}</Text>
                <Text style={styles.optionModel} numberOfLines={1}>{option.model}</Text>
                {option.note ? <Text style={styles.optionNote}>{option.note}</Text> : null}
              </View>
            </Pressable>
          ))}
          {modelOptions.length ? null : <Text style={styles.muted}>当前自定义 endpoint 没有内置模型列表，可直接编辑下面的模型输入框。</Text>}
        </View>
      ) : null}
    </View>
  );
}

function ActionButton({ label, onPress, tone = 'primary' }: { label: string; onPress: () => void; tone?: 'primary' | 'amber' | 'danger' | 'neutral' }) {
  return (
    <Pressable style={({ pressed }) => [styles.actionButton, styles[`button_${tone}`], pressed && styles.actionButtonPressed]} onPress={onPress}>
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
    <Pressable
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.roundAction, tone === 'plus' ? styles.roundActionPlus : styles.roundActionMinus, pressed && styles.roundActionPressed]}
      onPress={onPress}
    >
      <Text style={styles.roundActionText}>{label}</Text>
    </Pressable>
  );
}

function ColorSwatch({ color, compact = false }: { color: string; compact?: boolean }) {
  return (
    <View style={[styles.swatchFrame, compact && styles.swatchFrameCompact]}>
      <View style={[styles.swatch, compact && styles.swatchCompact, { backgroundColor: color }]}>
        <View style={[styles.swatchHighlight, compact && styles.swatchHighlightCompact]} />
      </View>
    </View>
  );
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
  const viewport = useResponsiveViewport();
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [cropRect, setCropRect] = useState<DisplayCropRect>({ x: 0, y: 0, width: 1, height: 1 });
  const cropRef = useRef(cropRect);
  const panStartRef = useRef(cropRect);
  const maxCanvasWidth = Math.min(Math.max(viewport.width - 24, 260), 720);
  const maxCanvasHeight = Math.min(Math.max(viewport.height * 0.62, 280), 760);

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
    const inset = Math.max(12, Math.min(displaySize.width, displaySize.height) * 0.05);
    setCropRect({
      x: inset,
      y: inset,
      width: Math.max(48, displaySize.width - inset * 2),
      height: Math.max(48, displaySize.height - inset * 2),
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
  const minSize = 8;
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
  greenDark: '#075746',
  mint: '#BDEBD9',
  amber: '#B46A16',
  amberSoft: '#FFF1D6',
  red: '#C0473D',
  redSoft: '#FFE5E1',
  blue: '#2D66C3',
  blueSoft: '#E6F0FF',
  coral: '#E5715F',
  violet: '#6B6FD6',
  white: '#FFFFFF',
};

const fonts = {
  display: Platform.select({
    ios: 'Avenir Next',
    android: 'sans-serif-medium',
    default: 'Avenir Next, ui-sans-serif, system-ui, sans-serif',
  }),
  text: Platform.select({
    ios: 'Avenir Next',
    android: 'sans-serif',
    default: 'Avenir Next, ui-sans-serif, system-ui, sans-serif',
  }),
  mono: Platform.select({
    ios: 'Menlo',
    android: 'monospace',
    default: 'Menlo, ui-monospace, SFMono-Regular, monospace',
  }),
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
  backgroundColor: colors.bgAlt,
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
  backgroundColor: 'rgba(18, 22, 32, 0.76)',
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
  border: `2px solid ${colors.blue}`,
  boxShadow: '0 10px 26px rgba(23, 26, 33, 0.22)',
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
    borderColor: colors.lineStrong,
    backgroundColor: colors.bg,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  header: {
    margin: 10,
    padding: 14,
    borderRadius: 8,
    backgroundColor: colors.panelDark,
    borderWidth: 1,
    borderColor: '#2A3142',
    boxShadow: '0 14px 30px rgba(18, 22, 32, 0.20)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerCompact: {
    marginBottom: 6,
    paddingVertical: 10,
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  headerTitleBlock: {
    flex: 1,
  },
  brand: {
    fontFamily: fonts.display,
    fontSize: 25,
    fontWeight: '900',
    color: colors.white,
    letterSpacing: 0,
  },
  headerBrand: {
    flex: 1,
  },
  headerSub: {
    color: '#B8C3D6',
    marginTop: 4,
    fontFamily: fonts.text,
    fontSize: 13,
    fontWeight: '700',
  },
  badge: {
    backgroundColor: '#223127',
    borderColor: '#3D765C',
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 8,
  },
  badgeText: {
    color: '#A8F0D3',
    fontWeight: '900',
    fontSize: 12,
  },
  headerCoverage: {
    minWidth: 68,
    minHeight: 32,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#3C465F',
    backgroundColor: colors.panelDark2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  headerCoverageText: {
    color: colors.white,
    fontFamily: fonts.display,
    fontSize: 17,
    fontWeight: '900',
    letterSpacing: 0,
  },
  headerMetrics: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 14,
  },
  headerMetric: {
    flex: 1,
    minHeight: 56,
    borderRadius: 8,
    backgroundColor: colors.panelDark2,
    borderWidth: 1,
    borderColor: '#30384B',
    paddingHorizontal: 10,
    paddingVertical: 8,
    justifyContent: 'center',
  },
  headerMetricWide: {
    flex: 1.35,
    minHeight: 56,
    borderRadius: 8,
    backgroundColor: '#22283A',
    borderWidth: 1,
    borderColor: '#3C465F',
    paddingHorizontal: 10,
    paddingVertical: 8,
    justifyContent: 'center',
  },
  headerMetricValue: {
    color: colors.white,
    fontFamily: fonts.display,
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 0,
  },
  headerMetricLabel: {
    color: '#A9B4C7',
    fontFamily: fonts.text,
    fontSize: 11,
    fontWeight: '800',
    marginTop: 2,
  },
  notice: {
    position: 'absolute',
    top: 8,
    left: 10,
    right: 10,
    zIndex: 30,
    elevation: 30,
    padding: 9,
    backgroundColor: colors.amberSoft,
    borderWidth: 1,
    borderColor: '#E7B24D',
    borderRadius: 8,
  },
  noticeInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  noticeText: {
    color: '#74460D',
    flex: 1,
    flexShrink: 1,
    lineHeight: 20,
    fontWeight: '700',
  },
  noticeActions: {
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'flex-end',
  },
  noticeButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#F2CF82',
  },
  noticeButtonText: {
    color: '#4D3309',
    fontWeight: '800',
  },
  content: {
    flex: 1,
    paddingHorizontal: 10,
    zIndex: 1,
  },
  panel: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 8,
    padding: 13,
    marginBottom: 10,
    boxShadow: '0 8px 20px rgba(41, 50, 65, 0.06)',
  },
  stickyPanel: {
    marginBottom: 10,
  },
  stickyPanelCompact: {
    padding: 10,
    overflow: 'hidden',
  },
  stickyPanelSearchMode: {
    paddingVertical: 8,
    marginBottom: 6,
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
    fontFamily: fonts.display,
    fontSize: 17,
    fontWeight: '900',
    color: colors.ink,
    letterSpacing: 0,
  },
  sectionTitle: {
    fontSize: 15,
    fontFamily: fonts.text,
    fontWeight: '900',
    color: colors.ink,
    marginBottom: 8,
  },
  aiSectionTitle: {
    fontSize: 15,
    fontFamily: fonts.text,
    fontWeight: '900',
    color: colors.ink,
    marginTop: 12,
    marginBottom: 8,
  },
  muted: {
    color: colors.muted,
    lineHeight: 19,
    fontFamily: fonts.text,
  },
  helpText: {
    color: colors.muted,
    lineHeight: 19,
    marginTop: -2,
    marginBottom: 10,
  },
  accountStatusPill: {
    minHeight: 30,
    justifyContent: 'center',
    borderRadius: 8,
    paddingHorizontal: 10,
    backgroundColor: colors.blueSoft,
    borderWidth: 1,
    borderColor: '#B8CCF0',
  },
  accountStatusText: {
    color: colors.blue,
    fontWeight: '900',
    fontSize: 12,
  },
  accountSummary: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panelTint,
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
  },
  syncIntervalBlock: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    backgroundColor: colors.white,
    padding: 10,
    marginTop: 8,
  },
  syncIntervalOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  syncIntervalOption: {
    minHeight: 32,
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.panelTint,
    paddingHorizontal: 10,
  },
  syncIntervalOptionActive: {
    borderColor: colors.blue,
    backgroundColor: colors.blueSoft,
  },
  syncIntervalOptionText: {
    color: colors.muted,
    fontWeight: '900',
    fontSize: 12,
  },
  syncIntervalOptionTextActive: {
    color: colors.blue,
  },
  accountSnapshotGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  accountSnapshotCard: {
    flex: 1,
    minWidth: 150,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    backgroundColor: colors.white,
    padding: 10,
  },
  accountSnapshotTitle: {
    color: colors.ink,
    fontWeight: '900',
    fontSize: 12,
    marginBottom: 4,
  },
  accountSnapshotText: {
    color: colors.inkSoft,
    fontFamily: fonts.text,
    fontSize: 12,
    fontWeight: '800',
    lineHeight: 18,
  },
  accountSnapshotMeta: {
    color: colors.muted,
    fontFamily: fonts.text,
    fontSize: 11,
    marginTop: 5,
  },
  restoreCompare: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  restoreColumn: {
    flex: 1,
    minWidth: 180,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panelTint,
    padding: 10,
  },
  segmentedRow: {
    flexDirection: 'row',
    gap: 8,
    marginVertical: 10,
  },
  segmentButton: {
    flex: 1,
    minHeight: 38,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.panelTint,
  },
  segmentButtonActive: {
    borderColor: colors.panelDark,
    backgroundColor: colors.panelDark,
  },
  segmentButtonText: {
    color: colors.muted,
    fontWeight: '900',
  },
  segmentButtonTextActive: {
    color: colors.white,
  },
  flex: {
    flex: 1,
  },
  selectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  selectedRowSearchMode: {
    marginBottom: 0,
  },
  selectedCodeText: {
    fontFamily: fonts.mono,
    fontSize: 21,
    fontWeight: '900',
    color: colors.ink,
    letterSpacing: 0,
  },
  selectedColorMeta: {
    fontSize: 12,
    lineHeight: 17,
  },
  bigCode: {
    fontFamily: fonts.mono,
    fontSize: 24,
    fontWeight: '900',
    color: colors.ink,
    letterSpacing: 0,
  },
  swatchFrame: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#F3F6FA',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  swatchFrameCompact: {
    width: 30,
    height: 30,
    borderRadius: 15,
  },
  swatch: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: 'rgba(23, 26, 33, 0.2)',
    overflow: 'hidden',
  },
  swatchCompact: {
    width: 22,
    height: 22,
    borderRadius: 11,
  },
  swatchHighlight: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginLeft: 5,
    marginTop: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.48)',
  },
  swatchHighlightCompact: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    marginLeft: 4,
    marginTop: 3,
  },
  inputGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  inventoryActionGrid: {
    flexDirection: 'row',
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
  roundActionPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.98 }],
  },
  roundActionText: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '900',
    lineHeight: 24,
  },
  packLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  packSizeLink: {
    color: colors.blue,
    fontWeight: '800',
    textDecorationLine: 'underline',
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
    color: colors.inkSoft,
    fontSize: 12,
    marginBottom: 5,
    fontWeight: '900',
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
    fontFamily: fonts.text,
  },
  nameEditBlock: {
    gap: 8,
    marginBottom: 4,
  },
  nameEditInput: {
    minWidth: 180,
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
    borderWidth: 1,
    borderColor: 'transparent',
  },
  actionButtonText: {
    color: '#FFFFFF',
    fontFamily: fonts.text,
    fontWeight: '900',
  },
  actionButtonPressed: {
    opacity: 0.84,
    transform: [{ translateY: 1 }],
  },
  neutralButtonText: {
    color: colors.ink,
  },
  button_primary: {
    backgroundColor: colors.panelDark,
    borderColor: colors.panelDark,
  },
  button_amber: {
    backgroundColor: colors.amber,
    borderColor: colors.amber,
  },
  button_danger: {
    backgroundColor: colors.red,
    borderColor: colors.red,
  },
  button_neutral: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  toolbar: {
    marginBottom: 8,
  },
  frozenFilters: {
    marginBottom: 8,
    backgroundColor: colors.bg,
  },
  searchInput: {
    minHeight: 42,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.white,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 15,
    fontFamily: fonts.text,
    color: colors.ink,
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
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.lineStrong,
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
  purchasePickerBlockCompact: {
    marginTop: 2,
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
    borderColor: colors.lineStrong,
    backgroundColor: colors.white,
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
    backgroundColor: colors.white,
  },
  purchaseDropdownItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  purchaseDropdownItemActive: {
    backgroundColor: colors.blueSoft,
  },
  purchaseDropdownText: {
    color: colors.ink,
    fontWeight: '700',
  },
  purchaseDropdownTextActive: {
    color: colors.blue,
    fontWeight: '900',
  },
  seriesChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    marginRight: 8,
  },
  seriesChipActive: {
    backgroundColor: colors.panelDark,
    borderColor: colors.panelDark,
  },
  seriesText: {
    color: colors.ink,
    fontWeight: '900',
  },
  seriesTextActive: {
    color: '#FFFFFF',
  },
  list: {
    gap: 5,
    paddingBottom: 24,
  },
  colorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 9,
    paddingVertical: 8,
    backgroundColor: colors.panel,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
  },
  colorRowActive: {
    borderColor: colors.blue,
    backgroundColor: colors.blueSoft,
  },
  codeText: {
    fontFamily: fonts.mono,
    fontSize: 16,
    color: colors.ink,
    fontWeight: '800',
    letterSpacing: 0,
  },
  inventoryCodeText: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.ink,
    fontWeight: '900',
    letterSpacing: 0,
  },
  inventoryColorMeta: {
    fontSize: 12,
    lineHeight: 17,
  },
  right: {
    alignItems: 'flex-end',
    minWidth: 56,
  },
  quantity: {
    color: colors.ink,
    fontWeight: '900',
    fontSize: 18,
    fontFamily: fonts.mono,
  },
  inventoryQuantity: {
    color: colors.ink,
    fontWeight: '900',
    fontSize: 16,
    fontFamily: fonts.mono,
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
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    marginRight: 8,
    maxWidth: 180,
  },
  projectChipActive: {
    backgroundColor: colors.panelDark,
    borderColor: colors.panelDark,
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
    backgroundColor: colors.bgAlt,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.line,
  },
  ocrProgressPanel: {
    marginTop: 10,
    padding: 11,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#B8CCF0',
    backgroundColor: colors.blueSoft,
  },
  ocrProgressTitle: {
    color: colors.blue,
    fontWeight: '900',
    fontSize: 14,
  },
  ocrProgressText: {
    marginTop: 4,
    color: colors.inkSoft,
    fontFamily: fonts.mono,
    fontSize: 12,
    fontWeight: '800',
  },
  deductPreview: {
    marginTop: 12,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E7B24D',
    backgroundColor: colors.amberSoft,
    gap: 10,
  },
  deductRows: {
    borderTopWidth: 1,
    borderTopColor: '#E8C985',
  },
  deductRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: '#E8C985',
  },
  promptBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(18, 22, 32, 0.42)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 18,
  },
  promptPanel: {
    width: '100%',
    maxWidth: 380,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.panel,
    padding: 14,
    gap: 10,
  },
  promptActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 4,
  },
  imagePreviewBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(18, 22, 32, 0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
  },
  imagePreviewPanel: {
    width: '100%',
    maxWidth: 760,
    height: '88%',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.panel,
    padding: 10,
    gap: 10,
  },
  imagePreview: {
    flex: 1,
    width: '100%',
    borderRadius: 8,
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.line,
  },
  cropModalBackdrop: {
    flex: 1,
    backgroundColor: colors.bgAlt,
    alignItems: 'center',
    justifyContent: 'flex-start',
    padding: 12,
  },
  cropModalPanel: {
    width: '100%',
    maxWidth: 760,
    flex: 1,
    borderRadius: 8,
    backgroundColor: colors.panel,
    padding: 10,
    gap: 10,
    borderWidth: 1,
    borderColor: colors.line,
  },
  cropTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  cropCanvas: {
    alignSelf: 'center',
    backgroundColor: colors.panelDark,
    overflow: 'hidden',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.lineStrong,
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
    backgroundColor: 'rgba(45, 102, 195, 0.16)',
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
    backgroundColor: 'rgba(18, 22, 32, 0.76)',
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
    borderColor: colors.blue,
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
    borderColor: colors.lineStrong,
    backgroundColor: colors.white,
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
    marginVertical: 12,
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
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.line,
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
    borderBottomColor: colors.line,
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  disabledBlock: {
    opacity: 0.54,
  },
  checkbox: {
    width: 26,
    height: 26,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
  },
  checkboxActive: {
    backgroundColor: colors.blue,
    borderColor: colors.blue,
  },
  checkboxText: {
    color: '#FFFFFF',
    fontWeight: '900',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 11,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panelTint,
    marginBottom: 10,
  },
  aiSelector: {
    gap: 8,
    marginBottom: 10,
  },
  selectSummary: {
    minHeight: 56,
    padding: 11,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.white,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  selectSummaryOpen: {
    borderColor: colors.blue,
    backgroundColor: colors.blueSoft,
  },
  selectLabel: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '900',
  },
  selectValue: {
    color: colors.ink,
    fontFamily: fonts.text,
    fontSize: 16,
    fontWeight: '900',
    marginTop: 2,
  },
  selectChevron: {
    color: colors.blue,
    backgroundColor: colors.blueSoft,
    borderRadius: 8,
    overflow: 'hidden',
    paddingHorizontal: 9,
    paddingVertical: 6,
    fontSize: 12,
    fontWeight: '900',
  },
  optionList: {
    gap: 8,
    marginBottom: 4,
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#B8CCF0',
    backgroundColor: '#EEF4FF',
  },
  optionRow: {
    padding: 11,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#C8D7F1',
    backgroundColor: colors.white,
    gap: 6,
  },
  optionRowActive: {
    borderColor: colors.blue,
    backgroundColor: colors.blueSoft,
  },
  optionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  optionTitle: {
    color: colors.ink,
    fontFamily: fonts.text,
    fontWeight: '900',
    flexShrink: 1,
  },
  optionTitleActive: {
    color: colors.blue,
  },
  optionTag: {
    color: colors.blue,
    backgroundColor: colors.white,
    borderRadius: 8,
    overflow: 'hidden',
    paddingHorizontal: 7,
    paddingVertical: 3,
    fontSize: 11,
    fontWeight: '900',
  },
  optionTagActive: {
    color: '#FFFFFF',
    backgroundColor: colors.blue,
  },
  optionModel: {
    color: colors.inkSoft,
    fontSize: 12,
    fontFamily: fonts.mono,
    fontWeight: '800',
  },
  optionNote: {
    color: colors.muted,
    lineHeight: 18,
    fontFamily: fonts.text,
    fontSize: 12,
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
    backgroundColor: colors.panelTint,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 8,
    padding: 11,
  },
  statValue: {
    fontFamily: fonts.mono,
    fontSize: 23,
    color: colors.ink,
    fontWeight: '900',
    marginTop: 5,
  },
  purchaseBox: {
    backgroundColor: colors.panelDark,
    borderRadius: 8,
    padding: 14,
    marginTop: 12,
    minHeight: 110,
    borderWidth: 1,
    borderColor: '#30384B',
  },
  purchaseText: {
    color: '#F4F7FB',
    fontFamily: fonts.mono,
    fontSize: 18,
    lineHeight: 28,
    fontWeight: '800',
  },
  empty: {
    padding: 24,
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: colors.panelTint,
    borderWidth: 1,
    borderColor: colors.line,
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
    backgroundColor: colors.amberSoft,
    borderWidth: 1,
    borderColor: '#E7B24D',
    borderRadius: 8,
  },
  historyScrollBox: {
    maxHeight: 310,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    backgroundColor: colors.panelTint,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  historyActions: {
    flexDirection: 'row',
    gap: 6,
  },
  historyLabel: {
    color: colors.ink,
    fontFamily: fonts.text,
    fontSize: 13,
    fontWeight: '800',
    lineHeight: 17,
  },
  smallAction: {
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.lineStrong,
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
    gap: 7,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.white,
    zIndex: 0,
  },
  tab: {
    flex: 1,
    minHeight: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  tabActive: {
    backgroundColor: colors.panelDark,
    borderColor: colors.panelDark,
  },
  tabText: {
    color: colors.muted,
    fontWeight: '800',
    fontFamily: fonts.text,
  },
  tabTextActive: {
    color: '#FFFFFF',
  },
});
