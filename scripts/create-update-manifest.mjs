import { createHash, createPrivateKey, sign } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [tag, directory, notesFile] = process.argv.slice(2)
if (!tag || !directory || !notesFile) {
  console.error('usage: node scripts/create-update-manifest.mjs vX.Y.Z <assets-dir> <notes-file>')
  process.exit(1)
}
if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
  console.error(`无效的 Tag：${tag}`)
  process.exit(1)
}

const privateKeyPem = (process.env.UPDATE_SIGNING_KEY ?? '').replace(/\\n/g, '\n').trim()
if (!privateKeyPem.includes('BEGIN PRIVATE KEY')) {
  console.error('缺少 UPDATE_SIGNING_KEY：发布流程必须配置更新签名私钥')
  process.exit(1)
}

const version = tag.replace(/^v/, '')
const ignored = /\.blockmap$|^SHA256SUMS\.txt$|^latest\.json(\.sig)?$/
const names = readdirSync(directory)
  .filter((name) => !ignored.test(name) && statSync(join(directory, name)).isFile())
  .sort()
const assets = names.map((name) => ({
  name,
  size: statSync(join(directory, name)).size,
  sha256: createHash('sha256').update(readFileSync(join(directory, name))).digest('hex'),
}))
if (!assets.length) {
  console.error('没有可写入清单的发布产物')
  process.exit(1)
}

const notes = readFileSync(notesFile, 'utf8').trim()
const manifest = {
  version,
  tag,
  publishedAt: new Date().toISOString(),
  notes,
  assets,
}
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
const signature = `${sign(null, Buffer.from(manifestText, 'utf8'), createPrivateKey(privateKeyPem)).toString('base64')}\n`

writeFileSync(join(directory, 'latest.json'), manifestText)
writeFileSync(join(directory, 'latest.json.sig'), signature)
console.log(`latest.json：v${version}，${assets.length} 个安装包，已签名`)