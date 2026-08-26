const { app, BrowserWindow } = require('electron')
const { mkdir, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { RadioTower } = require('lucide-react')

const projectRoot = resolve(__dirname, '..')
const outputPath = join(projectRoot, 'build', 'icon.png')

app.whenReady().then(async () => {
  const symbol = renderToStaticMarkup(
    React.createElement(RadioTower, {
      width: 470,
      height: 470,
      color: '#57d99a',
      strokeWidth: 1.9,
      'aria-hidden': true,
    }),
  )
  const html = `<!doctype html>
    <html>
      <head>
        <style>
          html, body { width: 1024px; height: 1024px; margin: 0; overflow: hidden; background: transparent; }
          body { display: grid; place-items: center; }
          .icon {
            position: relative;
            display: grid;
            width: 900px;
            height: 900px;
            place-items: center;
            overflow: hidden;
            border: 18px solid #424b45;
            border-radius: 218px;
            background: #202421;
            box-shadow: inset 0 0 0 12px #171a18, 0 26px 70px rgba(18, 24, 20, 0.28);
          }
          .icon::before {
            position: absolute;
            width: 650px;
            height: 650px;
            border: 5px solid rgba(87, 217, 154, 0.12);
            border-radius: 50%;
            content: '';
          }
          .symbol {
            position: relative;
            display: grid;
            width: 590px;
            height: 590px;
            place-items: center;
            border: 5px solid rgba(87, 217, 154, 0.2);
            border-radius: 170px;
            background: #29312c;
          }
        </style>
      </head>
      <body><div class="icon"><div class="symbol">${symbol}</div></div></body>
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
