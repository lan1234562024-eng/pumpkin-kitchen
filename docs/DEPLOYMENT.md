# 发布网页试玩

网页试玩使用同一套游戏规则和规则演示队友，在浏览器内独立运行；无需公开后端，也不接收模型 API 密钥。

## GitHub Pages

1. 将此目录的代码与 public 素材放入一个独立仓库，默认分支使用 main。不要上传 node_modules、私人配置或旧开发历史。
2. 在仓库 Settings → Pages → Build and deployment 中，将 Source 选择为 GitHub Actions。
3. 推送 main，或在 Actions 手动运行 Build and publish web demo。随包工作流执行 npm ci、测试和 npm run build:demo，然后发布 dist。
4. 工作流成功后，从部署结果取得真实网址。打开后应先停在大厅，清楚显示“演示队友（规则驱动，非真实模型）”。
5. 实际检查开始一局、移动、互动、接管与重开，确认图片、Worker 和 AI 接入指南都能加载，再把该网址填入参赛页。

构建使用相对资源路径，可放在仓库子路径。工作流会把仓库地址注入页面；网页试玩与完整本地版属于不同实例。

## 本地检查网页模式

```sh
npm ci
npm run dev:demo
```

检查最终静态产物：

```sh
npm run build:demo
npm run preview:demo
```

终端会显示预览地址。预览命令仅用于本地检查。dist 是网页产物；npm run build 生成的 dist-local 是完整本地模式前端，仍需要本地后端，不能拿它代替网页试玩产物。

## 官方参考

- https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- https://vite.dev/guide/static-deploy.html#github-pages

仓库与网页公开发布是独立操作；代码中包含工作流不代表已经上线。
