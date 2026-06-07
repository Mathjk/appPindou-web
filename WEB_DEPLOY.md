# appPindou Web 发布版

这是从原生 app 工程拆出的网页发布版，可独立构建并发布到 GitHub Pages。

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
http://<computer-lan-ip>:8082
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

- 网页版数据默认保存在当前浏览器本地；登录账号后可以同步到 Supabase 云端快照。
- 换手机、清浏览器数据、换浏览器前，可以先登录并上传本机数据，也建议额外在设置里导出备份。
- Supabase 前端只使用 Project URL 和 publishable key。不要把 `service_role` 或 `sb_secret_...` 放到 GitHub Pages。
- 首次启用账号同步前，需要在 Supabase SQL Editor 执行 `supabase/app_pindou_account_schema.sql`，并关闭 Auth 邮箱确认。
- 上传图片、裁剪、OCR 都在网页端流程里完成。
- OCR.space 调用需要网络；如果免费测试 key 不稳定，可以在设置里换成自己的 OCR API Key。
