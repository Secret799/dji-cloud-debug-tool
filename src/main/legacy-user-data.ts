import { copyFile, cp, mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

/** 旧版本的应用名：userData 目录名由它派生，改名后必须把这里的用户数据搬过来 */
export const LEGACY_APP_NAME = 'DJI Cloud Studio'

/** 迁移完成标记；存在即不再重复迁移 */
export const LEGACY_MIGRATION_MARKER = '.user-data-migrated.json'

/** 旧目录里需要继承的用户数据文档（Store 的 JSON 与渲染进程快照） */
const MIGRATED_FILES = [
  'connection-profiles.json',
  'media-servers.json',
  'object-storage-profiles.json',
  'device-archives.json',
  'webdav-config.json',
  'webdav-sync-state.json',
  'map-tile-sources.json',
]

/** 渲染进程 localStorage 目录（LevelDB）；localStorage 键名沿用旧前缀，因此快照可以原样复用 */
const MIGRATED_DIRECTORIES = ['Local Storage']

/** LevelDB 的运行期锁与日志不复制，避免与源端进程互相干扰 */
const SKIPPED_DIRECTORY_ENTRIES = new Set(['LOCK', 'LOG', 'LOG.old'])

export interface LegacyUserDataMigrationResult {
  migrated: boolean
  copied: string[]
  error?: string
}

const pathExists = (path: string): Promise<boolean> => stat(path).then(
  () => true,
  () => false,
)

/**
 * 把旧应用名下的 userData 数据搬进当前 userData 目录。
 *
 * 只在目标目录还没有任何用户数据时执行一次：复制而不是移动，旧目录保留，便于回退旧版本；
 * 瓦片、媒体服务运行目录等可重建缓存不复制。失败只返回错误，不阻塞启动。
 */
export async function migrateLegacyUserData(options: {
  userDataPath: string
  appDataPath: string
  legacyAppName?: string
}): Promise<LegacyUserDataMigrationResult> {
  const source = resolve(options.appDataPath, options.legacyAppName ?? LEGACY_APP_NAME)
  const target = resolve(options.userDataPath)
  const result: LegacyUserDataMigrationResult = { migrated: false, copied: [] }

  if (source === target) return result

  try {
    const hasSourceData = (await Promise.all([
      ...MIGRATED_FILES.map((name) => pathExists(join(source, name))),
      ...MIGRATED_DIRECTORIES.map((name) => pathExists(join(source, name))),
    ])).some(Boolean)
    if (!hasSourceData) return result

    // 目标端已有全部待迁移文档，说明这次不是首次启动（或迁移已完整跑过），不再覆盖用户现有数据
    const sourceFiles = (await Promise.all(
      MIGRATED_FILES.map(async (name) => ((await pathExists(join(source, name))) ? name : null)),
    )).filter((name): name is string => name !== null)
    const targetFiles = (await Promise.all(
      MIGRATED_FILES.map(async (name) => ((await pathExists(join(target, name))) ? name : null)),
    )).filter((name): name is string => name !== null)
    const migrationComplete = (await pathExists(join(target, LEGACY_MIGRATION_MARKER)))
      || sourceFiles.every((name) => targetFiles.includes(name))
    if (migrationComplete) return result

    await mkdir(target, { recursive: true })

    for (const name of MIGRATED_FILES) {
      const from = join(source, name)
      if (!(await pathExists(from))) continue
      const to = join(target, name)
      if (await pathExists(to)) continue
      await copyFile(from, to)
      result.copied.push(name)
    }

    for (const name of MIGRATED_DIRECTORIES) {
      const from = join(source, name)
      if (!(await pathExists(from))) continue
      const to = join(target, name)
      if (await pathExists(to)) continue
      await cp(from, to, {
        recursive: true,
        force: false,
        filter: (path) => !SKIPPED_DIRECTORY_ENTRIES.has(basename(path)),
      })
      result.copied.push(name)
    }

    result.migrated = true
    await writeFile(join(target, LEGACY_MIGRATION_MARKER), JSON.stringify({
      migratedFrom: source,
      migratedAt: new Date().toISOString(),
      copied: result.copied,
    }, null, 2), { mode: 0o600 })
    return result
  } catch (error) {
    result.migrated = result.copied.length > 0
    result.error = error instanceof Error ? error.message : String(error)
    return result
  }
}