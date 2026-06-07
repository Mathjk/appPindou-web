import { MARD_291_COLORS, tryNormalizeBeadCode } from './data/mard291';
import type { AppSettings, OcrDraftResult } from './types';

type RecognizeOptions = {
  rawText?: string;
  settings?: AppSettings;
};

type OcrPair = { code: string; quantity: number; confidence?: number; source?: string };
type RefineOutcome = { status: 'skipped' | 'ready' | 'empty'; items: OcrPair[] };
type RecognitionFrame = { left: number; top: number; width: number; height: number };
type TextRecognitionResult = {
  text: string;
  blocks?: Array<{
    text: string;
    frame?: RecognitionFrame;
    recognizedLanguages?: unknown[];
    lines?: Array<{
      text: string;
      frame?: RecognitionFrame;
      recognizedLanguages?: unknown[];
      elements?: Array<{ text: string; frame?: RecognitionFrame }>;
    }>;
  }>;
};
type PositionedToken = {
  text: string;
  frame?: RecognitionFrame;
  centerX: number;
  centerY: number;
  code?: string;
  quantity?: number;
  quantityMarked?: boolean;
};
type OpenAiChatMessage = {
  role: 'system' | 'user';
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
};
type OpenAiChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};
type OcrSpaceResponse = {
  ParsedResults?: Array<{ ParsedText?: string; ErrorMessage?: string }>;
  IsErroredOnProcessing?: boolean;
  ErrorMessage?: string | string[];
};

const DEFAULT_OCR_SPACE_ENDPOINT = 'https://api.ocr.space/parse/image';
const DEFAULT_OCR_SPACE_KEY = 'helloworld';
const DEFAULT_VISION_MODEL = 'ocr.space-engine2';
const DEFAULT_TEXT_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const DEFAULT_VISION_PROMPT = [
  '你是拼豆图纸 OCR 助手。',
  '请只读取图片中 MARD 拼豆色号、颜色名以及对应需要颗数的区域。',
  '尽量保持原始行列关系，不要解释，不要推测库存。',
  '如果看见色号下一行是 x123 / 123 / 123颗，要保留对应关系。',
  '输出纯文本即可。',
].join('\n');

const DEFAULT_TEXT_PROMPT = [
  '你是 MARD 291 拼豆用量整理器。',
  '任务：把 OCR 原文整理成 JSON 数组，每项包含 code 和 quantity。',
  '只输出 JSON，不要 markdown，不要解释。',
  '规则：',
  '- code 必须是下面色表中的 MARD 色号；如果 OCR 出现 A09/G02/ZG01，要规范成 A9/G2/ZG1。',
  '- quantity 是需要颗数，只取正整数。',
  '- 如果同一 code 出现多次，合并数量。',
  '- 无法确认 code 或 quantity 的内容直接忽略。',
  '- 可以根据中文/英文颜色名匹配色号，但不要编造没有依据的色号。',
].join('\n');

const PALETTE_PROMPT = MARD_291_COLORS.map((color) => {
  const names = [color.nameZh, color.nameEn].filter(Boolean).join('/');
  return names ? `${color.code}=${names}` : color.code;
}).join('; ');

export async function recognizePatternDraft(_imageUri: string, options: RecognizeOptions = {}): Promise<OcrDraftResult> {
  const rawText = options.rawText?.trim();
  if (rawText) return buildTextParserResult(rawText);
  return recognizeWithRemoteAi(_imageUri, options.settings);
}

async function recognizeWithRemoteAi(imageUri: string, settings?: AppSettings): Promise<OcrDraftResult> {
  const config = normalizeAiOcrSettings(settings);
  if (!config.visionEndpoint || !config.visionApiKey) {
    return {
      status: 'failed',
      engine: 'remote-ocr',
      message: '请先在设置里填写 OCR API Key 和 Endpoint。',
      items: [],
    };
  }

  try {
    const imageDataUrl = await imageUriToDataUrl(imageUri);
    const visionText = isOcrSpaceEndpoint(config.visionEndpoint, config.visionModel)
      ? await callOcrSpace({
          endpoint: config.visionEndpoint,
          apiKey: config.visionApiKey,
          model: config.visionModel,
          imageDataUrl,
        })
      : await callOpenAiCompatibleChat({
          endpoint: config.visionEndpoint,
          apiKey: config.visionApiKey,
          model: config.visionModel,
          messages: [
            { role: 'system', content: DEFAULT_VISION_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'text', text: '请识别这张拼豆图纸裁剪区域里的色号/颜色名和数量。' },
                { type: 'image_url', image_url: { url: imageDataUrl } },
              ],
            },
          ],
          maxTokens: 1600,
        });

    const localItems = parsePatternOcrText(visionText);
    let refineError = '';
    let refineOutcome: RefineOutcome = { status: 'skipped', items: [] };
    try {
      refineOutcome = await refineOcrTextWithAi(visionText, config);
    } catch (error) {
      refineError = error instanceof Error ? error.message : '未知错误';
    }
    const aiItems = refineOutcome.items;
    const items = chooseBestParsedItems(aiItems, localItems);
    const usedTextModel = items === aiItems && aiItems.length > 0;
    const engine = `${config.visionModel} + ${refineOutcome.status === 'skipped' && !refineError ? '本地解析' : config.textModel}`;

    if (!items.length) {
      return {
        status: 'failed',
        engine,
        rawText: visionText,
        message: refineError
          ? `OCR 已返回文本，但文本整理失败：${refineError}。请检查裁剪区域并手动校正。`
          : 'OCR 已返回文本，但没有整理出有效 MARD 色号和数量。请检查裁剪区域并手动校正。',
        items: [],
      };
    }

    return {
      status: 'ready',
      engine,
      rawText: visionText,
      message: buildRecognitionMessage(items.length, config.textModel, refineOutcome.status, usedTextModel, refineError),
      items,
    };
  } catch (error) {
    return {
      status: 'failed',
      engine: config.visionModel || 'remote-ocr',
      message: `OCR 调用失败：${error instanceof Error ? error.message : '未知错误'}`,
      items: [],
    };
  }
}

function buildTextParserResult(rawText: string): OcrDraftResult {
  const items = parsePatternOcrText(rawText);
  if (!items.length) {
    return {
      status: 'failed',
      engine: 'text-parser',
      rawText,
      message: '没有从 OCR 文本中解析出有效 MARD 色号和数量，请检查格式后再试。',
      items: [],
    };
  }

  return {
    status: 'ready',
    engine: 'text-parser',
    rawText,
    message: `已解析 ${items.length} 个颜色，结果已写入用量草稿，可继续人工校正。`,
    items,
  };
}

function normalizeAiOcrSettings(settings?: AppSettings) {
  const visionEndpoint = settings?.aiOcrEndpoint.trim() || DEFAULT_OCR_SPACE_ENDPOINT;
  const visionModel = settings?.aiOcrModel.trim() || DEFAULT_VISION_MODEL;
  const shouldReuseKey = Boolean(settings?.aiOcrUseSameKey) && !isOcrSpaceEndpoint(visionEndpoint, visionModel);
  return {
    visionApiKey: settings?.aiOcrApiKey.trim() || DEFAULT_OCR_SPACE_KEY,
    visionEndpoint,
    visionModel,
    textApiKey: (shouldReuseKey ? settings?.aiOcrApiKey : settings?.aiOcrTextApiKey)?.trim() ?? '',
    textEndpoint: settings?.aiOcrTextEndpoint.trim() || DEFAULT_TEXT_ENDPOINT,
    textModel: settings?.aiOcrTextModel.trim() || 'deepseek-v4-flash',
  };
}

async function callOcrSpace({
  endpoint,
  apiKey,
  model,
  imageDataUrl,
}: {
  endpoint: string;
  apiKey: string;
  model: string;
  imageDataUrl: string;
}) {
  const body = new URLSearchParams({
    apikey: apiKey || DEFAULT_OCR_SPACE_KEY,
    base64Image: imageDataUrl,
    language: 'eng',
    OCREngine: getOcrSpaceEngine(model),
    scale: 'true',
    isTable: 'true',
    detectOrientation: 'true',
  });
  const response = await fetch(endpoint || DEFAULT_OCR_SPACE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const payload = (await response.json().catch(() => ({}))) as OcrSpaceResponse;
  const errorMessage = Array.isArray(payload.ErrorMessage) ? payload.ErrorMessage.join('；') : payload.ErrorMessage;
  if (!response.ok || payload.IsErroredOnProcessing) {
    throw new Error(errorMessage || payload.ParsedResults?.[0]?.ErrorMessage || `OCR.space 返回 HTTP ${response.status}`);
  }
  const text = (payload.ParsedResults ?? [])
    .map((item) => item.ParsedText?.trim())
    .filter(Boolean)
    .join('\n');
  if (!text) throw new Error('OCR.space 没有返回可解析文本');
  return text;
}

function isOcrSpaceEndpoint(endpoint: string, model: string) {
  return endpoint.includes('ocr.space') || model.toLowerCase().startsWith('ocr.space');
}

function getOcrSpaceEngine(model: string) {
  const normalized = model.toLowerCase();
  if (normalized.includes('engine1')) return '1';
  if (normalized.includes('engine3')) return '3';
  return '2';
}

async function refineOcrTextWithAi(rawText: string, config: ReturnType<typeof normalizeAiOcrSettings>) {
  if (!config.textApiKey || !config.textEndpoint) return { status: 'skipped', items: [] } satisfies RefineOutcome;
  const content = await callOpenAiCompatibleChat({
    endpoint: config.textEndpoint,
    apiKey: config.textApiKey,
    model: config.textModel,
    messages: [
      { role: 'system', content: `${DEFAULT_TEXT_PROMPT}\n\nMARD 291 色表：${PALETTE_PROMPT}` },
      { role: 'user', content: `OCR 原文：\n${rawText}` },
    ],
    maxTokens: 2200,
  });
  const items = parseAiJsonItems(content);
  return { status: items.length ? 'ready' : 'empty', items } satisfies RefineOutcome;
}

function buildRecognitionMessage(count: number, textModel: string, refineStatus: RefineOutcome['status'], usedTextModel: boolean, refineError: string) {
  if (refineError) {
    return `OCR 已识别 ${count} 个颜色；文本模型整理失败：${refineError}。已使用本地解析结果，可继续人工校正。`;
  }
  if (refineStatus === 'ready') {
    return usedTextModel
      ? `OCR 已识别 ${count} 个颜色；文本模型 ${textModel} 已参与整理，并采用文本模型结果。`
      : `OCR 已识别 ${count} 个颜色；文本模型 ${textModel} 已参与整理，本地解析结果更完整，已采用本地结果。`;
  }
  if (refineStatus === 'empty') {
    return `OCR 已识别 ${count} 个颜色；文本模型已调用但没有返回有效用量，已使用本地解析结果。`;
  }
  return `OCR 已识别 ${count} 个颜色；未填写文本 API Key，已使用本地解析结果。`;
}

async function callOpenAiCompatibleChat({
  endpoint,
  apiKey,
  model,
  messages,
  maxTokens,
}: {
  endpoint: string;
  apiKey: string;
  model: string;
  messages: OpenAiChatMessage[];
  maxTokens: number;
}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0,
      max_tokens: maxTokens,
      stream: false,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as OpenAiChatResponse;
  if (!response.ok) {
    throw new Error(payload.error?.message || `接口返回 HTTP ${response.status}`);
  }
  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('接口没有返回可解析文本');
  return content;
}

function parseAiJsonItems(content: string) {
  const jsonText = extractJsonBlock(content);
  if (!jsonText) return [];
  try {
    const parsed = JSON.parse(jsonText) as
      | Array<{ code?: unknown; quantity?: unknown; qty?: unknown; count?: unknown }>
      | { items?: Array<{ code?: unknown; quantity?: unknown; qty?: unknown; count?: unknown }> };
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [];
    const pairs = rows
      .map((item) => ({
        code: String(item.code ?? ''),
        quantity: Number(item.quantity ?? item.qty ?? item.count),
        confidence: 0.9,
        source: 'ai-json',
      }))
      .filter((item) => item.code && Number.isFinite(item.quantity));
    return mergeParsedPairs(pairs);
  } catch {
    return [];
  }
}

function extractJsonBlock(content: string) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || content.trim();
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start >= 0 && end > start) return candidate.slice(start, end + 1);
  const objectStart = candidate.indexOf('{');
  const objectEnd = candidate.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) return candidate.slice(objectStart, objectEnd + 1);
  return undefined;
}

async function imageUriToDataUrl(uri: string) {
  if (uri.startsWith('data:image/')) return uri;
  if (uri.startsWith('blob:') || uri.startsWith('http://') || uri.startsWith('https://')) {
    const blob = await fetch(uri).then((response) => response.blob());
    return readBlobAsDataUrl(blob);
  }

  const { File } = await import('expo-file-system');
  const file = new File(uri);
  const base64 = await file.base64();
  const mime = guessImageMime(uri);
  return `data:${mime};base64,${base64}`;
}

function readBlobAsDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(blob);
  });
}

function guessImageMime(uri: string) {
  const lower = uri.toLowerCase();
  if (lower.includes('.png')) return 'image/png';
  if (lower.includes('.webp')) return 'image/webp';
  return 'image/jpeg';
}

export function parsePatternOcrText(rawText: string) {
  const normalized = normalizeOcrText(rawText);
  const lines = normalized
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const pairs: OcrPair[] = [];

  for (const line of lines) {
    if (isCodeOnlyLegendRow(line)) continue;
    pairs.push(...extractPairs(line).map((pair) => ({ ...pair, confidence: 0.78, source: 'same-line' })));
  }
  pairs.push(...extractAdjacentRowPairs(lines));
  if (!pairs.length) pairs.push(...extractSequentialTokenPairs(lines.join('\n')));

  return mergeParsedPairs(pairs);
}

export function parsePositionedOcrResult(result: TextRecognitionResult) {
  const tokens = collectPositionedTokens(result);
  const codeTokens = tokens.filter((token) => token.code);
  const quantityTokens = tokens.filter((token) => token.quantity && token.quantityMarked);
  const fallbackQuantityTokens = quantityTokens.length ? quantityTokens : tokens.filter((token) => token.quantity && !token.code);
  const usedCodeIndexes = new Set<number>();
  const pairs: OcrPair[] = [];

  fallbackQuantityTokens
    .slice()
    .sort((left, right) => left.centerY - right.centerY || left.centerX - right.centerX)
    .forEach((quantityToken) => {
      const candidates = codeTokens
        .map((codeToken, index) => ({ token: codeToken, index, score: scorePositionedPair(codeToken, quantityToken) }))
        .filter((candidate) => candidate.score < Number.POSITIVE_INFINITY && !usedCodeIndexes.has(candidate.index))
        .sort((left, right) => left.score - right.score);
      const best = candidates[0];
      if (!best?.token.code || !quantityToken.quantity) return;
      usedCodeIndexes.add(best.index);
      pairs.push({
        code: best.token.code,
        quantity: quantityToken.quantity,
        confidence: quantityToken.quantityMarked ? 0.88 : 0.76,
        source: 'positioned-legend',
      });
    });

  return mergeParsedPairs(pairs);
}

function chooseBestParsedItems(positionedItems: OcrPair[], textItems: OcrPair[]) {
  if (positionedItems.length >= textItems.length) return positionedItems;
  if (!positionedItems.length) return textItems;
  const positionedTotal = positionedItems.reduce((sum, item) => sum + item.quantity, 0);
  const textTotal = textItems.reduce((sum, item) => sum + item.quantity, 0);
  return positionedTotal >= textTotal * 0.8 ? positionedItems : textItems;
}

function extractPairs(line: string) {
  const pairs: Array<{ code: string; quantity: number }> = [];
  const codeFirst = /((?:ZG|[A-Z])\s*0?\d{1,3})(?:\s|[-:：,，;；X×*＊]){1,12}X?\s*(\d{1,6})/g;
  const quantityFirst = /X?\s*(\d{1,6})(?:\s|[-:：,，;；X×*＊]){1,12}((?:ZG|[A-Z])\s*0?\d{1,3})/g;

  for (const match of line.matchAll(codeFirst)) {
    const pair = normalizePair(match[1], match[2]);
    if (pair) pairs.push(pair);
  }
  for (const match of line.matchAll(quantityFirst)) {
    const pair = normalizePair(match[2], match[1]);
    if (pair && !pairs.some((item) => item.code === pair.code && item.quantity === pair.quantity)) {
      pairs.push(pair);
    }
  }

  return pairs;
}

function isCodeOnlyLegendRow(line: string) {
  const codes = extractCodeTokens(line);
  if (codes.length < 2) return false;
  return !extractQuantityTokens(line, true).length;
}

function extractAdjacentRowPairs(lines: string[]) {
  const pairs: OcrPair[] = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const codes = extractCodeTokens(lines[index]);
    const currentLineQuantities = extractQuantityTokens(lines[index], true);
    if (!codes.length || currentLineQuantities.length) continue;

    const quantities = findQuantityRowForCodeRow(lines, index, codes.length);
    if (!quantities.length) continue;

    const count = Math.min(codes.length, quantities.length);
    for (let pairIndex = 0; pairIndex < count; pairIndex += 1) {
      pairs.push({
        code: codes[pairIndex],
        quantity: quantities[pairIndex].quantity,
        confidence: quantities[pairIndex].marked ? 0.84 : 0.72,
        source: 'code-row-quantity-row',
      });
    }
  }
  return pairs;
}

function findQuantityRowForCodeRow(lines: string[], codeLineIndex: number, codeCount: number) {
  const maxLookAhead = 3;
  let standaloneFallback: Array<{ quantity: number; marked: boolean }> = [];

  for (let offset = 1; offset <= maxLookAhead && codeLineIndex + offset < lines.length; offset += 1) {
    const line = lines[codeLineIndex + offset];
    const nextCodes = extractCodeTokens(line);
    if (nextCodes.length) break;

    const markedQuantities = extractQuantityTokens(line, false);
    if (canPairLegendRows(codeCount, markedQuantities.length)) return markedQuantities;

    const allQuantities = extractQuantityTokens(line, true);
    if (!standaloneFallback.length && canPairLegendRows(codeCount, allQuantities.length)) {
      standaloneFallback = allQuantities;
    }
  }

  return standaloneFallback;
}

function canPairLegendRows(codeCount: number, quantityCount: number) {
  return (
    codeCount === quantityCount ||
    (codeCount >= 2 && quantityCount >= 2 && Math.abs(codeCount - quantityCount) <= 2) ||
    (codeCount === 1 && quantityCount === 1)
  );
}

function extractSequentialTokenPairs(text: string) {
  const tokens = tokenizeOcrText(text);
  const pairs: OcrPair[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const code = normalizeCodeToken(tokens[index]);
    if (!code) continue;
    const quantity = parseQuantityToken(tokens[index + 1], true);
    if (!quantity) continue;
    pairs.push({ code, quantity: quantity.quantity, confidence: quantity.marked ? 0.82 : 0.7, source: 'token-sequence' });
    index += 1;
  }
  return pairs;
}

function normalizePair(codeInput: string, quantityInput: string) {
  const code = tryNormalizeBeadCode(codeInput.replace(/\s+/g, ''));
  const quantity = Number(quantityInput.replace(/[^\d]/g, ''));
  if (!code || !Number.isFinite(quantity) || quantity <= 0) return null;
  return { code, quantity: Math.floor(quantity) };
}

function extractCodeTokens(line: string) {
  const codes: string[] = [];
  const codePattern = /(?:ZG|[A-Z])\s*0?\d{1,3}/g;
  for (const match of line.matchAll(codePattern)) {
    const before = match.index ? line[match.index - 1] : '';
    const after = line[match.index + match[0].length] ?? '';
    if (isAlphaNumeric(before) || isAlphaNumeric(after)) continue;
    const code = normalizeCodeToken(match[0]);
    if (code) codes.push(code);
  }
  return codes;
}

function extractQuantityTokens(line: string, allowStandalone: boolean) {
  const quantities: Array<{ quantity: number; marked: boolean }> = [];
  const markedPattern = /\bX\s*(\d{1,6})\b/g;
  for (const match of line.matchAll(markedPattern)) {
    const quantity = Number(match[1]);
    if (quantity > 0) quantities.push({ quantity, marked: true });
  }
  if (quantities.length || !allowStandalone) return quantities;
  const standalonePattern = /(?:^|[^\dA-Z])(\d{1,6})(?=$|[^\dA-Z])/g;
  for (const match of line.matchAll(standalonePattern)) {
    const quantity = Number(match[1]);
    if (quantity > 0) quantities.push({ quantity, marked: false });
  }
  return quantities;
}

function tokenizeOcrText(text: string) {
  return text.match(/(?:ZG|[A-Z])\s*0?\d{1,3}|X\s*\d{1,6}|\d{1,6}/g) ?? [];
}

function normalizeCodeToken(token: string) {
  return tryNormalizeBeadCode(token.replace(/\s+/g, ''));
}

function parseQuantityToken(token: string, allowStandalone: boolean) {
  const normalized = token.replace(/\s+/g, '');
  const marked = /^X\d{1,6}$/.test(normalized);
  if (!marked && !allowStandalone) return undefined;
  if (!marked && !/^\d{1,6}$/.test(normalized)) return undefined;
  const quantity = Number(normalized.replace(/[^\d]/g, ''));
  if (!Number.isFinite(quantity) || quantity <= 0) return undefined;
  return { quantity: Math.floor(quantity), marked };
}

function collectPositionedTokens(result: TextRecognitionResult) {
  const tokens: PositionedToken[] = [];
  for (const block of result.blocks ?? []) {
    for (const line of block.lines ?? []) {
      const elements = line.elements?.length ? line.elements : [{ text: line.text, frame: line.frame }];
      for (const element of elements) {
        const frame = element.frame ?? line.frame ?? block.frame;
        if (!frame) continue;
        for (const token of tokenizeOcrText(normalizeOcrText(element.text))) {
          const code = normalizeCodeToken(token);
          const quantity = code ? undefined : parseQuantityToken(token, false) ?? parseQuantityToken(token, true);
          tokens.push({
            text: token,
            frame,
            centerX: frame.left + frame.width / 2,
            centerY: frame.top + frame.height / 2,
            code,
            quantity: quantity?.quantity,
            quantityMarked: quantity?.marked,
          });
        }
      }
    }
  }
  return tokens;
}

function scorePositionedPair(codeToken: PositionedToken, quantityToken: PositionedToken) {
  if (!codeToken.frame || !quantityToken.frame) return Number.POSITIVE_INFINITY;
  const verticalDistance = quantityToken.centerY - codeToken.centerY;
  const horizontalDistance = Math.abs(quantityToken.centerX - codeToken.centerX);
  const lineHeight = Math.max(codeToken.frame.height, quantityToken.frame.height, 1);
  const maxVerticalDistance = Math.max(160, lineHeight * 5);
  const maxHorizontalDistance = Math.max(72, codeToken.frame.width * 1.8, quantityToken.frame.width * 1.8);
  if (verticalDistance <= 0 || verticalDistance > maxVerticalDistance || horizontalDistance > maxHorizontalDistance) {
    return Number.POSITIVE_INFINITY;
  }
  return horizontalDistance + verticalDistance * 0.18;
}

function mergeParsedPairs(pairs: OcrPair[]) {
  const totals = new Map<string, { quantity: number; confidence: number; exactPairs: Set<number> }>();
  for (const pair of pairs) {
    const code = tryNormalizeBeadCode(pair.code);
    const quantity = Math.floor(pair.quantity);
    if (!code || !Number.isFinite(quantity) || quantity <= 0) continue;
    const current = totals.get(code) ?? { quantity: 0, confidence: 0, exactPairs: new Set<number>() };
    if (current.exactPairs.has(quantity)) {
      current.confidence = Math.max(current.confidence, pair.confidence ?? 0.7);
      totals.set(code, current);
      continue;
    }
    current.quantity += quantity;
    current.confidence = Math.max(current.confidence, pair.confidence ?? 0.7);
    current.exactPairs.add(quantity);
    totals.set(code, current);
  }

  return [...totals.entries()]
    .map(([code, value]) => ({ code, quantity: value.quantity, confidence: value.confidence }))
    .sort((left, right) => left.code.localeCompare(right.code, undefined, { numeric: true }));
}

function isAlphaNumeric(value: string) {
  return /[A-Z0-9]/.test(value);
}

function normalizeOcrText(value: string) {
  return value
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xff10 + 48))
    .replace(/[ａ-ｚ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xff41 + 97))
    .replace(/[Ａ-Ｚ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xff21 + 65))
    .replace(/[×✕＊*]/g, ' X')
    .replace(/[：:，,；;]/g, ' ')
    .replace(/[颗粒个]/g, ' ')
    .toUpperCase();
}
