import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  selectUpdateManifestAsset,
  validateUpdateManifest,
  verifyUpdateManifest,
} from './app-update-manifest'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

const sha = (char: string): string => char.repeat(64)

const manifest = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: '1.3.0',
  tag: 'v1.3.0',
  publishedAt: '2026-11-18T02:00:00.000Z',
  notes: '- 更新检查改为签名清单',
  assets: [
    { name: 'HangarLab.Studio-1.3.0-mac-arm64.dmg', size: 1024, sha256: sha('a') },
    { name: 'HangarLab.Studio-1.3.0-windows-x64-setup.exe', size: 2048, sha256: sha('b') },
  ],
  ...patch,
})

const text = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
const signText = (value: string): string => sign(null, Buffer.from(value, 'utf8'), privateKey).toString('base64')

describe('更新清单验签', () => {
  it('接受签名正确、字段完整的清单', () => {
    const body = text(manifest())
    const parsed = verifyUpdateManifest(body, signText(body), publicKeyPem)

    expect(parsed.version).toBe('1.3.0')
    expect(parsed.tag).toBe('v1.3.0')
    expect(parsed.assets).toHaveLength(2)
    expect(parsed.assets[0].sha256).toBe(sha('a'))
  })

  it('拒绝被篡改的清单文本', () => {
    const body = text(manifest())
    const tampered = body.replace('签名清单', '被替换的说明')

    expect(() => verifyUpdateManifest(tampered, signText(body), publicKeyPem)).toThrow('签名校验失败')
  })

  it('拒绝无效或缺失的签名', () => {
    const body = text(manifest())

    expect(() => verifyUpdateManifest(body, '', publicKeyPem)).toThrow('缺少签名')
    expect(() => verifyUpdateManifest(body, 'not-base64-signature', publicKeyPem)).toThrow('签名校验失败')
  })
})

describe('更新清单校验', () => {
  it('拒绝 Tag 与版本号不一致、非语义化版本和缺少发布时间', () => {
    expect(() => validateUpdateManifest(manifest({ tag: 'v1.2.9' }))).toThrow('Tag 与版本号不一致')
    expect(() => validateUpdateManifest(manifest({ version: '1.3', tag: 'v1.3' }))).toThrow('语义化版本')
    expect(() => validateUpdateManifest(manifest({ publishedAt: 'not-a-date' }))).toThrow('发布时间无效')
  })

  it('拒绝不安全的安装包名称、错误哈希与重复条目', () => {
    const withAsset = (asset: Record<string, unknown>): Record<string, unknown> =>
      manifest({ assets: [asset] })

    expect(() => validateUpdateManifest(withAsset({ name: '../evil.dmg', size: 1, sha256: sha('c') }))).toThrow('不安全')
    expect(() => validateUpdateManifest(withAsset({ name: 'a.dmg', size: 0, sha256: sha('c') }))).toThrow('大小无效')
    expect(() => validateUpdateManifest(withAsset({ name: 'a.dmg', size: 1, sha256: 'xyz' }))).toThrow('SHA-256 无效')

    const duplicate = manifest()
    const assets = duplicate.assets as Array<Record<string, unknown>>
    duplicate.assets = [assets[0], { ...assets[0] }]
    expect(() => validateUpdateManifest(duplicate)).toThrow('安装包重复')
  })
})

describe('更新清单安装包选择', () => {
  const assets = [
    'HangarLab.Studio-1.3.0-mac-arm64.dmg',
    'HangarLab.Studio-1.3.0-mac-x64.dmg',
    'HangarLab.Studio-1.3.0-windows-x64-setup.exe',
    'HangarLab.Studio-1.3.0-windows-arm64-setup.exe',
  ].map((name, index) => ({ name, size: 1024 + index, sha256: sha('d') }))
  const parsed = validateUpdateManifest(manifest({ assets }))

  it('按平台与架构挑选安装包', () => {
    expect(selectUpdateManifestAsset(parsed, 'darwin', 'arm64').name).toContain('mac-arm64.dmg')
    expect(selectUpdateManifestAsset(parsed, 'darwin', 'x64').name).toContain('mac-x64.dmg')
    expect(selectUpdateManifestAsset(parsed, 'win32', 'x64').name).toContain('windows-x64-setup.exe')
    expect(selectUpdateManifestAsset(parsed, 'win32', 'arm64').name).toContain('windows-arm64-setup.exe')
  })

  it('没有对应平台的安装包时明确报错', () => {
    expect(() => selectUpdateManifestAsset(parsed, 'linux', 'x64')).toThrow('没有适用于 linux/x64 的安装包')
  })
})