# DJI Cloud Studio

一款面向 macOS 的大疆上云 API 与 MQTT 调试工具。项目参考了
[Dji-cloud-api-tool](https://github.com/damon-liu/Dji-cloud-api-tool) 的设备与控制工作流，以及
[MQTTX](https://github.com/emqx/MQTTX) 的连接配置、消息检查和发布交互。

> 本项目不是 DJI 官方产品。飞行、机场和负载指令会直接发送到配置的 Broker；连接真实设备前请先在隔离环境验证 Topic、参数和权限。

## 已实现功能

- 原生 Electron 桌面窗口，提供 Apple Silicon (`arm64`) 与 Intel (`x64`) 的独立 DMG / ZIP 打包命令。
- 多连接 Profile，支持 `mqtt`、`mqtts`、`ws`、`wss` 与 MQTT 3.1.1 / 5.0。
- 用户名密码、Clean Session、Keep Alive、自动重连、CA/客户端证书/私钥。
- 密码通过 Electron `safeStorage` 使用 macOS 系统能力加密，Renderer 不读取已保存明文。
- 连接侧栏、设备树与设备启停、按上级设备分组的 Topic 订阅、自定义订阅和 QoS 0/1/2。
- MQTT 消息流、方向/关键字筛选、JSON 检查、发布器、Retain 与 NDJSON 抓包导出。
- 机场、飞机与 Pilot 设备管理；添加设备时生成 DJI 常用 Topic。
- OSD / state 增量字段合并，支持 `update_topo` 网关拓扑和 `sub_device` 子飞机发现。
- 根据 `domain/type/sub_type` 识别 Dock 1/2/3、飞行器和遥控器型号；拓扑中的密钥和 nonce 不进入设备聚合数据。
- Dock 2 的 144 项设备属性按 DJI 文档显示中文名称、枚举含义和单位；字段旁详情图标可查看类型、约束、读写权限、上报模式与官方描述。
- 遥测中的 Dock 2、Dock 3 与飞机可读写属性可直接通过 `property/set` 设置，并关联 `property/set_reply` 结果；遥测项管理可查看官方权限、类型、约束和来源，也可为自定义字段配置安全关闭的属性设置能力。
- 机场、飞行、负载、PSDK 喊话器和直播控制模板，Payload 发送前可编辑。
- 内置 ZLMediaKit，可由用户按需启动或停止；本地服务提供 RTMP 推流、RTSP、HLS、HTTP API 和 RTP Proxy/GB28181 能力。
- 媒体中心可保存多个远程 ZLMediaKit / SRS / SecretEMS 服务：ZLMediaKit 和 SRS 按应用名、流 ID 生成 RTMP、RTSP、WebRTC 与 HLS 地址；SecretEMS 则生成 RTMP 推流地址，并按其标准网关规范生成 WHIP 推流和 WHEP 播放地址。
- HLS.js 直接预览所选媒体服务中的 HLS 流；API Secret 通过 Electron `safeStorage` 加密，Renderer 不读取已保存明文。
- `services` / `services_reply` 按 `tid` 自动关联，展示成功、失败和 10 秒超时。
- 错误码管理整合 551 条上云错误码、92 条机场 HMS 告警和 26 条常见问题，支持按错误码、现象、原因、处理措施和物料搜索。
- 设备 `services_reply` 返回非零 `result` 时，自动关联错误说明、可能原因、建议日志和处理措施；HMS 同时支持十六进制与十进制错误码查询。
- 危险指令二次确认，断开连接时禁用发布和控制按钮。

## 错误码数据

程序使用的结构化数据位于 `src/renderer/src/data/dji-error-codes.json`，从 `DJI上云常见问题汇总.xlsx` 的“上云错误码”、“机场HMS告警”和“上云常见问题解决”三个工作表提取。源工作簿注明数据来自 DJI 官方论坛、交流群等公开渠道。

上云错误码的首位表示上报来源；对 `328XXX` 类回复码，程序会按源工作簿规则减去 `328000`，再将差值转为十六进制 HMS 错误码进行二次查询。

## 开发运行

环境要求：macOS、Node.js `22.12+`，npm `10.8.2`。

```bash
npm ci
npm run dev
```

`npm run dev` 会启动 Vite Renderer 和 Electron 桌面窗口。

## 测试与构建

```bash
npm test             # DJI Topic、遥测合并和响应关联单元测试
npm run typecheck    # TypeScript 检查
npm run build        # Electron 生产构建
npm run smoke:ui     # 在 1024x680 启动真实窗口并检查核心页面与内部溢出
npm run smoke:mqtt   # 手工公网集成测试：通过 broker.emqx.io 做订阅/发布回环
npm run build:zlm    # 为当前 Mac 架构重建内置 ZLMediaKit
npm run package:mac  # 先执行单测与构建，再生成 arm64 DMG 与 ZIP
npm run package:mac:arm64
npm run package:mac:x64
```

`npm run build` 的生产文件位于 `out/`；`package:mac*` 的安装包和解包应用位于 `release/`。公网 MQTT smoke 会真实发布消息，不属于默认发布门禁。

打包完成后可直接对解包应用执行 UI smoke：

```bash
DJI_STUDIO_EXECUTABLE="release/mac-arm64/DJI Cloud Studio.app/Contents/MacOS/DJI Cloud Studio" node scripts/electron-smoke.mjs
```

`x64` 构建时将环境变量改为 `release/` 下实际生成的 Intel 应用可执行文件。

## 媒体服务

应用随安装包提供 ZLMediaKit `fdaec260` 的 `arm64` 和 `x64` 原生二进制。媒体中心始终显示一个不可删除的“本地 ZLMediaKit”配置，但是否启动完全由用户决定；应用退出时会停止由本应用启动的子进程。

本地默认端口为 HTTP/API `9090`、RTMP `1935`、RTSP `8554`，均可在媒体服务设置中修改。界面中的推流地址使用检测到的局域网 IPv4，方便 DJI 设备访问；应用自身的健康检查固定访问 `127.0.0.1`。远程服务可选择 ZLMediaKit、SRS 或 SecretEMS。SecretEMS 默认使用 RTMP `1935` 接收 DJI 推流、HTTPS `443` 提供 WHIP/WHEP 信令，并使用 `8000/tcp+udp` 传输 WebRTC 媒体；该类型不生成 RTSP 或 HLS 地址。目标 SecretEMS 部署需要开启 RTMP listener 并放行对应端口。

为了缩小桌面安装包及避免额外动态库依赖，内置 ZLMediaKit 关闭了 OpenSSL、WebRTC、SRT 和 FFmpeg，保留 RTMP、RTSP、HLS、HTTP API、MP4 与 RTP Proxy。相机页遵循 `RTMP 推流 -> RTMP 播放`、`WHIP 推流 -> WHEP 播放`：RTMP 内置播放由 Electron 主进程调用本机 FFmpeg 无转码转封装，需确保 `ffmpeg` 位于 `PATH`，或通过 `FFMPEG_PATH` 指定可执行文件；WHIP/WHEP 则依赖远程媒体服务的 WebRTC 能力。需要 WebRTC、HTTPS 或 SRT 时，应连接启用了对应功能的远程 ZLMediaKit/SRS，或调整构建脚本后自行编译：

```bash
npm run build:zlm -- arm64
npm run build:zlm -- x64
```

## 工具链兼容性

当前工具链采用 Electron `44.0.0`、electron-builder `26.15.3`、electron-vite `5.0.0`、Vite `7.3.6`、plugin-react `5.2.0`、Vitest `4.1.11`、Playwright core `1.62.1` 与 MQTT.js `5.15.2`。Electron 44 以及 electron-builder 的当前传递依赖要求 Node `22.12+`，因此项目不再声明 Node 20 支持。electron-vite 5 的 peer 范围只接受 Vite 5-7，而 plugin-react 6.1.0 只接受 Vite 8；为保持无 `--force` 的有效 peer 依赖树，Vite 与 plugin-react 使用各自兼容版本。

## 快速使用

1. 打开右上角连接设置，填写 Broker、认证信息和 TLS 证书。
2. 从左侧设备区添加机场或飞机；选择对应的 DJI Dock 2/3 机场型号后，设备常用 Topic 会自动写入订阅列表。
3. 点击右上角“连接”，启用设备下已开启的订阅会在连接成功或重连后恢复。
4. 在设备工作台查看 OSD/state 聚合结果，在 MQTT 消息页检查原始报文。
5. 在控制中心选择网关和指令，核对可编辑 JSON 后发送并等待响应。
6. 在媒体中心按需启动内置 ZLMediaKit，或添加远程 ZLMediaKit/SRS；复制生成的 RTMP 地址给 DJI 直播配置，并用 HLS 地址预览。

机场默认 Topic 包含：

```text
sys/product/{sn}/status
thing/product/{sn}/osd
thing/product/{sn}/state
thing/product/{sn}/services_reply
thing/product/{sn}/events
thing/product/{sn}/requests
thing/product/{sn}/property/set_reply
thing/product/{sn}/drc/up
```

服务指令发送到 `thing/product/{gateway_sn}/services`，消息格式为：

```json
{
  "tid": "uuid",
  "bid": "uuid",
  "timestamp": 1598411295123,
  "method": "cover_open",
  "data": {}
}
```

## 架构

```text
Renderer (React)
  -> 类型化 preload API
    -> Electron Main IPC
      -> 多会话 MQTT Manager (MQTT.js)
      -> 加密 Profile Store (safeStorage)
      -> 本地 ZLMediaKit 进程管理与远程 ZLM/SRS 探活
      -> 证书选择与 NDJSON 导出
```

MQTT Client、TLS 文件读取和凭据处理均位于 Main 进程。Renderer 只维护界面状态、设备遥测快照和消息视图，不暴露 Node.js API。

## 界面主题

Renderer 全局使用「白色主色调 + 橙色副色调」主题，设计令牌集中定义在 `src/renderer/src/styles.css` 顶部的 `:root` 中：

- **表面分层**：`--bg`（暖白页面底）→ `--surface`（纯白卡片）→ `--surface-soft` / `--fill`（嵌入与 hover）→ `--code-bg`（JSON / 日志内容区）；`--rail` 为深色顶栏与左侧工具栏，形成锚定对比。
- **文字层级**：`--text` → `--text-soft` → `--muted` → `--muted-2`（暖灰系），代码内容统一 `--code-text`。
- **副色橙**：`--accent`（`#f56a00`）用于激活 Tab、选中态、CTA 按钮与聚焦环；`--accent-soft` 为浅橙 tint 底。选中态、徽章 tint 一律通过 `var()` 或 `color-mix()` 派生。
- **状态色**：在线 / 成功保持 `--green`；警示 `--amber`、错误 `--red`、信息 `--blue` 及对应 `*-soft`。语义约定：橙 = 交互激活，绿 = 在线与成功。
- **原生控件**：`:root` 声明 `color-scheme: light`，select / checkbox / 弹出菜单自动跟随浅色；滚动条通过 `::-webkit-scrollbar` 自定义为细圆角样式。

### 遥测数据展示

设备工作台「遥测」Tab 的字段采用键值行表形式：左侧灰色 label、右侧等宽数字右对齐（`tabular-nums`），字段路径与 OSD/STATE 徽章弱化为行内次级小字，hover 整行高亮。

数组字段渲染为独立的「数组卡片」：左侧 3px 橙色竖线 + 浅橙 tint 底 + 「数组」徽章，与普通字段的白底行表一眼区分；数组项头部带等宽 `[N]` 索引徽章，可折叠，展开后字段行缩进并带弱化竖线表明归属。

调整配色时只改 `:root` 令牌即可全局生效；新增组件样式应引用令牌而非硬编码颜色。

## 当前边界

- 内置 ZLMediaKit 不包含 WebRTC、TLS、SRT 和 FFmpeg；这些协议或转码能力需要使用远程媒体服务。Renderer 仅直接播放 HLS，RTMP/RTSP 地址用于设备推流或外部播放器。
- DJI Cloud API 与固件版本可能存在字段差异，所有控制 Payload 都应以现场使用的官方文档为准。
- Dock 2 字段元数据对应 DJI 上云 API 文档 `2026-01-28` 版本；官方物模型更新后应同步更新 `dji-field-metadata.ts`。
- 当前消息缓存每个连接保留最近 2,000 条；长时间记录应定期导出 NDJSON。
- 未配置 Apple Developer ID 时，本地安装包不会获得可分发签名，`hardenedRuntime` 也不能替代签名。Gatekeeper 会阻止普通安装流程；对外分发前必须完成 Developer ID 签名、notarization/stapling，并使用 `codesign` 与 `spctl` 验证产物。
