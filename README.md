# MARD 豆仓

本项目是一个 Expo / React Native 手机 App，用来本地管理 MARD 291 拼豆库存、图纸用量规划和采购清单。

## 当前功能

- 内置 MARD 291 色表，按 A/B/C/D/E/F/G/H/M/P/Q/R/T/Y/ZG 自然排序。
- 豆仓库存本地保存，支持按颗入库、按份入库、使用扣减和盘点覆盖。
- 每份豆数可配置，默认 1000 颗。
- 图纸项目默认只做规划，不会自动扣库存。
- 图纸用量草稿可手动编辑，并可上传图纸图片作为附件。
- 多个图纸可合并统计总需求和缺口。
- 采购清单可一键复制，格式为 `G2×1`，份数按 `ceil(缺口 / 每份豆数)` 计算。
- 一键扣库存需要用户确认；同一项目再次扣除会提示防误操作。
- 预留 OCR 接口：当前版本会保存图片并返回占位提示，识别结果后续接入。
- 支持复制 JSON 备份和从剪贴板导入备份。

## 运行

```bash
npm install
npm run start
```

## 浏览器测试

开发时可以先跑 Web 版，不用反复安装 APK 到手机：

```bash
npm run web:dev
```

然后打开：

```text
http://localhost:8082
```

Web 版适合测试库存、图纸用量、采购清单、设置和本地保存这类核心逻辑。图片选择和后续 OCR 仍需要在手机端再做一次真机确认。

如果 Web server 已经在 `8082` 运行，可以执行自动冒烟测试：

```bash
npm run test:web
```

Android 本机调试时，如果 `adb` 不在 PATH，本机当前可临时这样运行：

```bash
export PATH=/home/jk/android-sdk/platform-tools:$PATH
npm run android
```

## 验证

```bash
npm run typecheck
npm run test:domain
npx expo export --platform android --output-dir dist-test
```

`dist-test` 是临时打包产物，可以删除。

## 生成 Android APK

本机当前需要使用完整 JDK 17，而不是系统默认的 Java 21 runtime：

```bash
npx expo prebuild --platform android --clean
cd android
JAVA_HOME=/home/jk/.gradle/jdks/eclipse_adoptium-17-amd64-linux.2 \
ANDROID_HOME=/home/jk/android-sdk \
ANDROID_SDK_ROOT=/home/jk/android-sdk \
PATH=/home/jk/android-sdk/platform-tools:$JAVA_HOME/bin:$PATH \
./gradlew :app:assembleDebug
```

构建成功后，APK 原始路径是：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

当前已复制一份到更容易找到的位置：

```text
builds/appPindou-debug.apk
```

如果 Android 手机已开启 USB 调试并连接到这台机器，可以直接安装：

```bash
PATH=/home/jk/android-sdk/platform-tools:$PATH adb install -r builds/appPindou-debug.apk
```

## 数据说明

色表 HEX 来自公开 MARD 291 色卡页面，只作为屏幕色块近似展示。库存、图纸统计和采购清单都只依赖 MARD 色号。
