export const WEB_DAV_STORAGE_KEYS = [
  'dji-cloud-studio.sidebar-width',
  'dji-cloud-studio.telemetry-cache.v1',
  'dji-cloud-studio.telemetry-layout.v1',
] as const

export const rendererStorageSnapshot = (): Record<string, string> => Object.fromEntries(
  WEB_DAV_STORAGE_KEYS.flatMap((key) => {
    const value = window.localStorage.getItem(key)
    return value === null ? [] : [[key, value]]
  }),
)

export const notifyWebDavChanged = (): void => {
  void window.djiApi.webdav.changed({ rendererStorage: rendererStorageSnapshot() })
}

export const applyRendererStorageSnapshot = (snapshot: Record<string, string>): void => {
  WEB_DAV_STORAGE_KEYS.forEach((key) => window.localStorage.removeItem(key))
  Object.entries(snapshot).forEach(([key, value]) => window.localStorage.setItem(key, value))
}
