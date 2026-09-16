// 把 Cesium 的运行时静态资源拷贝到 renderer 的 public 目录。
// 不使用 vite-plugin-cesium：该插件久未更新，自行拷贝更可控。
import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(projectRoot, 'node_modules', 'cesium', 'Build', 'Cesium')
const target = join(projectRoot, 'src', 'renderer', 'public', 'cesium')

// 只拷 Build/Cesium（压缩版），不拷 CesiumUnminified 与 Source，避免安装包膨胀
const RESOURCE_DIRECTORIES = ['Assets', 'Workers', 'Widgets', 'ThirdParty']

if (!existsSync(source)) {
  console.error(`未找到 Cesium 构建产物：${source}\n请先执行 npm install`)
  process.exit(1)
}

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
for (const directory of RESOURCE_DIRECTORIES) {
  const from = join(source, directory)
  if (!existsSync(from)) {
    console.error(`Cesium 缺少资源目录：${from}`)
    process.exit(1)
  }
  await cp(from, join(target, directory), { recursive: true })
}
console.log(`Cesium 静态资源已就绪：${target}`)
