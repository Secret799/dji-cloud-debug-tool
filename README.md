# DJI Cloud Studio

DJI Cloud Studio 是一款面向 macOS 和 Windows 的机场上云 API、MQTT、设备控制与媒体流调试工具，支持 DJI 机场与草莓创新 SuperDock。

> 本项目不是 DJI 或草莓创新的官方产品。飞行、机场、负载和固件升级指令会直接发送到配置的 Broker。连接真实设备前，请先在隔离环境验证 Topic、Payload、设备 SN 和账号权限。

## 功能清单

### MQTT 连接与消息

- 保存多个连接配置，支持 `mqtt`、`mqtts`、`ws` 和 `wss`。
- 支持 MQTT 3.1.1 / 5.0、QoS 0/1/2、Clean Session、Keep Alive 和自动重连。
- 支持用户名密码、CA 证书、客户端证书和私钥。
- 连接密码使用应用内固定密钥和 AES-256-GCM 加密后保存；新保存的凭据不依赖系统密码软件。
- 支持按设备管理订阅、自定义 Topic、消息发布、Retain 与 NDJSON 导出。
- 消息列表可按方向、Topic 和关键字筛选，并检查 JSON Payload。

### DJI / SuperDock 设备与遥测

- 管理机场、飞行器和 Pilot 设备，添加设备时按 DJI 或 SuperDock 厂商自动生成常用 Topic。
- 处理 `update_topo` 网关拓扑和 `sub_device` 子设备发现。
- 根据 `domain/type/sub_type` 识别 Dock 1/2/3、SuperDock S22/S23/S24/S25 系列、飞行器和遥控器型号。
- 合并 OSD 和 state 增量上报，保留设备最新遥测快照。
- 展示 DJI Dock 2/3 与 SuperDock 官方字段名称、枚举、单位、约束、读写权限和上报模式。
- 可在遥测页通过 `property/set` 修改可写属性，并关联 `property/set_reply` 结果。
- 遥测项管理支持调整设备页签、字段顺序、字段说明和自定义属性设置规则；字段编辑器显示物模型上报来源，并为内置格式化函数提供示例预览。

### 设备控制与回执

- 内置机场、飞行、负载、PSDK 喊话器和直播控制模板。
- 发送前可编辑 JSON Payload，危险指令需要二次确认。
- `services` 与 `services_reply` 按 `tid` 自动关联，展示成功、失败和超时状态。
- 设备断开时自动禁用发布和控制操作。

### SuperDock 兼容范围

- 支持 `88097` 至 `88106` 的 S22/S23/S24/S25 系列型号，并复用其兼容的 DJI Cloud API Topic 与消息封装。
- 支持 Topic、拓扑、OSD/state 遥测、属性设置、兼容的远程调试命令，以及 SuperDock 的推杆控制、无参数 RTK 标定和两步 4G 在线认证。
- 直播推流按官方兼容矩阵限制为 RTMP 或 WHIP；SuperDock 机场相机直播中不发送清晰度切换指令。
- SuperDock 官方明确不支持远程日志、固件升级、强制关舱、补光灯、声光报警、电池保养/模式、空调、eSIM/SIM 切换与格式化，因此界面会隐藏或阻止这些入口。
- 命令页与兼容矩阵冲突时以[兼容矩阵](https://docs.sb.im/api-integration/developers/compatibility-comparison)为准；仍可在原始 MQTT 控制台手动验证自定义 Payload。

参考文档：[Topic 定义](https://docs.sb.im/api-integration/api-reference/topic-definition)、[设备型号](https://docs.sb.im/api-integration/cloud-api/device-types)、[机场属性](https://docs.sb.im/api-integration/api-reference/superdock-hangar/properties)、[远程调试](https://docs.sb.im/api-integration/api-reference/superdock-hangar/cmd)、[4G 在线认证](https://docs.sb.im/api-integration/api-reference/superdock-hangar/lte_auth)。

### 固件、日志与对象存储

- 管理阿里云 OSS、Amazon S3 和 MinIO 配置。
- Access Key、Secret Key 和 Session Token 由主进程使用应用内固定密钥和 AES-256-GCM 加密保存。
- 固件升级工作台可选择本地固件包，上传到指定对象存储，并自动计算 MD5 和文件大小。
- 核对目标设备、版本、下载 URL 和文件信息后发送 `ota_create`。
- 处理 `ota_progress` 升级进度，并自动发送 `events_reply`。
- 远程日志中心可查询机场/飞行器日志、选择文件、上传到 OSS/S3/MinIO、查看进度或取消任务。
- OSS 配置详情展示远程日志与固件升级的常用对象 Key 示例，方便新增配置时核对命名。

### 三维地图与设备定位

- 内置 Cesium 三维地球，实时展示机场与飞行器的位置，离线设备保留最后已知位置并置灰。
- 底图源支持在线地址模板、本地瓦片目录与本地 MBTiles 文件三种来源，在线与完全离线场景均可用。
- 底图源可配置坐标系（WGS-84 / GCJ-02 / BD-09）、缩放范围、瓦片边长与版权署名。
- 多底图源时可在列表里点星标「设为默认」切换地图使用的底图，默认标记与生效的底图源实时同步。
- 高德、天地图、OpenStreetMap 提供一键预设。
- 除影像底图外可单独配置地形层：在「底图源配置」里把「图层」切到「地形」，可选 Cesium World Terrain、ArcGIS WorldElevation3D 两个预设，或填自建 quantized-mesh 服务根地址（即提供 `layer.json` 的地址），完全离线场景同样可用。
- 两个地形预设都需自备免费令牌：Cesium ion 在 cesium.com/ion 免费注册后领取 Access Token，ArcGIS 在 developers.arcgis.com 免费注册后创建 API Key，填在弹窗的「API Key」处即可；自建服务不需要令牌时留空。
- 地形不影响影像底图，也不阻塞地图：令牌或地址为空、超过 3 秒未返回、上游不可用时自动回退椭球地形，并在顶部提示「地形加载失败：…，已回退椭球」。
- 影像瓦片请求全部由主进程经 `map-tile://` 特权协议代发，渲染进程不会直接请求上游影像瓦片域名；影像 API Key 保存在主进程、不回传渲染进程，只回传「是否已保存」的布尔值。地形是唯一例外：Cesium 在渲染进程内构造地形 provider 时必须拿到明文令牌，因此地形瓦片由渲染进程直连上游，令牌经 `map:get-terrain-token` 这一条专用通道按需取回，且只对地形源开放。
- 地图左下角的「已定位设备」面板同时列出原始上报的 WGS-84 读数与转换后的底图坐标，便于核对上报值。

### 媒体服务

- macOS `arm64/x64` 和 Windows `arm64/x64` 安装包均内置对应平台与架构的 ZLMediaKit。
- 安装包内置对应平台与架构的 FFmpeg，RTMP 预览无需用户另行安装或配置 `FFMPEG_PATH`。
- 本地服务提供 RTMP、RTSP、HLS、HTTP API 和 RTP Proxy/GB28181 能力。
- 可保存多个远程 ZLMediaKit、SRS 或 SecretEMS 服务。
- 根据应用名和流 ID 生成 RTMP、RTSP、HLS、WHIP 和 WHEP 地址。
- 本地 ZLMediaKit 和 SecretEMS 支持 DJI 推流的实时 SEI 诊断。
- 支持使用 HLS.js 直接预览 HLS 流。
- 媒体中心右侧提供当前服务的码流预览：ZLM 可选 HLS / WebRTC，SRS 使用 HLS，SecretEMS 使用 HTTP-TS；本地 ZLMediaKit 与 SecretEMS 在预览时同步启动 SEI 诊断，展示编码、视频 NAL、SEI 消息数、解析异常和最近消息，点击消息可查看 payloadType、长度、UUID、文本与 HEX。

### 错误码与诊断

- 内置 551 条上云错误码、92 条机场 HMS 告警和 26 条常见问题。
- 可按错误码、现象、原因、处理措施和物料搜索。
- `services_reply` 返回非零 `result` 时，自动关联错误说明、可能原因和处理建议。
- HMS 支持十六进制与十进制错误码查询。

### 数据版本与 WebDAV

- 支持 Basic、Digest 和 Bearer Token 认证，可按需忽略自签名证书错误。
- 将连接配置、设备档案、对象存储、媒体服务、遥测数据和界面设置聚合为可移植版本。
- 数据使用 WebDAV 密码或 Token 派生的独立密钥进行 AES-256-GCM 加密后上传；端点凭据则使用应用内固定密钥加密保存。
- 本地数据变更后会防抖自动同步，并每 30 秒检查其他客户端上传的更新。
- 多客户端通过 WebDAV 条件锁串行提交，再按记录执行三方合并，避免整库相互覆盖。
- 可查看本地与云端最新版本、同步活动和云端历史，并恢复或删除指定版本。
- WebDAV 密码或 Token 变更后无法解密用旧密钥创建的历史版本；轮换凭据前请保留旧密钥或先恢复所需版本。

> 应用内固定密钥可避免凭据以明文出现在 JSON 中，但密钥会随应用发布包分发，不能防御同时获得应用包和用户数据的本机攻击者。
> 从旧版本升级时，应用会尝试读取原有 `safeStorage` 密文并立即迁移；迁移完成后的日常读写不再使用系统密码软件。
> 底图源配置不参与云同步：本地瓦片源保存的是绝对路径，跨机器同步后会失效；URL 模板含 API Key，同步出去会造成泄露。

### 应用更新

- 启动后静默检查 GitHub Releases，也可在“关于”窗口手动检查。
- GitHub API 返回 403/429 时，自动改用公开 Release 地址和 `SHA256SUMS.txt` 检查版本，无需配置 Token；两条路径都失败时可通过发布页面手动下载。
- 自动选择当前系统与架构对应的 DMG 或 Windows 安装包并显示下载进度。
- 下载完成前使用发布页的 `SHA256SUMS.txt` 校验文件完整性；校验通过后才允许打开安装包。
- 设置页的“常规”分区汇总本地数据与软件更新状态，可直接跳转到更新分类。

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
2. 填写设备 SN；机场设备还需选择 DJI 或草莓机场以及具体型号。
3. 确认自动生成的厂商 Topic，也可添加自定义 Topic。
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

### 5. 发送设备控制指令

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

### 8. 查看设备三维位置

1. 打开侧边栏的「地图」。
2. 首次使用先点击工具栏的「配置底图源」，选择预设或手动填写。
3. 在线场景可直接选用高德或天地图预设并填写 API Key；离线场景选择「本地瓦片目录」或「本地 MBTiles 文件」并指定路径。
4. 点击「测试可用性」确认底图源可读取，再点击「保存」。
5. 保存后地图会加载底图，已上报定位的设备自动出现在地球上。
6. 需要地形时，在同一弹窗里把「图层」切到「地形」，选择 Cesium World Terrain / ArcGIS WorldElevation3D 预设，或选择自定义地形地址并填写自建 quantized-mesh 服务的根地址（即提供 `layer.json` 的地址）。
7. 两个地形预设都要自备免费令牌：分别到 cesium.com/ion 与 developers.arcgis.com 注册后领取 Access Token / API Key 并填入，然后保存；自建服务不需要令牌时留空，填了令牌时令牌会以 `Authorization: Bearer <令牌>` 随地形请求发出。
8. 地形加载失败（令牌或地址为空、3 秒内没有返回、上游不可用）不会卡住地图：自动回退椭球并在顶部提示「地形加载失败：…，已回退椭球」；删除地形源同样回到椭球。
9. 配置了多个底图源时，在底图源列表里点右侧星标「设为默认」即可切换地图使用的底图；列表中的「默认」标记与工具栏按钮上显示的生效源名会同步跟着走。
10. 点击「定位」可飞到设备所在区域；无定位的设备列在右下角。

坐标系说明：设备上报的是 WGS-84。若使用高德等 GCJ-02 底图或百度等 BD-09 底图，程序会自动转换后再摆点。
核对上报值请查看地图左下角的「已定位设备」面板，其中同时列出原始 WGS-84 读数与转换后的底图坐标，
这是地图视图中核对上报值的入口；设备工作台的遥测表同样展示设备上报的原始经纬度。
转换算法为公开近似算法，存在 1~2 米量级误差。

### 9. 使用本地或远程媒体服务

1. 打开媒体中心。
2. 需要本地服务时，设置 HTTP/API、RTMP 和 RTSP 端口后启动内置 ZLMediaKit。
3. 需要远程服务时，添加 ZLMediaKit、SRS 或 SecretEMS 地址和认证信息。
4. 选择媒体服务，输入应用名和流 ID，复制生成的推流/播放地址。
5. 将推流地址填入 DJI 直播配置，再使用 HLS 地址预览。
6. 在媒体中心右侧“码流预览”选择 HLS / WebRTC（SecretEMS 固定 HTTP-TS）后点击“预览”；本地 ZLMediaKit 与 SecretEMS 会同时启动 SEI 诊断，点击最近消息可查看详情。

在相机监看中选择“本地 ZLMediaKit”和“WebRTC”后，应用会同时从本地 RTSP 轨道旁路读取原始视频码流。选择 SecretEMS 时，应用会自动订阅 `/easyMedia/api/sei/events?app=live&stream={streamId}` SSE 诊断接口；设备事件接口 `/easyMedia/api/sei/devices/{deviceId}/events` 的 `sei` 数据格式也受支持。SecretEMS 的 RTMP 与 WebRTC 推流都会启用该订阅。

SEI 面板显示编码、帧或 NAL 计数、解析异常数以及最近的 `payloadType`、长度、UUID 和受限预览。本地解析只针对标准 H.264/H.265 SEI 语法，客户端不会将未公开的 payload 推断为飞行遥测字段。

内置 ZLMediaKit 默认端口：

| 服务 | 默认端口 |
| --- | ---: |
| HTTP / API / HLS | `9090` |
| RTMP | `1935` |
| RTSP | `8554` |
| WebRTC | `8000` |

### 10. 查询错误码

1. 打开错误码管理。
2. 输入上云错误码、HMS 编码或现象关键字。
3. 查看可能原因、处理措施、建议日志和物料信息。

### 11. 使用 WebDAV 数据版本

1. 打开侧边栏的“数据版本”，进入 WebDAV 设置。
2. 填写端点地址、认证方式和凭据；使用自签名证书时可选择忽略证书错误。
3. 测试连接并保存配置，应用会立即执行首次同步；之后的数据变更会自动同步。
4. 需要立即检查云端时也可点击“立即同步”。
5. 在云端版本列表中可恢复或删除指定版本；恢复完成后应用会重新加载。

### 12. 更新应用

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

安装包和解包应用生成到 `release/`。本地打包脚本会从固定 commit 动态构建 ZLMediaKit；也可单独执行：

```bash
npm run build:zlm -- arm64
npm run build:zlm -- x64
```

打包脚本会自动下载并校验固定版本的 FFmpeg 官方源码，再编译包含 RTMP 预览和 RTSP H.264/H.265 SEI 解析所需能力的 LGPL 版本。也可提前准备：

```bash
npm run prepare:ffmpeg:mac -- arm64
npm run prepare:ffmpeg:mac -- x64
```

### Windows 打包

Windows `x64` 和 `arm64` 正式安装包仅通过 GitHub Actions 生成。缓存未命中时，Windows Runner 会使用 Visual Studio 2022 和 CMake 编译目标架构的 `MediaServer.exe`，并下载经 SHA-256 校验的对应架构 FFmpeg。每个安装包只会携带当前平台与架构的 MediaServer 和 FFmpeg。

Windows FFmpeg 固定使用 BtbN 的月末构建（当前为 `autobuild-2026-08-31-13-27`）。上游仅保留最近 14 个每日构建，月末构建保留两年；升级时应选择仍在保留期内的月末版本，并同步更新 `scripts/prepare-ffmpeg-windows.ps1` 中两个架构的文件名和 SHA-256，避免缓存失效后下载返回 404。

ZLMediaKit 不作为二进制资源提交到代码仓库。GitHub Actions 会为 macOS 和 Windows 的 `x64/arm64` 四种目标动态编译，并分平台、架构缓存 MediaServer 与许可证。默认分支推送、每周维护任务和手工触发都可预热缓存；发布 tag 时优先恢复缓存，仅在首次运行、缓存过期或构建脚本变化时重新编译。

## GitHub Actions Tag 自动发布

发布工作流位于 `.github/workflows/release.yml`。推送符合以下格式的 tag 后会自动执行：

- 正式版：`v1.0.1`
- 预发布版：`v1.0.1-beta.1`

### macOS 无证书签名

macOS 构建使用 electron-builder 的 `identity: "-"` 执行 ad-hoc 签名，并在上传产物前通过 `codesign --verify --deep --strict` 检查签名完整性，再使用 `scripts/macos-package-smoke.mjs` 实际启动签名后的应用、确认主进程与界面正常加载。ad-hoc 签名没有 Team ID，因此仅在应用自身的 entitlements 中设置 `com.apple.security.cs.disable-library-validation`，以允许加载随包签名的 Electron 框架；保留 Hardened Runtime。该流程不需要配置 GitHub Actions Secrets，也不会向 Apple 提交公证。

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
3. 恢复或下载对应平台与架构的 FFmpeg，校验后写入安装包资源。
4. 在 macOS 和 Windows Runner 上恢复对应平台与架构的 ZLMediaKit 缓存，缓存未命中时动态编译。
5. 并行生成 Windows `x64` 和 `arm64` 安装版、便携版和 ZIP。
6. 对 macOS 应用执行 ad-hoc 签名，并使用 `codesign` 验证签名完整性。
7. 确认 macOS 应用使用的是 ad-hoc 签名。
8. 生成 `SHA256SUMS.txt`。
9. 自动创建或更新 GitHub Release，并上传所有产物。

在 GitHub Actions 页面手工执行 `workflow_dispatch` 可用于验证构建；只有 tag 触发的工作流会自动创建 GitHub Release。工作流会使用 tag 中的版本号更新安装包版本，无需为每次发布手工修改 `package.json`。

## 错误码数据

结构化错误码数据位于 `src/renderer/src/data/dji-error-codes.json`，来源工作簿包含“上云错误码”、“机场 HMS 告警”和“上云常见问题解决”三类数据。对 `328XXX` 类回复码，程序会按数据规则转换为 HMS 错误码进行二次查询。

## License

本项目源代码使用 [MIT License](LICENSE)。发布包中的 FFmpeg 和 ZLMediaKit 为独立第三方程序，适用其各自资源目录内附带的许可证。
