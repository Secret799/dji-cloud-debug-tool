const { app, BrowserWindow } = require('electron')
const { mkdir, readFile, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const buildDirectory = join(projectRoot, 'build')

// 固定 1x 缩放，保证不同机器（含 Retina）产出的 PNG 尺寸一致，避免仓库里反复出现无意义的二进制 diff
app.commandLine.appendSwitch('force-device-scale-factor', '1')

// 品牌资产：源 SVG → 输出 PNG，尺寸与 SVG 的 viewBox 一致
const TARGETS = [
  { source: 'logo.svg', output: 'icon.png', width: 1024, height: 1024 },
  { source: 'logo-lockup.svg', output: 'logo-lockup.png', width: 1840, height: 520 },
]

const buildHtml = (svg, { width, height }) => `<!doctype html>
    <html>
      <head>
        <style>
          html, body { width: ${width}px; height: ${height}px; margin: 0; overflow: hidden; background: transparent; }
          body { display: grid; place-items: center; }
          svg { display: block; width: ${width}px; height: ${height}px; }
        </style>
      </head>
      <body>${svg}</body>
    </html>`

// 同一个窗口依次渲染多个资产：先按目标尺寸改窗口，再抓图
const renderAll = async () => {
  const [{ width, height }] = TARGETS
  const window = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
  })

  for (const target of TARGETS) {
    window.setContentSize(target.width, target.height)
    const svg = await readFile(join(buildDirectory, target.source), 'utf8')
    const html = buildHtml(svg, target)
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const captured = await window.webContents.capturePage({
      x: 0,
      y: 0,
      width: target.width,
      height: target.height,
    })
    // Retina 上 capturePage 会按 2x 抓图，这里统一压回目标像素尺寸，保证产物与规格一致
    const image = captured.getSize().width === target.width
      ? captured
      : captured.resize({ width: target.width, height: target.height, quality: 'best' })
    await writeFile(join(buildDirectory, target.output), image.toPNG())
    console.log(`rendered build/${target.output} (${target.width}×${target.height})`)
  }

  window.destroy()
}

app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  try {
    await mkdir(buildDirectory, { recursive: true })
    await renderAll()
    app.quit()
  } catch (error) {
    console.error('品牌资产渲染失败：', error)
    app.exit(1)
  }
})