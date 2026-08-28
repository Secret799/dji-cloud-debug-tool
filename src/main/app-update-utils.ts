export interface GithubReleaseAsset {
  name: string
  browser_download_url: string
  size: number
}

interface ParsedVersion {
  core: number[]
  prerelease: string[]
}

const parseVersion = (value: string): ParsedVersion | null => {
  const match = value.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') ?? [],
  }
}

const compareIdentifier = (left: string, right: string): number => {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : null
  const rightNumber = /^\d+$/.test(right) ? Number(right) : null
  if (leftNumber !== null && rightNumber !== null) return Math.sign(leftNumber - rightNumber)
  if (leftNumber !== null) return -1
  if (rightNumber !== null) return 1
  return left.localeCompare(right)
}

export const compareAppVersions = (left: string, right: string): number => {
  const parsedLeft = parseVersion(left)
  const parsedRight = parseVersion(right)
  if (!parsedLeft || !parsedRight) throw new Error(`无法比较版本号：${left} / ${right}`)

  for (let index = 0; index < 3; index += 1) {
    const difference = parsedLeft.core[index] - parsedRight.core[index]
    if (difference !== 0) return Math.sign(difference)
  }
  if (!parsedLeft.prerelease.length && !parsedRight.prerelease.length) return 0
  if (!parsedLeft.prerelease.length) return 1
  if (!parsedRight.prerelease.length) return -1

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index]
    const rightIdentifier = parsedRight.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    const difference = compareIdentifier(leftIdentifier, rightIdentifier)
    if (difference !== 0) return difference
  }
  return 0
}

export const selectReleaseAsset = (
  assets: GithubReleaseAsset[],
  platform: NodeJS.Platform,
  arch: string,
): GithubReleaseAsset | undefined => {
  const suffix = platform === 'darwin'
    ? `-mac-${arch}.dmg`
    : platform === 'win32'
      ? `-windows-${arch}-setup.exe`
      : ''
  if (!suffix) return undefined
  return assets.find((asset) => asset.name.endsWith(suffix))
}

export const parseChecksums = (content: string): Map<string, string> => {
  const checksums = new Map<string, string>()
  for (const line of content.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)
    if (!match) continue
    const hash = match[1].toLowerCase()
    const fileName = match[2].replace(/\\/g, '/').split('/').pop()
    if (!fileName) continue
    checksums.set(fileName, hash)
    checksums.set(fileName.replaceAll(' ', '.'), hash)
  }
  return checksums
}

export const plainTextReleaseNotes = (content: string | null): string | undefined => {
  const value = content
    ?.replace(/\[([^\]]+)]\(([^)]+)\)/g, '$1: $2')
    .replace(/[*_`#]/g, '')
    .trim()
  return value || undefined
}
