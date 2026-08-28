# DJI Cloud Studio

DJI Cloud Studio 是一款面向 macOS 和 Windows 的 DJI 上云 API、MQTT、设备控制与媒体流调试工具。

> 本项目不是 DJI 官方产品。飞行、机场、负载和固件升级指令会直接发送到配置的 Broker。连接真实设备前，请先在隔离环境验证 Topic、Payload、设备 SN 和账号权限。

## 功能清单

### MQTT 连接与消息

- 保存多个连接配置，支持 `mqtt`、`mqtts`、`ws` 和 `wss`。
- 支持 MQTT 3.1.1 / 5.0、QoS 0/1/2、Clean Session、Keep Alive 和自动重连。
- 支持用户名密码、CA 证书、客户端证书和私钥。
- 连接配置中的密码通过 Electron `safeStorage` 加密保存。
- 支持按设备管理订阅、自定义 Topic、消息发布、Retain 与 NDJSON 导出。
- 消息列表可按方向、Topic 和关键字筛选，并检查 JSON Payload。

### DJI 设备与遥测

- 管理机场、飞行器和 Pilot 设备，添加设备时自动生成常用 DJI Topic。
- 处理 `update_topo` 网关拓扑和 `sub_device` 子设备发现。
- 根据 `domain/type/sub_type` 识别 Dock 1/2/3、飞行器和遥控器型号。
- 合并 OSD 和 state 增量上报，保留设备最新遥测快照。
- 展示 Dock 2 官方字段名称、枚举、单位、约束、读写权限和上报模式。
- 可在遥测页通过 `property/set` 修改可写属性，并关联 `property/set_reply` 结果。
- 遥测项管理支持调整设备页签、字段顺序、字段说明和自定义属性设置规则。

### 设备控制与回执

- 内置机场、飞行、负载、PSDK 喊话器和直播控制模板。
- 发送前可编辑 JSON Payload，危险指令需要二次确认。
- `services` 与 `services_reply` 按 `tid` 自动关联，展示成功、失败和超时状态。
- 设备断开时自动禁用发布和控制操作。

### 固件、日志与对象存储

- 管理阿里云 OSS、Amazon S3 和 MinIO 配置。
- Access Key、Secret Key 和 Session Token 由主进程通过 `safeStorage` 加密保存。
- 固件升级工作台可选择本地固件包，上传到指定对象存储，并自动计算 MD5 和文件大小。
- 核对目标设备、版本、下载 URL 和文件信息后发送 `ota_create`。
- 处理 `ota_progress` 升级进度，并自动发送 `events_reply`。
- 远程日志中心可查询机场/飞行器日志、选择文件、上传到 OSS/S3/MinIO、查看进度或取消任务。

### 媒体服务

- macOS `arm64/x64` 和 Windows `arm64/x64` 安装包均内置对应平台与架构的 ZLMediaKit。
- 本地服务提供 RTMP、RTSP、HLS、HTTP API 和 RTP Proxy/GB28181 能力。
- 可保存多个远程 ZLMediaKit、SRS 或 SecretEMS 服务。
- 根据应用名和流 ID 生成 RTMP、RTSP、HLS、WHIP 和 WHEP 地址。
- 支持使用 HLS.js 直接预览 HLS 流。

### 错误码与诊断

- 内置 551 条上云错误码、92 条机场 HMS 告警和 26 条常见问题。
- 可按错误码、现象、原因、处理措施和物料搜索。
- `services_reply` 返回非零 `result` 时，自动关联错误说明、可能原因和处理建议。
- HMS 支持十六进制与十进制错误码查询。

### 数据版本与 WebDAV

- 支持 Basic、Digest 和 Bearer Token 认证，可按需忽略自签名证书错误。
- 将连接配置、设备档案、对象存储、媒体服务、遥测数据和界面设置聚合为可移植版本。
- 数据使用 WebDAV 密码或 Token 派生的密钥进行 AES-256-GCM 加密后上传，端点凭据由 `safeStorage` 保存。
- 本地数据变更后会防抖自动同步，并每 30 秒检查其他客户端上传的更新。
- 多客户端通过 WebDAV 条件锁串行提交，再按记录执行三方合并，避免整库相互覆盖。
- 可查看本地与云端最新版本、同步活动和云端历史，并恢复或删除指定版本。
- WebDAV 密码或 Token 变更后无法解密用旧密钥创建的历史版本；轮换凭据前请保留旧密钥或先恢复所需版本。

### 应用更新

- 启动后静默检查 GitHub Releases，也可在“关于”窗口手动检查。
- 自动选择当前系统与架构对应的 DMG 或 Windows 安装包并显示下载进度。
- 下载完成前使用发布页的 `SHA256SUMS.txt` 校验文件完整性；校验通过后才允许打开安装包。

## 安装与运行

### 使用发布包

从 GitHub Releases 下载与电脑平台对应的文件：

- Apple Silicon Mac：`mac-arm64` DMG 或 ZIP。
- Intel Mac：`mac-x64` DMG 或 ZIP。
- 64 位 Windows：`windows-x64` 安装版、便携版或 ZIP。
- ARM Windows：`windows-arm64` 安装版、便携版或 ZIP。

Windows 安装版可选择安装目录；便携版可直接运行。发布页同时提供 `SHA256SUMS.txt` 用于校验下载文件。

### macOS 提示应用“已损坏”

macOS 发布包使用免费的 ad-hoc 签名，不需要 Apple Developer 证书。签名可以保证应用包内容完整，但无法获得 Apple 公证，因此首次安装时需要手工允许应用运行。

1. 将 `DJI Cloud Studio.app` 拖入“应用程序”。
2. 双击应用并关闭系统拦截提示。
3. 打开“系统设置 > 隐私与安全性”。
4. 在“安全性”区域找到 DJI Cloud Studio，点击“仍要打开”。
5. 使用登录密码或 Touch ID 确认。以后可正常双击运行当前版本。

也可以在 Finder 中按住 `Control` 点击应用，选择“打开”。如果系统仍然显示“已损坏”，确认安装包来自本项目发布页后，可在终端执行：

```bash
xattr -dr com.apple.quarantine "/Applications/DJI Cloud Studio.app"
open "/Applications/DJI Cloud Studio.app"
```

每次下载新版本时，macOS 都可能要求重新确认。公开发布且希望用户直接双击运行时，仍然只能使用 Developer ID 签名和 Apple 公证。

### 本地开发运行

环境要求：

- macOS 或 Windows。
- Node.js `22.12+`。
- npm `10.8.2`。

```bash
git clone https://github.com/Secret799/dji-cloud-debug-tool.git
cd dji-cloud-debug-tool
npm ci
npm run dev
```

`npm run dev` 会启动 Vite Renderer 和 Electron 桌面窗口。

## 功能使用方式

### 1. 配置 MQTT 连接

1. 打开右上角的连接设置。
2. 填写 Broker 地址、端口、协议版本、客户端 ID 和认证信息。
3. 使用 `mqtts` 或 `wss` 时，按需选择 CA、客户端证书和私钥。
4. 保存配置后点击“连接”。

### 2. 添加设备与订阅

1. 在左侧设备区添加机场、飞行器或 Pilot。
2. 填写设备 SN，并选择对应的设备类型。
3. 确认自动生成的 DJI Topic，也可添加自定义 Topic。
4. 启用设备后，订阅会在连接成功或重连后自动恢复。

### 3. 检查和发布 MQTT 消息

1. 在 MQTT 消息页查看接收和发送记录。
2. 使用方向、Topic 或关键字筛选记录。
3. 在发布器中填写 Topic、JSON Payload、QoS 和 Retain 后发送。
4. 需要长期保存时，将当前消息导出为 NDJSON。

### 4. 查看遥测和设置属性

1. 在设备工作台选择已发现的机场或飞行器。
2. 查看合并后的 OSD/state 字段、设备在线状态和型号信息。
3. 对可写属性点击设置操作，根据类型和约束填写新值。
4. 发送后等待 `property/set_reply` 并检查结果。

### 5. 发送 DJI 控制指令

1. 打开设备工作台的控制页签。
2. 选择机场、飞行、负载、喊话器或直播指令。
3. 核对网关 SN 和可编辑 JSON Payload。
4. 确认危险操作后发送，并在响应区查看回执。

### 6. 上传远程日志

1. 在 OSS 管理中创建阿里云 OSS、Amazon S3 或 MinIO 配置。
2. 在设备的远程日志页签查询机场或飞行器日志列表。
3. 选择日志文件和对象存储目标，设置 Object Key。
4. 发起上传后查看进度，必要时取消任务。

### 7. 执行固件升级

1. 确保目标机场已连接，并已配置可用的 OSS/S3/MinIO。
2. 打开设备工作台的“固件升级”页签。
3. 选择本地固件包、上传目标和升级设备。
4. 等待上传完成，核对 URL、MD5、大小、当前版本和目标版本。
5. 发送升级任务并查看下载、安装和结果进度。

### 8. 使用本地或远程媒体服务

1. 打开媒体中心。
2. 需要本地服务时，设置 HTTP/API、RTMP 和 RTSP 端口后启动内置 ZLMediaKit。
3. 需要远程服务时，添加 ZLMediaKit、SRS 或 SecretEMS 地址和认证信息。
4. 选择媒体服务，输入应用名和流 ID，复制生成的推流/播放地址。
5. 将推流地址填入 DJI 直播配置，再使用 HLS 地址预览。

内置 ZLMediaKit 默认端口：

| 服务 | 默认端口 |
| --- | ---: |
| HTTP / API / HLS | `9090` |
| RTMP | `1935` |
| RTSP | `8554` |

### 9. 查询错误码

1. 打开错误码管理。
2. 输入上云错误码、HMS 编码或现象关键字。
3. 查看可能原因、处理措施、建议日志和物料信息。

### 10. 使用 WebDAV 数据版本

1. 打开侧边栏的“数据版本”，进入 WebDAV 设置。
2. 填写端点地址、认证方式和凭据；使用自签名证书时可选择忽略证书错误。
3. 测试连接并保存配置，应用会立即执行首次同步；之后的数据变更会自动同步。
4. 需要立即检查云端时也可点击“立即同步”。
5. 在云端版本列表中可恢复或删除指定版本；恢复完成后应用会重新加载。

### 11. 更新应用

1. 打开侧边栏底部的“关于”。
2. 点击“检查更新”，发现新版本后点击“下载更新”。
3. 校验完成后点击“打开安装包”。Windows 会退出当前应用并启动安装程序；macOS 会打开 DMG，由系统完成替换安装。

## 常用 DJI Topic

机场设备默认生成以下订阅：

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

服务指令发送到 `thing/product/{gateway_sn}/services`，基本格式如下：

```json
{
  "tid": "uuid",
  "bid": "uuid",
  "timestamp": 1598411295123,
  "method": "cover_open",
  "data": {}
}
```

## 测试与本地构建

```bash
npm test             # 运行单元测试
npm run typecheck    # TypeScript 类型检查
npm run build        # 生成 Electron 生产文件到 out/
npm run smoke:ui     # 构建后启动真实窗口并检查核心页面
npm run smoke:toast  # 检查通知交互
npm run smoke:logs   # 检查远程日志流程
npm run smoke:mqtt   # 通过公网 Broker 进行 MQTT 发布/订阅回环
```

`smoke:mqtt` 会连接公网 Broker 并真实发布消息，不属于默认发布门禁。

### macOS 本地打包

```bash
npm run package:mac:arm64  # Apple Silicon DMG + ZIP
npm run package:mac:x64    # Intel DMG + ZIP
```

安装包和解包应用生成到 `release/`。需要重建内置 ZLMediaKit 时可执行：

```bash
npm run build:zlm -- arm64
npm run build:zlm -- x64
```

### Windows 打包

Windows `x64` 和 `arm64` 正式安装包仅通过 GitHub Actions 生成。Windows Runner 会使用 Visual Studio 2022 和 CMake 编译目标架构的 `MediaServer.exe`，然后执行 Electron 打包。每个安装包只会携带当前平台与架构的 MediaServer。

## GitHub Actions Tag 自动发布

发布工作流位于 `.github/workflows/release.yml`。推送符合以下格式的 tag 后会自动执行：

- 正式版：`v1.0.1`
- 预发布版：`v1.0.1-beta.1`

### macOS 无证书签名

macOS 构建使用 electron-builder 的 `identity: "-"` 执行 ad-hoc 签名，并在上传产物前通过 `codesign --verify --deep --strict` 检查签名完整性。该流程不需要配置 GitHub Actions Secrets，也不会向 Apple 提交公证。

### 使用项目脚本发布

先确保当前代码已提交并推送：

```bash
git status
git push origin main
npm run release:tag -- 1.0.1
```

`release:tag` 会：

1. 检查工作区是否干净。
2. 创建带注释的 `v1.0.1` tag。
3. 将 tag 推送到 `origin`。

### 手工创建 tag

```bash
git tag -a v1.0.1 -m "Release v1.0.1"
git push origin v1.0.1
```

### Actions 执行内容

1. 在 Ubuntu Runner 上执行单元测试和生产构建。
2. 并行生成 macOS Apple Silicon 和 Intel 产物。
3. 在 Windows Runner 上分别编译 `x64` 和 `ARM64` ZLMediaKit。
4. 并行生成 Windows `x64` 和 `arm64` 安装版、便携版和 ZIP。
5. 对 macOS 应用执行 ad-hoc 签名，并使用 `codesign` 验证签名完整性。
6. 确认 macOS 应用使用的是 ad-hoc 签名。
7. 生成 `SHA256SUMS.txt`。
8. 自动创建或更新 GitHub Release，并上传所有产物。

在 GitHub Actions 页面手工执行 `workflow_dispatch` 可用于验证构建；只有 tag 触发的工作流会自动创建 GitHub Release。工作流会使用 tag 中的版本号更新安装包版本，无需为每次发布手工修改 `package.json`。

## 错误码数据

结构化错误码数据位于 `src/renderer/src/data/dji-error-codes.json`，来源工作簿包含“上云错误码”、“机场 HMS 告警”和“上云常见问题解决”三类数据。对 `328XXX` 类回复码，程序会按数据规则转换为 HMS 错误码进行二次查询。

## License

本项目使用 [MIT License](LICENSE)。
