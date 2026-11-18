import { readFileSync } from 'node:fs'

const tag = process.argv[2]
if (!tag || !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
  console.error('usage: node scripts/release-notes.mjs vX.Y.Z')
  process.exit(1)
}

const version = tag.replace(/^v/, '')
const lines = readFileSync('CHANGELOG.md', 'utf8').split('\n')
const start = lines.findIndex((line) => line.trim() === `## v${version}`)
if (start === -1) {
  console.log(`DJI Cloud Studio ${tag}`)
  process.exit(0)
}

let end = lines.length
for (let index = start + 1; index < lines.length; index += 1) {
  if (/^## v\d/.test(lines[index].trim())) {
    end = index
    break
  }
}
const body = lines.slice(start + 1, end).join('\n').trim()
console.log(body || `DJI Cloud Studio ${tag}`)