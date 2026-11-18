import { app } from 'electron'

/** 地图瓦片请求的应用标识；公共瓦片服务据此识别请求方 */
const MAP_TILE_USER_AGENT_APP = 'HangarLabStudio'

/**
 * 上游瓦片请求使用的 User-Agent。
 *
 * OpenStreetMap 的公共瓦片会按 UA 判断请求方身份：Electron 默认的浏览器式 UA 会被判为
 * 不遵守使用政策，直接返回一张「Access blocked」占位瓦片 —— HTTP 仍是 200，只有看图才发现。
 * 因此所有上游瓦片请求都带上可识别的应用名与版本；用户显式配置的同名请求头优先。
 *
 * @returns 形如 `HangarLabStudio/1.5.0 (map tile debugging)` 的 UA
 */
export const mapTileUserAgent = (): string =>
  `${MAP_TILE_USER_AGENT_APP}/${app.getVersion()} (map tile debugging)`