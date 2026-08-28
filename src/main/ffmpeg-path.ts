import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

interface FfmpegPathOptions {
  appPath: string
  arch?: NodeJS.Architecture
  isPackaged: boolean
  platform?: NodeJS.Platform
  resourcesPath: string
}

export const ffmpegExecutableName = (platform: NodeJS.Platform = process.platform): string =>
  platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'

export const ffmpegVendorDirectory = (
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string => `${platform}-${arch}`

export const resolveBundledFfmpegPath = ({
  appPath,
  arch = process.arch,
  isPackaged,
  platform = process.platform,
  resourcesPath,
}: FfmpegPathOptions): string => {
  const executable = ffmpegExecutableName(platform)
  return isPackaged
    ? join(resourcesPath, 'ffmpeg', executable)
    : join(appPath, 'vendor', 'ffmpeg', ffmpegVendorDirectory(platform, arch), executable)
}

interface FindFfmpegOptions extends FfmpegPathOptions {
  overridePath?: string
  searchPath?: string
}

export const findFfmpegExecutable = async (options: FindFfmpegOptions): Promise<string> => {
  const executable = ffmpegExecutableName(options.platform)
  const pathCandidates = (options.searchPath ?? '').split(delimiter).filter(Boolean)
    .map((path) => join(path, executable))
  const candidates = [
    options.overridePath,
    resolveBundledFfmpegPath(options),
    ...pathCandidates,
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/Caskroom/miniconda/base/bin/ffmpeg',
  ].filter((path): path is string => Boolean(path))

  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue through the known executable locations.
    }
  }
  throw new Error('未找到可用的 FFmpeg；请重新安装应用，或设置 FFMPEG_PATH')
}
