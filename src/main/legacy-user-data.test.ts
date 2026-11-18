import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LEGACY_APP_NAME, LEGACY_MIGRATION_MARKER, migrateLegacyUserData } from './legacy-user-data'

describe('migrateLegacyUserData', () => {
  let root: string
  let appDataPath: string
  let userDataPath: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hangarlab-legacy-user-data-'))
    appDataPath = join(root, 'appData')
    userDataPath = join(appDataPath, 'HangarLab Studio')
    await mkdir(join(appDataPath, LEGACY_APP_NAME, 'Local Storage', 'leveldb'), { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('把旧目录的连接配置与 localStorage 复制到新目录并写下标记', async () => {
    await writeFile(join(appDataPath, LEGACY_APP_NAME, 'connection-profiles.json'), '{"profiles":1}', 'utf8')
    await writeFile(join(appDataPath, LEGACY_APP_NAME, 'webdav-config.json'), '{"endpoint":"x"}', 'utf8')
    await writeFile(join(appDataPath, LEGACY_APP_NAME, 'Local Storage', 'leveldb', '000001.log'), 'db', 'utf8')

    const result = await migrateLegacyUserData({ userDataPath, appDataPath })

    expect(result.error).toBeUndefined()
    expect(result.migrated).toBe(true)
    expect(result.copied).toEqual([
      'connection-profiles.json',
      'webdav-config.json',
      'Local Storage',
    ])
    expect(await readFile(join(userDataPath, 'connection-profiles.json'), 'utf8')).toBe('{"profiles":1}')
    expect(await readFile(join(userDataPath, 'Local Storage', 'leveldb', '000001.log'), 'utf8')).toBe('db')
    const marker = JSON.parse(await readFile(join(userDataPath, LEGACY_MIGRATION_MARKER), 'utf8'))
    expect(marker.copied).toContain('connection-profiles.json')
    // 旧目录保留，方便回退旧版本
    expect(await stat(join(appDataPath, LEGACY_APP_NAME, 'connection-profiles.json'))).toBeTruthy()
  })

  it('目标目录已有用户数据时不覆盖、不重复迁移', async () => {
    await writeFile(join(appDataPath, LEGACY_APP_NAME, 'connection-profiles.json'), '{"profiles":1}', 'utf8')
    await mkdir(userDataPath, { recursive: true })
    await writeFile(join(userDataPath, 'connection-profiles.json'), '{"profiles":2}', 'utf8')

    const result = await migrateLegacyUserData({ userDataPath, appDataPath })

    expect(result.migrated).toBe(false)
    expect(result.copied).toEqual([])
    expect(await readFile(join(userDataPath, 'connection-profiles.json'), 'utf8')).toBe('{"profiles":2}')
    expect((await readdir(userDataPath)).includes(LEGACY_MIGRATION_MARKER)).toBe(false)
  })

  it('上次迁移只完成一部分时补齐缺失文档且不覆盖已有数据', async () => {
    await writeFile(join(appDataPath, LEGACY_APP_NAME, 'connection-profiles.json'), '{"profiles":1}', 'utf8')
    await writeFile(join(appDataPath, LEGACY_APP_NAME, 'webdav-config.json'), '{"endpoint":"x"}', 'utf8')
    await mkdir(userDataPath, { recursive: true })
    await writeFile(join(userDataPath, 'connection-profiles.json'), '{"profiles":2}', 'utf8')

    const result = await migrateLegacyUserData({ userDataPath, appDataPath })

    expect(result.copied).toEqual(['webdav-config.json', 'Local Storage'])
    expect(await readFile(join(userDataPath, 'connection-profiles.json'), 'utf8')).toBe('{"profiles":2}')
    expect(await readFile(join(userDataPath, 'webdav-config.json'), 'utf8')).toBe('{"endpoint":"x"}')
    expect((await readdir(userDataPath)).includes(LEGACY_MIGRATION_MARKER)).toBe(true)
  })

  it('已有标记时不再迁移', async () => {
    await writeFile(join(appDataPath, LEGACY_APP_NAME, 'connection-profiles.json'), '{"profiles":1}', 'utf8')
    await mkdir(userDataPath, { recursive: true })
    await writeFile(join(userDataPath, LEGACY_MIGRATION_MARKER), '{}', 'utf8')

    const result = await migrateLegacyUserData({ userDataPath, appDataPath })

    expect(result.migrated).toBe(false)
  })

  it('旧目录不存在时不做任何事', async () => {
    const result = await migrateLegacyUserData({
      userDataPath,
      appDataPath,
      legacyAppName: 'Unused Legacy App',
    })

    expect(result).toEqual({ migrated: false, copied: [] })
    expect(await stat(userDataPath).then(() => true, () => false)).toBe(false)
  })

  it('新旧目录相同时直接跳过', async () => {
    const result = await migrateLegacyUserData({
      userDataPath: join(appDataPath, LEGACY_APP_NAME),
      appDataPath,
    })

    expect(result).toEqual({ migrated: false, copied: [] })
  })

  it('复制失败时返回错误而不抛异常', async () => {
    await writeFile(join(appDataPath, LEGACY_APP_NAME, 'connection-profiles.json'), '{"profiles":1}', 'utf8')
    // 目标路径被一个普通文件占住，mkdir 会失败
    await writeFile(userDataPath, 'not a directory', 'utf8')

    const result = await migrateLegacyUserData({ userDataPath, appDataPath })

    expect(result.migrated).toBe(false)
    expect(result.error).toBeTruthy()
  })
})