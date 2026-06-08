# MARD 豆仓 Web

MARD 豆仓是一个用于管理 MARD 291 拼豆库存、图纸用量和采购清单的本地优先应用。当前仓库是网页发布版，基于 Expo / React Native / React Native Web 开发，并通过 GitHub Pages 发布。

部署到 GitHub Pages 后，可通过仓库对应的 Pages 地址访问。

## 当前定位

- 先以网页端作为主要可测试版本，方便在电脑和手机浏览器里快速验证功能。
- 数据默认只保存在当前浏览器本地；登录账号后可以把个人数据同步到 Supabase 云端快照。
- 代码仍然保持 React Native 结构，大部分界面和业务逻辑可以复用于 Android / iOS App。
- OCR 先走远程接口，默认使用 OCR.space 测试 Key；后续可以切换为更稳定的 OCR 或视觉模型接口。

## 核心功能

### 豆仓

- 内置 MARD 291 色表，包含 A/B/C/D/E/F/G/H/M/P/Q/R/T/Y/ZG 色系。
- 色号自然排序，并支持按色系筛选。
- 支持按色号、中文色名、英文色名搜索；搜索不区分大小写。
- 豆仓顶部操作区和搜索区在移动尺寸下固定，方便一边滑动色表一边操作选中颜色。
- 支持按颗数增加、按颗数减少、按份增加、按份减少。
- 豆仓按份操作的每份颗数可在豆仓界面即时修改，默认 1000。
- 支持给选中颜色设置盘点值。
- 支持把当前颜色加入指定采购表。
- 低库存阈值可配置，用于提示库存不足。

### 图纸

- 支持新建、删除多个图纸项目。
- 图纸项目默认是规划状态，不会自动扣减豆仓。
- 支持手动录入和编辑图纸用量。
- 上传图纸后会自动弹出裁剪界面，只保留色号和数量区域。
- 裁剪框支持拖动、四角缩放，以及按钮微调。
- 确认裁剪后会自动调用 OCR，并把识别结果写入图纸用量草稿。
- OCR 结果进入可编辑列表，正式使用前可以人工校正。
- 支持查看单个图纸与当前库存的对比，包括需求、库存、缺口和采购份数。
- 支持一键扣库存，但需要先进入扣库存确认界面；只有确认实际开始制作时才应扣除。
- 同一图纸扣除后会记录状态，减少误重复扣除的风险。

### OCR

默认 OCR 流程：

1. 上传图纸图片。
2. 手动裁剪到色号和数量区域。
3. 对裁剪图加白底和留边，降低超宽图片被接口压缩后识别变差的概率。
4. 调用 OCR.space 识别文本。
5. 使用本地解析器整理 MARD 色号和数量。
6. 如果设置了 OpenAI-compatible 文本模型接口，可再用文本模型辅助整理 OCR 原文。

当前本地解析器已覆盖：

- 同一行格式，例如 `G2 x12`。
- 色号在上一行、数量在下一行的图例格式。
- 多行图例格式，例如第一行是一组色号、第二行是一组数量，后面再出现第二组色号和数量。
- OCR.space 夹入水印、页脚或无关数字时，优先匹配带 `x` 的真实数量行，避免把噪声数字当作豆数。
- 色号规范化，例如 `G02` 会转换为 `G2`。

默认 OCR 设置：

```text
OCR Endpoint: https://api.ocr.space/parse/image
OCR API Key: helloworld
OCR 引擎/模型: ocr.space-engine2
文本整理 Endpoint: https://api.deepseek.com/chat/completions
文本整理模型: deepseek-v4-flash
```

`helloworld` 是 OCR.space 的公开测试 Key，只适合验证流程；长期使用建议在设置里填写自己的 OCR API Key。

### 采购

- 支持多个采购表。
- 每个采购表可单独设置每份颗数。
- 支持手动加入、编辑、删除采购项。
- 支持从选中的多个图纸缺口一键加入当前采购表。
- 支持查看选中图纸的合计需求与当前豆仓库存对比。
- 支持一键复制采购清单。

采购清单复制格式：

```text
G2×1
G3×1
G4×1
G7×1
G9×1
```

其中 `×1` 表示需要购买的份数，按下面规则计算：

```text
份数 = ceil(缺口颗数 / 当前采购表每份颗数)
```

### 设置

- OCR API、Endpoint、模型名可在设置中编辑。
- 文本整理模型可以单独开启或关闭，并与 OCR 模型分别保存服务商 API Key。
- 支持用户名/密码账号登录，并把本机数据上传到 Supabase 或从云端恢复。
- 支持复制备份 JSON。
- 支持导出备份文件。
- 支持从剪贴板导入备份。
- 导出的备份会清空 API Key 字段，避免误分享密钥。
- 支持历史操作列表。
- 可以撤销某一条历史操作。
- 可以回退到某一条历史操作之前的状态。
- 支持清空本地数据，并带 3 秒倒计时确认，降低误触风险。

## 数据说明

- 网页端数据保存在浏览器本地存储中，由 `@react-native-async-storage/async-storage` 在 Web 上映射到 `localStorage`。
- 换设备、换浏览器、清除浏览器数据前，可以登录账号同步，也建议额外导出一份备份。
- Supabase 云端同步采用每个用户一份最新快照。第一次登录发现云端已有快照时，不会自动覆盖本机；需要手动选择“上传本机数据”或“从云端恢复”。
- 上传图纸、裁剪图和 OCR 预览图只保留在当前运行会话中；为了避免浏览器本地存储超过容量限制，图片数据不会长期写入备份和持久化存储。
- 图纸用量、OCR 识别出的色号数量、豆仓库存、采购表、设置和历史操作会保存。
- OCR 和文本模型 API Key 会随本机/云端应用快照保存。Supabase 表已用 RLS 限制为本人可读写；如果不想上传这些密钥，请先在设置里清空后再上传云端。
- 备份格式是结构化 JSON，库存会按色号排序，方便以后迁移。
- 色卡 HEX 只用于屏幕近似展示，库存、图纸和采购逻辑都以 MARD 色号为准。

## Supabase 账号同步设置

前端需要 Supabase Project URL 和 publishable key 初始化客户端。publishable key 设计上可以出现在网页源码、移动端包和 GitHub Pages 这类公开环境里；安全性依赖 Supabase Auth 和 RLS。当前部署值在 `src/account.ts` 中配置。

不要把 `service_role`、`sb_secret_...`、数据库密码或其他后端密钥放进前端、README 或 GitHub Pages。

Supabase 项目需要先完成：

1. Project Settings / Data API：启用 Data API，不启用 Automatically expose new tables，启用 automatic RLS。
2. Authentication / Sign In：关闭邮箱确认。当前用户名登录内部使用不可收信邮箱映射，如果开启邮箱确认会无法完成注册登录。
3. SQL Editor 执行 [`supabase/app_pindou_account_schema.sql`](supabase/app_pindou_account_schema.sql)。

账号系统使用两张表：

- `profiles`：保存登录用户名和可选找回邮箱。
- `app_snapshots`：保存当前用户的一份最新应用快照。

两张表都开启 RLS，并只授权 `authenticated` 用户访问自己的行。

## 本地运行

安装依赖：

```bash
npm ci
```

启动网页开发服务器：

```bash
npm run web:dev
```

默认地址：

```text
http://localhost:8082
```

手机浏览器访问本机网页时，手机和电脑需要在同一个局域网，然后用电脑局域网 IP 访问，例如：

```text
http://<computer-lan-ip>:8082
```

如果手机和电脑不在同一个 Wi-Fi，可以使用 GitHub Pages 线上地址，或另外配置公网隧道。

## 测试

常用验证命令：

```bash
npm run typecheck
npm run test:domain
npm run test:web
npm run test:crop
npm run test:ocr-image
npm run test:ocr-storage
npm run test:ocr-multiline
```

测试覆盖重点：

- `typecheck`：TypeScript 类型检查。
- `test:domain`：库存、图纸、采购、历史撤销、OCR 文本解析等领域逻辑。
- `test:web`：网页基础交互和本地存储冒烟测试。
- `test:crop`：裁剪框拖动、缩放和确认流程。
- `test:ocr-image`：上传、裁剪、图片预处理、OCR 请求链路。
- `test:ocr-storage`：OCR 后保存数据时不会把大体积图片写入本地存储。
- `test:ocr-multiline`：多行图例 OCR 解析，覆盖 `pdpng4.png` 这类两行颜色图例和 OCR 噪声。

如果要对线上 GitHub Pages 版本跑同一批测试：

```bash
BASE_URL=https://<user>.github.io/<repo>/ npm run test:web
BASE_URL=https://<user>.github.io/<repo>/ npm run test:crop
BASE_URL=https://<user>.github.io/<repo>/ npm run test:ocr-image
BASE_URL=https://<user>.github.io/<repo>/ npm run test:ocr-storage
BASE_URL=https://<user>.github.io/<repo>/ npm run test:ocr-multiline
```

部分 OCR 测试需要样例图片。可以通过 `CROP_TEST_IMAGE`、`OCR_PIPELINE_TEST_IMAGE`、`OCR_STORAGE_TEST_IMAGE`、`OCR_MULTILINE_TEST_IMAGE` 指定图片路径；也可以把样例图片放到仓库内 `test-fixtures/` 或 `temp/` 目录。

## 构建和发布

本地按根路径构建：

```bash
npm run build:web:local
```

GitHub Pages 项目站点构建需要仓库名前缀：

```bash
PUBLIC_URL=/<repo>/ npm run build:web
```

构建结果在：

```text
dist/
```

当前仓库已配置 GitHub Actions Pages 工作流。推送到 `main` 后会自动构建并部署。

部署状态可用 GitHub CLI 查看：

```bash
gh run list --limit 5
gh run watch <run-id> --exit-status
```

更通用的 GitHub Pages 发布流程见：

```text
WEB_DEPLOY.md
```

## 目录结构

```text
App.tsx                 主界面和交互入口
src/data/mard291.ts     MARD 291 色表和色号规范化
src/data/mardNames.ts   MARD 色名映射
src/domain.ts           库存、图纸、采购、历史撤销等业务逻辑
src/ocr.ts              OCR 调用、文本整理和解析
src/storage.ts          本地保存、备份导入导出
src/types.ts            核心类型定义
scripts/                Playwright 和领域测试脚本
WEB_DEPLOY.md           GitHub Pages 部署流程说明
```
