import { createPublicKey, verify } from 'node:crypto'
import {
  compareAppVersions,
  selectReleaseAsset,
  type GithubReleaseAsset,
} from './app-update-utils'

/** 更新清单中的一个安装包条目 */
export interface UpdateManifestAsset {
  name: string
  size: number
  sha256: string
}

/** 由发布流程签名、应用验签后使用的更新清单 */
export interface UpdateManifest {
  version: string
  tag: string
  publishedAt: string
  notes: string
  assets: UpdateManifestAsset[]
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MAX_ASSET_SIZE = 4 * 1024 * 1024 * 1024

const invalid = (reason: string): never => {
  throw new Error(`更新清单无效：${reason}`)
}

const manifestAsset = (value: unknown): UpdateManifestAsset => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('安装包条目不是对象')
  const entry = value as Record<string, unknown>
  const name = entry.name
  const size = entry.size
  const sha256 = entry.sha256
  if (typeof name !== 'string' || !name.trim() || name.length > 200) return invalid('安装包名称无效')
  if (name.includes('/') || name.includes('\\') || name.includes('..') || name.startsWith('.')) {
    return invalid(`安装包名称不安全：${name}`)
  }
  if (!Number.isSafeInteger(size) || (size as number) <= 0 || (size as number) > MAX_ASSET_SIZE) {
    return invalid(`安装包大小无效：${name}`)
  }
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    return invalid(`安装包 SHA-256 无效：${name}`)
  }
  return { name, size: size as number, sha256 }
}

/**
 * 校验更新清单的字段与版本约束，不负责验签。
 *
 * @param value 已解析的 JSON
 * @returns 通过校验的清单
 */
export const validateUpdateManifest = (value: unknown): UpdateManifest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('根节点不是对象')
  const record = value as Record<string, unknown>
  const version = record.version
  const tag = record.tag
  const publishedAt = record.publishedAt
  const notes = record.notes
  const assets = record.assets

  if (typeof version !== 'string' || !version.trim()) return invalid('版本号缺失')
  try {
    compareAppVersions(version, version)
  } catch {
    return invalid('版本号不是语义化版本')
  }
  if (tag !== `v${version}`) return invalid('Tag 与版本号不一致')
  if (typeof publishedAt !== 'string' || Number.isNaN(Date.parse(publishedAt))) {
    return invalid('发布时间无效')
  }
  if (typeof notes !== 'string') return invalid('更新说明缺失')
  if (!Array.isArray(assets) || !assets.length || assets.length > 100) return invalid('安装包列表无效')

  const parsedAssets = assets.map(manifestAsset)
  const names = new Set<string>()
  for (const asset of parsedAssets) {
    if (names.has(asset.name)) return invalid(`安装包重复：${asset.name}`)
    names.add(asset.name)
  }
  return { version, tag, publishedAt, notes, assets: parsedAssets }
}

/**
 * 用内置公钥校验 detached 签名（Ed25519，base64）并解析清单。
 *
 * 先验签再解析，避免把未签名的内容交给后续流程。
 *
 * @param manifestText 清单原始文本
 * @param signatureBase64 与文本逐字节对应的签名
 * @param publicKeyPem 内置公钥
 * @returns 通过验签与校验的清单
 */
export const verifyUpdateManifest = (
  manifestText: string,
  signatureBase64: string,
  publicKeyPem: string,
): UpdateManifest => {
  const signature = Buffer.from(signatureBase64.trim(), 'base64')
  if (!signature.length) throw new Error('更新清单缺少签名')
  let valid = false
  try {
    valid = verify(null, Buffer.from(manifestText, 'utf8'), createPublicKey(publicKeyPem), signature)
  } catch {
    throw new Error('更新清单签名无法验证')
  }
  if (!valid) throw new Error('更新清单签名校验失败，已拒绝更新')
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestText)
  } catch {
    throw new Error('更新清单不是有效 JSON')
  }
  return validateUpdateManifest(parsed)
}

/**
 * 按平台与架构挑选清单中的安装包。
 *
 * @param manifest 已验签的清单
 * @param platform Node 平台名
 * @param arch Node 架构名
 * @returns 选中安装包
 */
export const selectUpdateManifestAsset = (
  manifest: UpdateManifest,
  platform: NodeJS.Platform,
  arch: string,
): UpdateManifestAsset => {
  const candidates: GithubReleaseAsset[] = manifest.assets.map((asset) => ({
    name: asset.name,
    size: asset.size,
    browser_download_url: '',
  }))
  const selected = selectReleaseAsset(candidates, platform, arch)
  if (!selected) throw new Error(`新版本没有适用于 ${platform}/${arch} 的安装包`)
  const asset = manifest.assets.find((entry) => entry.name === selected.name)
  if (!asset) throw new Error('更新清单中的安装包索引无效')
  return asset
}