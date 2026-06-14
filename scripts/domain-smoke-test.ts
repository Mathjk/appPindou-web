import { MARD_291_COLORS, getColor, isKnownBeadCode, normalizeBeadCode } from '../src/data/mard291';
import { parsePatternOcrText, parsePositionedOcrResult } from '../src/ocr';
import {
  addPurchaseItem,
  applyStockChange,
  buildPurchaseRows,
  buildRequirementRows,
  completePurchaseList,
  createEmptyData,
  createProject,
  deductProjectInventory,
  formatPurchaseRows,
  getProjectDeductCount,
  getStock,
  recordActionHistory,
  rollbackToHistoryEntry,
  undoSingleHistoryEntry,
  upsertPurchaseList,
  upsertProject,
} from '../src/domain';

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

let data = createEmptyData();
const purchaseList = { ...data.purchaseLists[0], packSize: 1200 };
data = upsertPurchaseList(data, purchaseList);

const project = {
  ...createProject('测试图纸'),
  items: [{ id: 'item_1', code: 'G02', quantity: 1444 }],
};

data = upsertProject(data, project);
data = addPurchaseItem(data, purchaseList.id, 'G02', 1444);

let rows = buildRequirementRows(data, [project], purchaseList.packSize);
let purchaseRows = buildPurchaseRows(data.purchaseLists[0]);
assert(MARD_291_COLORS.length === 291, 'MARD palette should contain 291 colors');
assert(normalizeBeadCode('g02') === 'G2', 'G02 alias should normalize to G2');
assert(isKnownBeadCode('7') === false, 'invalid OCR noise should not throw in known-code checks');
assert(normalizeBeadCode('89') === '89', 'bare numeric OCR noise should normalize without throwing');
assert(isKnownBeadCode('89') === false, 'bare numeric OCR noise should be ignored as an unknown color');
assert(getColor('G2')?.nameZh === '浅棕', 'G2 should include reference Chinese color name');
assert(formatPurchaseRows(purchaseRows) === 'G2×2', '1444 purchase need at 1200 per pack should buy 2 packs');

data = applyStockChange(data, 'G2', 244, 'purchase', 'test');
rows = buildRequirementRows(data, [project], purchaseList.packSize);
assert(rows[0].missing === 1200 && rows[0].packsToBuy === 1, 'exactly 1200 missing should buy 1 pack');

data = applyStockChange(data, 'G2', -1, 'use', 'test');
rows = buildRequirementRows(data, [project], purchaseList.packSize);
assert(rows[0].missing === 1201 && rows[0].packsToBuy === 2, '1201 missing should buy 2 packs');

data = deductProjectInventory(data, project);
assert(data.inventory.G2.quantity === 0, 'deducting more than stock should clamp inventory to zero');
assert(data.projects[0].deductedAt, 'deducting a project should mark deductedAt');
assert(getProjectDeductCount(data.projects[0]) === 1, 'deducting a project should increment deduct count');
assert(data.projects[0].status === 'active', 'deducting a project should mark it active');

let purchaseCompleteData = createEmptyData();
const purchaseCompleteList = purchaseCompleteData.purchaseLists[0];
purchaseCompleteData = addPurchaseItem(purchaseCompleteData, purchaseCompleteList.id, 'A1', 120);
purchaseCompleteData = addPurchaseItem(purchaseCompleteData, purchaseCompleteList.id, 'A2', 80);
purchaseCompleteData = recordActionHistory(purchaseCompleteData, completePurchaseList(purchaseCompleteData, purchaseCompleteList.id), '采购完成入库');
assert(getStock(purchaseCompleteData, 'A1') === 120, 'complete purchase should add first color into inventory');
assert(getStock(purchaseCompleteData, 'A2') === 80, 'complete purchase should add second color into inventory');
assert(purchaseCompleteData.purchaseLists[0].items.length === 0, 'complete purchase should clear current purchase list');
purchaseCompleteData = undoSingleHistoryEntry(purchaseCompleteData, purchaseCompleteData.actionHistory[0].id);
assert(getStock(purchaseCompleteData, 'A1') === 0, 'undo purchase completion should remove added stock');
assert(purchaseCompleteData.purchaseLists[0].items.length === 2, 'undo purchase completion should restore purchase items');

let safetyData = createEmptyData();
const safetyProject = {
  ...createProject('余量预警测试'),
  items: [{ id: 'safe_item_1', code: 'G2', quantity: 134 }],
};
safetyData = upsertProject(safetyData, safetyProject);
safetyData = applyStockChange(safetyData, 'G2', 136, 'purchase', 'safety');
const safetyRows = buildRequirementRows(safetyData, [safetyProject]);
assert(safetyRows[0].missing === 0, 'safety warning row should not be missing');
assert(safetyRows[0].remaining === 2, 'safety warning row should expose stock remaining');
assert(safetyRows[0].safetyWarning === true, 'remaining below default 50 should trigger safety warning');

let deductHistoryData = createEmptyData();
const deductHistoryProject = {
  ...createProject('扣除撤销测试'),
  items: [{ id: 'deduct_item_1', code: 'G2', quantity: 10 }],
};
deductHistoryData = upsertProject(deductHistoryData, deductHistoryProject);
deductHistoryData = applyStockChange(deductHistoryData, 'G2', 30, 'purchase', 'deduct history');
deductHistoryData = recordActionHistory(deductHistoryData, deductProjectInventory(deductHistoryData, deductHistoryProject), '扣除库存');
assert(getProjectDeductCount(deductHistoryData.projects[0]) === 1, 'history deduct should mark one deduction');
deductHistoryData = undoSingleHistoryEntry(deductHistoryData, deductHistoryData.actionHistory[0].id);
assert(getProjectDeductCount(deductHistoryData.projects[0]) === 0, 'undo deduct should restore deduct count');
assert(deductHistoryData.projects[0].deductedAt === undefined, 'undo deduct should clear deductedAt when it was not set before');
assert(getStock(deductHistoryData, 'G2') === 30, 'undo deduct should restore inventory');

let historyData = createEmptyData();
historyData = recordActionHistory(historyData, applyStockChange(historyData, 'G2', 100, 'purchase', 'history'), 'G2 add 100');
historyData = recordActionHistory(historyData, applyStockChange(historyData, 'G2', 50, 'purchase', 'history'), 'G2 add 50');
assert(historyData.actionHistory.length === 2, 'history should record data operations');
const firstHistoryId = historyData.actionHistory[1].id;
const latestHistoryId = historyData.actionHistory[0].id;
historyData = undoSingleHistoryEntry(historyData, firstHistoryId);
assert(getStock(historyData, 'G2') === 50, 'single undo should only reverse the selected stock delta');
historyData = rollbackToHistoryEntry(historyData, latestHistoryId);
assert(getStock(historyData, 'G2') === 100, 'rollback should restore the state before the selected latest operation');
const beforeReset = historyData;
historyData = recordActionHistory(historyData, createEmptyData(), 'reset');
historyData = undoSingleHistoryEntry(historyData, historyData.actionHistory[0].id);
assert(getStock(historyData, 'G2') === getStock(beforeReset, 'G2'), 'reset should be recoverable from history');

let imageHistoryData = createEmptyData();
const imageProject = createProject('图片历史测试');
imageHistoryData = { ...imageHistoryData, projects: [imageProject] };
const bigImage = `data:image/png;base64,${'A'.repeat(500000)}`;
const afterOcrImage = {
  ...imageHistoryData,
  projects: [
    {
      ...imageProject,
      imageUri: bigImage,
      originalImageUri: bigImage,
      croppedImageUri: bigImage,
      items: [{ id: 'image_item_1', code: 'A1', quantity: 100, note: 'OCR 识别' }],
    },
  ],
};
imageHistoryData = recordActionHistory(imageHistoryData, afterOcrImage, '裁剪并 OCR');
const imageHistoryEntry = imageHistoryData.actionHistory[0];
assert(imageHistoryData.projects[0].imageUri === bigImage, 'live project state should keep OCR image data');
assert(imageHistoryEntry.after.projects[0].imageUri === undefined, 'history snapshot should strip imageUri');
assert(imageHistoryEntry.after.projects[0].croppedImageUri === undefined, 'history snapshot should strip croppedImageUri');
assert(JSON.stringify(imageHistoryData.actionHistory).length < 10000, 'history snapshots should not store large image data URLs');
const imageHistoryRollback = rollbackToHistoryEntry(imageHistoryData, imageHistoryEntry.id);
assert(imageHistoryRollback.projects[0]?.imageUri === bigImage, 'rollback should re-attach current project image data');

const ocrItems = parsePatternOcrText('g2×144\nA09 32颗\nZG1：５');
assert(ocrItems.find((item) => item.code === 'G2')?.quantity === 144, 'OCR parser should parse lowercase code with multiplication sign');
assert(ocrItems.find((item) => item.code === 'A9')?.quantity === 32, 'OCR parser should normalize leading zero codes');
assert(ocrItems.find((item) => item.code === 'ZG1')?.quantity === 5, 'OCR parser should parse full-width digits');
const noisyOcrItems = parsePatternOcrText('89\nG2 X5\nMARD 89\nA9 12');
assert(noisyOcrItems.find((item) => item.code === 'G2')?.quantity === 5, 'OCR parser should keep valid pairs around bare numeric noise');
assert(noisyOcrItems.find((item) => item.code === 'A9')?.quantity === 12, 'OCR parser should continue after invalid MARD numeric noise');

const legendRows = parsePatternOcrText('B11 E14 F1 F11 F14 F9 G13 G14 G17 G3 H12 H2 H3 H4 H6 H7 M9\nx162 x865 x75 x17 x261 x148 x29 x330 x225 x26 x19 x152 x210 x100 x1147 x1127 x484');
assert(legendRows.find((item) => item.code === 'B11')?.quantity === 162, 'OCR parser should pair bottom legend code row with quantity row');
assert(legendRows.find((item) => item.code === 'E14')?.quantity === 865, 'OCR parser should not add adjacent color-code numbers as quantities');
assert(legendRows.find((item) => item.code === 'F9')?.quantity === 148, 'OCR parser should keep exact quantity for tabular legend rows');
assert(legendRows.find((item) => item.code === 'H6')?.quantity === 1147, 'OCR parser should keep code/quantity order across long legend rows');
assert(legendRows.length === 17, 'OCR parser should parse all colors in the cropped legend');

const multiLineLegendRows = parsePatternOcrText(
  [
    'E14 E15 F1 F14 F6 F7 F8 G2 H12 H3 H4 H5 H6',
    'x132 x110 x5 x15 x55 x197 x363 x57 x133 x20 x241 x533 x151',
    'H7 M12 M9',
    'x462 x13 x13',
  ].join('\n'),
);
assert(multiLineLegendRows.find((item) => item.code === 'E14')?.quantity === 132, 'multi-line legend should parse first code row');
assert(multiLineLegendRows.find((item) => item.code === 'H6')?.quantity === 151, 'multi-line legend should parse end of first code row');
assert(multiLineLegendRows.find((item) => item.code === 'H7')?.quantity === 462, 'multi-line legend should parse second code row');
assert(multiLineLegendRows.find((item) => item.code === 'M12')?.quantity === 13, 'multi-line legend should parse second row middle code');
assert(multiLineLegendRows.find((item) => item.code === 'M9')?.quantity === 13, 'multi-line legend should parse second row last code');
assert(multiLineLegendRows.length === 16, 'multi-line legend should parse all rows without duplicates');

const noisyMultiLineLegendRows = parsePatternOcrText(
  [
    'E14\tE15\tF1\tF14\tF6\tF7\tF8\tG2\tH12\tH3\tH4\tH5\tH6',
    'X132\tx110\tx5\tx15\tx55\tX197\tx363\tx57\tx133\tx20\tx241\tx533\tx151',
    '#E B408302\tTE BH0E302',
    'H7\tM12\tM9',
    'ME BH0:302\t#3 540:302',
    'x462\tx13\tx13\t#E 8403302\t#E B40E30',
  ].join('\n'),
);
assert(noisyMultiLineLegendRows.find((item) => item.code === 'H7')?.quantity === 462, 'noisy multi-line legend should skip watermark number rows');
assert(noisyMultiLineLegendRows.find((item) => item.code === 'M12')?.quantity === 13, 'noisy multi-line legend should keep M12 quantity');
assert(noisyMultiLineLegendRows.find((item) => item.code === 'M9')?.quantity === 13, 'noisy multi-line legend should keep M9 quantity');
assert(noisyMultiLineLegendRows.length === 16, 'noisy multi-line legend should parse all real colors only');

const positionedLegend = parsePositionedOcrResult({
  text: '',
  blocks: [
    {
      text: '',
      recognizedLanguages: [],
      lines: [
        {
          text: '',
          recognizedLanguages: [],
          elements: [
            { text: 'B11', frame: { left: 10, top: 10, width: 45, height: 28 } },
            { text: 'E14', frame: { left: 90, top: 10, width: 45, height: 28 } },
            { text: 'x162', frame: { left: 9, top: 62, width: 50, height: 24 } },
            { text: 'x865', frame: { left: 88, top: 62, width: 50, height: 24 } },
          ],
        },
      ],
    },
  ],
});
assert(positionedLegend.find((item) => item.code === 'B11')?.quantity === 162, 'positioned OCR parser should pair quantity below code');
assert(positionedLegend.find((item) => item.code === 'E14')?.quantity === 865, 'positioned OCR parser should keep nearest horizontal code');

const positionedNoise = parsePositionedOcrResult({
  text: '',
  blocks: [
    {
      text: '',
      recognizedLanguages: [],
      lines: [
        {
          text: '',
          recognizedLanguages: [],
          elements: [
            { text: '7', frame: { left: 0, top: 0, width: 12, height: 16 } },
            { text: 'B11', frame: { left: 10, top: 30, width: 45, height: 28 } },
            { text: 'x162', frame: { left: 9, top: 82, width: 50, height: 24 } },
          ],
        },
      ],
    },
  ],
});
assert(positionedNoise.find((item) => item.code === 'B11')?.quantity === 162, 'positioned OCR parser should ignore standalone numeric noise');

const positionedMardNoise = parsePositionedOcrResult({
  text: '',
  blocks: [
    {
      text: '',
      recognizedLanguages: [],
      lines: [
        {
          text: '',
          recognizedLanguages: [],
          elements: [
            { text: 'MARD', frame: { left: 0, top: 0, width: 44, height: 16 } },
            { text: '89', frame: { left: 48, top: 0, width: 20, height: 16 } },
            { text: 'A9', frame: { left: 10, top: 32, width: 35, height: 24 } },
            { text: 'x12', frame: { left: 10, top: 82, width: 38, height: 22 } },
          ],
        },
      ],
    },
  ],
});
assert(positionedMardNoise.find((item) => item.code === 'A9')?.quantity === 12, 'positioned OCR parser should ignore MARD numeric noise');

console.log('domain smoke tests passed');
