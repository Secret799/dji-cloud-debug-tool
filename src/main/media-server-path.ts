import { join } from 'node:path'

interface MediaServerPathOptions {
  appPath: string
  arch?: NodeJS.Architecture
  isPackaged: boolean
  platform?: NodeJS.Platform
  resourcesPath: string
}

export const mediaServerExecutableName = (platform: NodeJS.Platform = process.platform): string =>
  platform === 'win32' ? 'MediaServer.exe' : 'MediaServer'

export const mediaServerVendorDirectory = (
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string => platform === 'darwin' ? arch : `${platform}-${arch}`

export const resolveMediaServerBinaryPath = ({
  appPath,
  arch = process.arch,
  isPackaged,
  platform = process.platform,
  resourcesPath,
}: MediaServerPathOptions): string => {
  const executable = mediaServerExecutableName(platform)
  return isPackaged
    ? join(resourcesPath, 'zlmediakit', executable)
    : join(appPath, 'vendor', 'zlmediakit', mediaServerVendorDirectory(platform, arch), executable)
}
