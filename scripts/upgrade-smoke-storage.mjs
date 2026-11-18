const extractStorageKey = (source, name) => source.match(
  new RegExp(`const ${name} = ['\\\"]([^'\\\"]+)['\\\"]`),
)?.[1]

export const selectUpgradeSmokeStorageKey = ({ validationSource, layoutSource, sidebarKey }) => {
  const allowedKeys = [...validationSource.matchAll(/'([^']+)'/g)].map((match) => match[1])
  const layoutKey = extractStorageKey(layoutSource, 'STORAGE_KEY')
  if (!layoutKey || !allowedKeys.includes(layoutKey)) {
    throw new Error('未能找到同时存在于 WebDAV 白名单中的 telemetry layout 存储键')
  }
  if (layoutKey === sidebarKey) throw new Error('telemetry layout 存储键不能与侧栏宽度键相同')
  return layoutKey
}
