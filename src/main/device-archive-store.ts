import { app } from 'electron'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DeviceArchive } from '../shared/contracts'

interface StoreDocument {
  version: 1
  archives: DeviceArchive[]
}

export class DeviceArchiveStore {
  private readonly filePath = join(app.getPath('userData'), 'device-archives.json')
  private operationQueue: Promise<void> = Promise.resolve()

  list(): Promise<DeviceArchive[]> {
    return this.runExclusive(async () => (await this.readDocument()).archives)
  }

  replaceAll(archives: DeviceArchive[]): Promise<void> {
    return this.runExclusive(async () => {
      await this.writeDocument({ version: 1, archives })
    })
  }

  replaceProfile(profileId: string, archives: DeviceArchive[]): Promise<DeviceArchive[]> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      document.archives = [
        ...document.archives.filter((archive) => archive.profileId !== profileId),
        ...archives,
      ]
      await this.writeDocument(document)
      return archives
    })
  }

  removeProfile(profileId: string): Promise<boolean> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      const archives = document.archives.filter((archive) => archive.profileId !== profileId)
      if (archives.length === document.archives.length) return false
      document.archives = archives
      await this.writeDocument(document)
      return true
    })
  }

  private async readDocument(): Promise<StoreDocument> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { version: 1, archives: [] }
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoreDocument>
      if (parsed.version !== 1 || !Array.isArray(parsed.archives)) throw new Error('设备档案版本无效')
      return parsed as StoreDocument
    } catch (error) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backupPath = `${this.filePath}.corrupt-${timestamp}-${crypto.randomUUID()}.bak`
      await writeFile(backupPath, raw, { mode: 0o600, flag: 'wx' })
      console.warn(`Invalid device archive store backed up to ${backupPath}; restoring empty archive:`, error)
      const document: StoreDocument = { version: 1, archives: [] }
      await this.writeDocument(document)
      return document
    }
  }

  private async writeDocument(document: StoreDocument): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(tempPath, JSON.stringify(document, null, 2), { mode: 0o600, flag: 'wx' })
      await rename(tempPath, this.filePath)
    } catch (error) {
      try {
        await unlink(tempPath)
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('Unable to remove temporary device archive store:', cleanupError)
        }
      }
      throw error
    }
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation)
    this.operationQueue = result.then(() => undefined, () => undefined)
    return result
  }
}
