# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

航坞联调台 HangarLab Studio（原名 DJI Cloud Studio）—— Electron + React 桌面调试工具，面向大疆（DJI）与草莓创新（SuperDock）机场上云 API、MQTT、设备控制、媒体流、远程日志与固件升级调试。

功能清单、操作步骤、发布流程等面向用户的说明全部在 `README.md`。**功能实现必须同步归档到 `README.md`**：新增或修改功能后，把流程、整体设计与使用方式补进 `README.md`，不要另建游离文档。

## 常用命令

```bash
npm ci                  # 按 package-lock.json 安装；Node >= 22.12.0，npm 10.8.2
npm run dev             # electron-vite dev：Vite Renderer + Electron 窗口
npm run typecheck       # tsc --noEmit；注意 npm test 不做类型检查
npm test                # vitest run：全部单元测试
npx vitest run src/main/mqtt-manager.test.ts   # 单个测试文件
npx vitest run -t "用例名片段"                  # 单个用例
npm run build           # typecheck + electron-vite build → out/
```

冒烟测试用 playwright-core 的 `_electron` 启动真实 Electron 窗口、使用临时 userData 目录，脚本内部已包含 `npm run build`：

```bash
npm run smoke:ui      # 核心页面、Tooltip、侧栏顺序、截图
npm run smoke:toast   # 通知交互
npm run smoke:logs    # 远程日志流程
npm run smoke:webdav  # 内置 HTTP WebDAV 服务端到端同步
npm run smoke:mqtt    # 连接公网 broker.emqx.io 真实收发，不属于发布门禁
```

冒烟脚本都用临时 userData 目录，并设置 `DJI_STUDIO_SKIP_LEGACY_MIGRATION=true` 跳过「DJI Cloud Studio」旧目录的数据迁移 —— 否则会把开发机上的真实配置带进测试。

`npm run release:verify`（= `npm test` + `npm run build`）是 CI 的发布门禁。

macOS 打包依赖 `vendor/zlmediakit/<arch>` 与 `vendor/ffmpeg/darwin-<arch>`，两者都在 `.gitignore` 中，需先下载源码并编译（耗时很长）：

```bash
npm run package:mac:arm64   # = release:verify + build:zlm + prepare:ffmpeg + electron-builder
npm run build:zlm -- arm64
npm run prepare:ffmpeg:mac -- arm64
```

Windows 安装包只在 GitHub Actions 生成，本地不要尝试交叉打包。

**没有 ESLint / Prettier 配置**，`npm run typecheck` 与 `npm test` 是仅有的自动检查。代码风格为 2 空格缩进、不使用分号、字符串用单引号、界面文案与注释用中文、标识符用英文，必须与周边文件保持一致。

## 架构

### 进程边界与 IPC 契约

渲染进程以 `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false` 运行，只能通过 `window.djiApi`（`src/preload/index.ts` 用 `contextBridge` 暴露）访问主进程；`will-navigate` 被拦截，`window.open` 一律拒绝并把 http(s) 链接交给系统浏览器。

新增一个能力要同时改四处：

1. `src/shared/channels.ts`：在 `IPC_CHANNELS` 加通道名（`domain:action` 格式）。
2. `src/shared/contracts.ts`：加请求/响应类型，并在 `DjiDesktopApi` 接口中声明。
3. `src/preload/index.ts`：在 `api` 对象里绑定 `ipcRenderer.invoke`；事件类用 `ipcRenderer.on` 并返回取消订阅函数。
4. `src/main/index.ts` 的 `registerIpc()`：注册 handler。

**所有 `ipcMain.handle` 入参必须先经 `src/main/ipc-validation.ts` 的 `validateXxx()` 校验**，不可信任渲染进程传来的 `unknown`。长度、条数、字节上限见 `src/shared/limits.ts`，校验失败抛 `IpcValidationError`。需要回给用户的失败用 `OperationResult`（`{ ok, error }`）返回中文文案，不要抛异常穿透 IPC。

单向推送（MQTT 运行时、固件上传进度、SEI 事件、媒体服务状态、WebDAV 同步、应用更新）由主进程 `mainWindow.webContents.send(...)` 发出，渲染侧用对应的 `onXxxEvent(listener)` 订阅。

### 渲染进程 `src/renderer/src`

- `App.tsx`（约 1600 行）是唯一状态容器：连接配置、消息记录、遥测快照、设备档案、WebDAV 状态、更新状态都在这里，通过 props 逐层下发。**没有状态库、没有 Context**；新增页面状态沿用此模式，不要引入外部状态管理。
- 顶层导航 `WorkspaceView`（`src/renderer/src/App.tsx:99`）：`overview` / `map` / `media` / `dji-config` / `oss` / `versions` / `settings`，入口在 `.app-rail`。
- `views/Overview.tsx` 是设备工作台，内部再按设备类型分页签；页签清单与可见性规则见其中的 `visibleTabs`。
- 切页签会卸载组件；需要保留内部状态的部分（如 `persistent-command-center`）用 `hidden` 常驻挂载。
- 目录约定：`views/` 页面级、`components/` 复用组件、`lib/` 纯逻辑（无 JSX，可直接单测）、`data/` 静态 JSON。
- 渲染进程状态只落 `localStorage`，键统一 `dji-cloud-studio.*`。这些键同时是 `ipc-validation.ts` 中 `ALLOWED_RENDERER_STORAGE_KEYS` 的白名单，**新增 localStorage 键必须同步加入白名单**，否则 WebDAV 备份会拒绝该快照。
- 消息记录用 `retainRecentMessages()` 截断（默认 2000 条 / 32 MiB），不要无界累积。

### 主进程 `src/main`

- 每个领域一个 Manager/Store 类，在 `app.whenReady()` 中实例化并注入事件回调；`registerIpc()` 只做「校验 → 调用服务 → 返回结果」，业务逻辑不写在 handler 里。
- Store 类（`ProfileStore`、`MediaServerStore`、`ObjectStorageStore`、`WebDavConfigStore`、`DeviceArchiveStore`）统一模式：JSON 文件存 `app.getPath('userData')`；`runExclusive()` 串行化读写；写盘用「临时文件 + `rename`」原子替换、权限 `0o600`；文档损坏时备份为 `.corrupt-*.bak` 并重建默认值。
- 凭据（MQTT 密码、媒体服务 secret、对象存储 AK/SK、WebDAV 凭据）由 `credential-crypto.ts` 用应用内固定密钥经 HKDF 派生、AES-256-GCM 加密，密文是 `dcdt.v1.<keyId>…` 信封；`stored-credential.ts` 的 `hasStoredCredential` / `resolveStoredCredential` / `migrateStoredCredential` 统一读写，并负责把历史 `safeStorage` 密文迁移过来。对外只暴露 `hasStoredXxx` 布尔值，绝不明文回给渲染进程。密钥表 `KEYRING` 支持轮换，新增 keyId 时旧密文仍要能解。
- `MqttConnectionManager` 按 profileId 维护连接，用 `generation`（随机 UUID）丢弃旧连接的迟到事件；同一 profile 的操作经 `runProfileOperation()` 排队，避免 connect/disconnect 竞态。这些不变量由 `mqtt-manager.test.ts` 覆盖。
- `before-quit` 会拦截一次，等待 WebDAV flush、MQTT 断开、本地 ZLMediaKit 停止、RTMP 中继与 SEI 会话关闭后才真正退出。

### 设备模型：DJI 与 SuperDock

`DeviceProvider = 'dji' | 'superdock'`。`provider` 缺失时由 `dockModel` 反推（`lib/superdock.ts` 的 `deviceProvider()`），拓扑发现时由 `domain === '3'` 加 `productType` 判断（`providerFromIdentity()`）。

- 两个厂商共用同一套 Cloud API Topic 与消息封装，差异集中在一处：`lib/dji.ts` 的 `DJI_COMMANDS` 是全量命令模板，`lib/superdock.ts` 用 `SUPERDOCK_SUPPORTED_COMMAND_METHODS` / `SUPERDOCK_UNSUPPORTED_COMMAND_METHODS` 白名单收敛，判断入口是 `superDockSupportsCommand()`。**兼容矩阵比命令文档更保守，两者冲突时以兼容矩阵为准**，不要为了「能发」而放宽白名单。
- SuperDock 型号 `productType` 88097–88106（`SUPERDOCK_MODELS`）；新增型号要同步型号表、字段元数据与 `docs.sb.im` 参考链接。
- 设备启用后按 `subscriptionsForDevice()` 生成默认订阅，模板见 `DJI_TOPIC_TEMPLATES`；服务指令发到 `thing/product/{gateway_sn}/services`。
- 遥测由 `mergeTelemetry()` 把 OSD 与 state 增量合并成设备级快照，缓存于 `lib/telemetry-cache.ts`。字段展示名、单位、枚举、读写权限来自 `lib/*-field-metadata.ts`（机场 / 飞行器 / Dock3 / SuperDock 四份），新增可展示字段要同时补元数据与测试。
- 错误码数据在 `data/dji-error-codes.json`（`cloudErrors` / `hmsErrors` / `commonIssues`）；`328XXX` 类回复码会按规则转成 HMS 码二次查询。

### 媒体链路

本地 ZLMediaKit 由 `MediaServerManager` 以子进程启动，二进制路径由 `media-server-path.ts` 解析：打包后取 `process.resourcesPath/zlmediakit`，开发态取 `vendor/zlmediakit/<platform-arch>`；可用性由 `media-server-probe.ts` 探测 HTTP API。默认端口见 `media-server-store.ts` 的本地 profile。

SEI 解析链（`sei-parser.ts` / `sei-parser-manager.ts`）从本地 ZLMediaKit 的 RTSP 旁路或 SecretEMS 的 SSE 接口读取码流，只解析标准 H.264/H.265 SEI 语法，**不得把未公开 payload 推断为飞行遥测字段**。渲染侧播放用 `hls.js`（HLS）与 `mpegts.js`（WebRTC）。

### 三维地图

- **影像**瓦片统一走主进程特权协议 `map-tile://tiles/<源ID>/<z>/<x>/<y>`，由 `map-tile-protocol.ts` 处理（`MAP_TILE_SCHEME`）。三种来源（在线地址模板、本地目录、MBTiles）在 `map-tile-resolver.ts` 收敛。地形不走这条协议，理由见下文地形条目。协议只解析 `new URL(request.url).pathname`（`MapTileProtocolHandler.handle`），**只校验路径、不校验 host**：`map-tile://<任意 host>/…` 解析结果相同，`MAP_TILE_HOST` 是全仓库没有读取点的常量。任何失败（路径非法、来源不存在、上游异常、本地文件缺失）一律返回不带响应体的 404，避免把磁盘绝对路径透给渲染进程。
- 渲染进程与底图凭据之间真正的不变量有两条：**影像**的已保存 API Key 从不回传渲染进程，只回传 `hasApiKey` 布尔值（`StoredMapTileSource` 与 `toPublicSource()` 都不含明文密钥字段：前者存的是 `storedApiKey` / `encryptedApiKey`，后者再把这两个字段丢弃）；**影像瓦片请求全部由主进程代发**，渲染进程不会直接请求上游影像瓦片域名。两条各有一个例外，都是地形造成的，见下文地形条目。注意渲染进程本来就持有可编辑的「URL 模板」字段，用户新填的 API Key 明文也会经 `SecretInput` 送进 `mapSourcesSave`。
- `protocol.registerSchemesAsPrivileged` **必须在 `app.whenReady()` 之前调用**（`src/main/index.ts` 顶层），否则 `protocol.handle` 注册会失败；`privileges` 里真正支撑瓦片可用的是 `standard: true` 与 `secure: true`。`supportFetchAPI: true` **不是当前取图路径的依赖** —— A/B 实测（2026-09-16，真实 Electron 窗口 + 本地瓦片目录源）：去掉该项后 Cesium 的瓦片请求仍全部返回 200、地图正常渲染，因为 `Resource.fetchImage` 在本渲染进程中走 **XHR** 路径（`fetchImage` → `_Implementations.createImage` → `loadWithXhr` → `new XMLHttpRequest()`；只有 `XMLHttpRequest` 未定义时才退回 `loadWithHttpRequest` 的 fetch 路径），而 XHR 不受该权限影响；受影响的只有 `fetch('map-tile://…')`，它会以「URL scheme "map-tile" is not supported」直接失败。保留该项是为了不把 Cesium 当前的实现细节当成协议契约，删它之前必须重跑该 A/B。调试自定义 scheme 被拦截时应当查 XHR 而不是 `fetch`。协议处理函数本身在 ready 之后才注册。
- CSP 已放行 `img-src map-tile:` 与 `connect-src map-tile:`（Cesium 的 XHR 路径与 `Image` 回退路径各需要一条），**不为用户自填的瓦片域名开口子**。`script-src` 为 `'self' 'wasm-unsafe-eval'`：Cesium 的 worker 在模块加载时即实例化内联 wasm，缺该关键字每次启动会报 5 条 pageerror。**必须是 `'wasm-unsafe-eval'` 而非 `'unsafe-eval'`** —— 前者只放开 WebAssembly 编译，后者会连带放开 JS 动态求值。渲染进程的地图视图因此用 `CesiumWidget` 而不是 `Viewer`：`Viewer` 会拉起 Cesium 自带的 knockout，其间接 `eval` 被 `script-src` 拦下后构造即抛错、整个视图白屏。
- 地形层与影像层共用 `MapTileSource`，靠 `kind` 分流；三类地形 kind（`terrain-ion` / `terrain-arcgis` / `terrain-url`）只在 `src/shared/contracts.ts` 的 `TERRAIN_SOURCE_KINDS` 里声明一次，主进程的令牌分流与渲染进程 `lib/terrain-source.ts` 的 `isTerrainKind` 都从这一份清单构造，**不得另抄一份 Set**。**地形不走 `map-tile://` 代理，由渲染进程直连上游**：地形有自己的协议路径（先取服务根的 `layer.json`，再逐瓦片协商扩展名），代理等于把这条协议与缓存键设计重做一遍；上一条的「不为用户自填的瓦片域名开口子」指没有新增按域名的 CSP 条目，而 `connect-src` 的 `http:` / `https:` 本就放行（媒体播放等既有功能依赖），地形直连因此没有扩大可达域名范围。
- `map:get-terrain-token`（`IPC_CHANNELS.mapGetTerrainToken`，`src/main/index.ts` 的 `registerIpc()`）是「已存凭据不回传渲染进程」**唯一刻意开的例外**，三个条件缺一不可：用 `handleTrusted` 注册（非受信页面直接抛错）、来源不存在或 `kind` 不在 `TERRAIN_SOURCE_KINDS` 时一律返回 `''`、只回传该来源的 `apiKey` 明文本体。开口的理由：Cesium 在渲染进程内构造地形 provider，厂商地形服务要求 token 出现在查询参数或 `Authorization` 头里，渲染进程拿不到明文就无法加载地形。影像不受影响 —— `mapSourcesList` 回给渲染进程的仍只有 `hasApiKey`。
- ion 地形有两个 Cesium 1.145 的坑，都在 `MapView.tsx` 的 `createTerrainProvider` 里处理。其一：**`CesiumTerrainProvider.fromIonAssetId(assetId, options)` 内部调用 `IonResource.fromAssetId(assetId)` 时不透传 options**，传进去的 `accessToken` 会被静默丢弃、回落到 Cesium 内置默认令牌，所以必须两步构造 —— 先 `IonResource.fromAssetId(TERRAIN_ION_ASSET_ID, { accessToken })` 再 `CesiumTerrainProvider.fromUrl(resource, …)`；同时**不得**给 `Cesium.Ion.defaultAccessToken` 赋值，避免污染全局默认值。其二：正因为 Cesium 自带一个默认令牌，「用户没填令牌」不能交给工厂方法兜底 —— `terrainProviderOptions` 对空令牌的 `terrain-ion` / `terrain-arcgis` 一律返回 `undefined`，调用方回退椭球并提示，**绝不能拿空令牌去构造**。
- 另两个构造分支：ArcGIS 走 `ArcGISTiledElevationTerrainProvider.fromUrl(TERRAIN_ARCGIS_URL, { token })`（该工厂方法确实会透传 token，token 作为查询参数附加）；自建 `terrain-url` 走 `new Resource({ url, headers })` + `CesiumTerrainProvider.fromUrl`，`headers` 由 `terrainRequestHeaders` 组装 —— 有令牌时以 `Authorization: Bearer <token>` 覆盖同名项。弹窗目前不为地形渲染请求头编辑器（`MapSourceModal` 的 `MapSourceKindFields` 只渲染地址与 API Key），所以 `headers` 实际恒为空，`Authorization` 是唯一会被真正发出的自定义头。
- `useTerrainLayer` 用 `TERRAIN_LOAD_TIMEOUT_MS`（3 秒）给 provider 构造设上限：超时先挂回椭球并提示 `地形加载失败：地形加载超时（3 秒），已回退椭球`（其余失败路径同模板，原因来自 `terrainUnavailableReason` 或异常 message）；构造若在超时之后才落地**仍然补正** —— 成功则换成该地形并清掉提示，失败则把超时文案换成真实错误。每次赋值都重新取一次 `widgetRef.current` 并受 `cancelled` 保护，控件已销毁或组件已卸载后不再触碰。这条竞态 / 迟到 / 卸载路径**没有自动化覆盖**（node 环境不执行 `useEffect`，测试只覆盖 `terrainProviderOptions` / `terrainUnavailableReason` / `terrainFailureMessage` 等纯函数与静态渲染），与下面「三维行为没有自动化覆盖」是同一个缺口，改动前请真机复核。
- 底图源的坐标系决定设备点位是否偏移：设备上报 WGS-84，高德/百度底图分别是 GCJ-02/BD-09。`lib/map-coord.ts` 只做单向转换（`wgs84ToGcj02` / `gcj02ToBd09` / `toCoordinateSystem`，按 `isInsideChina` 判定国境），境外坐标必须原样返回。**设备上报的原始 WGS-84 读数必须始终可见**，不能被转换结果掩盖。
- `MapTileSourceStore` 刻意不接入 `WebDavBackupManager`：本地路径跨机器失效，URL 模板含密钥。
- 瓦片读路径必须走内存快照入口 `getWithApiKeyForTile`，不得改回事务串行化的 `getWithApiKey` / `runExclusive`：底图源既然不参与备份，挤进全局配置事务队列换不到任何一致性，只会在 WebDAV 同步把整次上传包在同一个事务里时把取图顶住。
- Cesium 静态资源由 `scripts/prepare-cesium.mjs` 拷贝到 `src/renderer/public/cesium/`（已在 `.gitignore` 中），不引入 `vite-plugin-cesium`；`CESIUM_BASE_URL` 通过副作用模块 `lib/cesium-base-url.ts` 设置，因为 CSP 禁止内联脚本，且该 import 必须排在 `cesium` 之前。
- 地图相关逻辑必须保持可测：坐标转换、位置提取、瓦片解析、Store 都是不依赖 WebGL 的纯逻辑，`MapView` 自身也能在 node 环境用 `renderToStaticMarkup` 静态渲染（`useEffect` 不执行，不会构造 WebGL 上下文），静态渲染只覆盖标记与纯函数。**三维行为没有自动化覆盖**：相机、影像与地形切换、实体的增删改与 `requestRender` 时机只能靠真机复核 —— `smoke:ui` 只断言侧栏入口的 tooltip 与顺序，不进入地图视图。改动这些路径时不要以为有回归网。

### WebDAV 数据版本

`WebDavBackupManager` 把连接配置、设备档案、媒体服务、对象存储与渲染进程 localStorage 快照聚合成一份可移植文档，用 WebDAV 密码/Token 派生的独立密钥做 AES-256-GCM 加密后上传（`webdav-backup-crypto.ts`）。

- 本地变更 1.5s 防抖自动同步，30s 轮询远端（`AUTO_SYNC_DELAY_MS` / `REMOTE_POLL_INTERVAL_MS`）。
- 多客户端靠 WebDAV 条件锁串行提交（锁 TTL 120s，最多重试 40 次），再按记录做三方合并（`webdav-sync-merge.ts`），避免整库互相覆盖。
- 恢复前会先断开受影响的 MQTT 连接（构造时注入的 `beforeRestore`）。
- 端点凭据同样经 `credential-crypto.ts` 加密保存，与备份加密密钥（由 WebDAV 密码/Token 派生）分离，因此更换 WebDAV 凭据后旧版本无法解密。

### 测试与打包

- 测试与源码同目录，命名 `*.test.ts` / `*.test.tsx`。运行环境是 node，**没有 jsdom、没有 @testing-library**：React 组件测试用 `react-dom/server` 的 `renderToStaticMarkup`，并把需要断言的分支抽成导出的纯函数来测（参见 `views/Overview.test.tsx`、`components/Sidebar.test.ts`）。
- `package.json` 的 `build` 段通过 `extraResources` 把 `vendor/zlmediakit/<arch>` 与 `vendor/ffmpeg/<platform>-<arch>` 打进安装包，**每个安装包只携带当前平台与架构的二进制**；Electron 版本、`appId`、产物命名也在这里。
- macOS 使用 ad-hoc 签名（`identity: "-"`、`hardenedRuntime: true`、`forceCodeSigning: true`、`notarize: false`），不需要 Apple Developer 证书与公证，用户首次运行需手动放行；`build/entitlements.mac.plist` 必须保留 `com.apple.security.cs.disable-library-validation`，否则加载不了随包签名的 Electron 框架。CI 在上传产物前会跑 `codesign --verify` 校验，并实际启动应用确认可用。
- `src/main/app-update-manager.ts` 通过 GitHub Releases API 检查更新（启动 5s 后静默检查一次，并做 check/download 去重）；API 返回 403/429 时回退到公开 Release 地址搭配 `SHA256SUMS.txt`，无需配置 Token。按 `process.platform` + `arch` 挑选安装包，下载后必须校验 SHA-256 才允许打开安装包。
- 推送 `v1.0.1` / `v1.0.1-beta.1` 形式的 tag 触发 `.github/workflows/release.yml`（Ubuntu 验证 → macOS/Windows 并行打包 → 生成校验和 → 发布 Release）；`cache-zlmediakit.yml` 通过默认分支推送、每周 cron 和手动触发预热 ZLMediaKit 编译缓存。

## 约定

- 渲染进程不得绕过 `window.djiApi` 直接使用 Node/Electron API；主进程不得信任未校验的 IPC 入参。
- 新增或修改功能后同步更新 `README.md`（功能清单与使用步骤）。
- 提交时不要带上自动生成的设计文档、任务规划或 Skill 缓存文件。
