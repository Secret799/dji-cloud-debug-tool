export const rendererStorageSnapshot = (): Record<string, string> => ({})

export const notifyWebDavChanged = (): void => {
  void window.djiApi.webdav.changed({ rendererStorage: rendererStorageSnapshot() })
}

export const applyRendererStorageSnapshot = (_snapshot: Record<string, string>): void => undefined
