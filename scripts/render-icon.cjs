const { app, BrowserWindow } = require('electron')
const { mkdir, readFile, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const sourcePath = join(projectRoot, 'build', 'logo.svg')
const outputPath = join(projectRoot, 'build', 'icon.png')

app.whenReady().then(async () => {
  const logo = await readFile(sourcePath, 'utf8')
  const html = `<!doctype html>
    <html>
      <head>
        <style>
          html, body { width: 1024px; height: 1024px; margin: 0; overflow: hidden; background: transparent; }
          body { display: grid; place-items: center; }
          svg { display: block; width: 1024px; height: 1024px; }
        </style>
      </head>
      <body>${logo}</body>
    </html>`

  const window = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
  })
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  await mkdir(join(projectRoot, 'build'), { recursive: true })
  await writeFile(outputPath, image.toPNG())
  window.destroy()
  app.quit()
})
