# appPindou Web 发布版

这是从原生 app 工程复制出来的网页发布版。原始工程保留在 `/home/jk/appPindou`，本目录为 `/home/jk/appPindou-web`。

## 本地网页测试

```bash
npm ci
npm run web:dev
```

默认地址：

```text
http://localhost:8082
```

手机访问本机网页时，需要让手机和电脑在同一个局域网，然后用电脑局域网 IP 访问，例如：

```text
http://192.168.1.23:8082
```

如果只用 `localhost`，手机会把它理解为手机自己，不会访问到电脑。

## 静态构建

本地按根路径构建：

```bash
npm run build:web:local
```

构建结果在 `dist/`。

发布到 GitHub Pages 项目站点时，路径通常是 `https://用户名.github.io/仓库名/`，需要带仓库名前缀：

```bash
PUBLIC_URL=/仓库名/ npm run build:web
```

如果发布到 `https://用户名.github.io/` 这种用户站点：

```bash
PUBLIC_URL=/ npm run build:web
```

## GitHub Pages 自动发布

本目录已经包含 `.github/workflows/pages.yml`。

推到 GitHub 后：

1. 打开仓库 Settings。
2. 进入 Pages。
3. Source 选择 GitHub Actions。
4. 推送到 `main` 分支后自动构建并部署。

工作流会自动判断 `PUBLIC_URL`：

- 普通项目仓库：`/仓库名/`
- `用户名.github.io` 用户站点：`/`

## 数据和 OCR 注意事项

- 网页版数据保存在当前浏览器本地，不会自动同步到另一台手机或电脑。
- 换手机、清浏览器数据、换浏览器前，请先在设置里导出备份。
- 上传图片、裁剪、OCR 都在网页端流程里完成。
- OCR.space 调用需要网络；如果免费测试 key 不稳定，可以在设置里换成自己的 OCR API Key。
