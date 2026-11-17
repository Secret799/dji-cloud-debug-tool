# 仓库工作规则

## 仓库级别

**B 级：独立服务 / 应用。** 本仓库只有一条产品线，通过 GitHub Release 发布，发布版本以 `v1.1.3` 这类附注 Tag 标记。

- 长期分支只有 `main`；短期分支用 `feature/*`、`fix/*`、`chore/*`，从 `main` 拉出，合并后删除。
- `main` 不直接推送，改动走 PR 合入；合入后在 `main` 上打 `vX.Y.Z` 附注 Tag。
- Tag 推送后不删除、不移动、不重建；发布失败时升版本号重新发布。

## 提交语言与格式

中文，格式 `type(scope): subject`，subject 不超过 50 个字符，一事一提交。

```text
feat(media): 预览支持 HLS 与 WebRTC 切换
fix(telemetry): 修正离线快照的最后上报时间
chore(git): 补齐仓库级别声明与 Git 基础配置
```

## 常用命令

```bash
npm ci                 # 按 package-lock.json 安装；Node >= 24.0.0
npm run dev            # electron-vite dev
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run build          # typecheck + electron-vite build
npm run release:verify # npm test + npm run build（发布门禁）
npm run smoke:ui       # Electron 冒烟（需要先构建）
```

仓库与 CI 使用 Node 24。Node 20 / 22.12 缺少可用的 `node:sqlite`，三个 main 套件会失败；本地开发请 `nvm use 24`。

## 禁止改动的目录与文件

- `vendor/zlmediakit/`、`vendor/ffmpeg/`：本地编译的二进制，不入库。
- `out/`、`release/`、`src/renderer/public/cesium/`：构建产物，由脚本生成。
- `node_modules/`、`.idea/`：依赖与 IDE 本地文件。
- `.superpowers/`、`.tmp/`：任务过程文件与临时文件。
- 任何密钥、证书私钥、真实账号与 Token；提交前检查 `.env` 是否被误加入。

## 开发约定

- 进程边界、IPC 契约、目录约定与测试方式的完整说明见 [CLAUDE.md](CLAUDE.md)。
- 功能新增或修改后同步更新 [README.md](README.md) 的功能清单与使用步骤。
- 提交时不要带上自动生成的设计文档、任务规划或 Skill 缓存文件。