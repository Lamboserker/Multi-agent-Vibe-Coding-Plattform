// Renders the installer artwork from HTML with Electron (real typography, no image tools needed):
//   build/installerSidebar.bmp, build/uninstallerSidebar.bmp (164×314, NSIS welcome/finish pages)
//   build/installerHeader.bmp (150×57, NSIS inner pages)
//   build/background.png + build/background@2x.png (540×380, macOS DMG window)
// Started by scripts/make-installer-art.mjs. The colors match the app icon; the header is white
// like the NSIS header strip it sits in.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')
const build = path.join(root, 'build')
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const dataUrl = (file, type) => `data:${type};base64,${fs.readFileSync(file).toString('base64')}`
const icon = dataUrl(path.join(build, 'icon.png'), 'image/png')
const fonts = ['space-grotesk-latin', 'space-grotesk-latin-ext']
  .map((name) => `@font-face{font-family:'Space Grotesk';font-weight:300 700;src:url(${dataUrl(path.join(root, 'src/renderer/fonts', `${name}.woff2`), 'font/woff2')}) format('woff2')}`)
  .join('')

const NAVY = '#141a26'
const base = (body, scale = 1) => `<!doctype html><html><head><meta charset="utf-8"><style>
${fonts}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden}
body{zoom:${scale};font-family:'Space Grotesk',sans-serif;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
</style></head><body>${body}</body></html>`

const nodes = (size) => `
<svg width="${size * 3}" height="${size}" viewBox="0 0 66 22" style="display:block">
  <line x1="11" y1="11" x2="55" y2="11" stroke="#46566f" stroke-width="2"/>
  <circle cx="11" cy="11" r="7" fill="#4fc1a6"/><circle cx="33" cy="11" r="7" fill="#e5a54b"/><circle cx="55" cy="11" r="7" fill="#b48cff"/>
</svg>`

const sidebar = (subtitle) => base(`
<div style="position:relative;width:164px;height:314px;background:linear-gradient(180deg,#171e2c 0%,${NAVY} 55%,#10151f 100%);color:#eef1f7;overflow:hidden">
  <div style="position:absolute;inset:0;background-image:radial-gradient(rgba(180,140,255,.10) 1px,transparent 1px);background-size:12px 12px"></div>
  <div style="position:absolute;left:-50px;top:-60px;width:220px;height:220px;border-radius:50%;background:radial-gradient(circle,rgba(180,140,255,.28),rgba(180,140,255,0) 68%)"></div>
  <div style="position:absolute;left:20px;top:26px">
    <img src="${icon}" style="width:58px;height:58px;display:block;filter:drop-shadow(0 6px 16px rgba(0,0,0,.45))">
    <div style="margin-top:16px;font-size:19px;font-weight:600;letter-spacing:-.2px;line-height:1.1">Multi-AI<br>Coder</div>
    <div style="margin-top:9px;width:26px;height:3px;border-radius:2px;background:#b48cff"></div>
    <div style="margin-top:10px;font-size:10.5px;line-height:1.45;color:#a9b3c4;width:126px">${subtitle}</div>
  </div>
  <div style="position:absolute;left:20px;bottom:20px">
    ${nodes(9)}
    <div style="margin-top:8px;font-size:9.5px;color:#7d889b;letter-spacing:.3px">Version ${version}</div>
  </div>
</div>`)

const header = base(`
<div style="width:150px;height:57px;background:#ffffff;display:flex;align-items:center;justify-content:flex-end;padding-right:12px;gap:9px">
  <div style="text-align:right;line-height:1.1">
    <div style="font-size:11px;font-weight:600;color:#141a26">Multi-AI Coder</div>
    <div style="font-size:8.5px;color:#6b7280;margin-top:2px">v${version}</div>
  </div>
  <img src="${icon}" style="width:36px;height:36px;display:block">
</div>`)

// DMG: Finder draws the app icon at (140,196) and the Applications link at (400,196), labels below
// them in dark text, so the window background stays light.
const dmg = (scale) => base(`
<div style="position:relative;width:540px;height:380px;background:linear-gradient(180deg,#faf8f5 0%,#f1eee9 100%);color:#1d2230;overflow:hidden">
  <div style="position:absolute;inset:0;background-image:radial-gradient(rgba(20,26,38,.07) 1px,transparent 1px);background-size:16px 16px"></div>
  <div style="position:absolute;right:-90px;top:-120px;width:320px;height:320px;border-radius:50%;background:radial-gradient(circle,rgba(150,110,240,.20),rgba(150,110,240,0) 70%)"></div>
  <div style="position:absolute;left:0;right:0;top:30px;text-align:center">
    <div style="font-size:22px;font-weight:600;letter-spacing:-.3px">Multi-AI Coder</div>
    <div style="margin-top:5px;font-size:12px;color:#6b7280">Premium-Orchestrator + lokale Coding-Modelle · Version ${version}</div>
  </div>
  <svg width="540" height="380" style="position:absolute;left:0;top:0">
    <defs><marker id="a" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#8b5cf6"/></marker></defs>
    <path d="M214 196 C 250 176, 290 176, 326 196" fill="none" stroke="#8b5cf6" stroke-width="2.5" stroke-dasharray="2 7" stroke-linecap="round" marker-end="url(#a)"/>
  </svg>
  <div style="position:absolute;left:0;right:0;bottom:34px;text-align:center">
    <div style="font-size:13px;font-weight:600">Ziehe Multi-AI Coder in den Programme-Ordner</div>
    <div style="margin-top:5px;font-size:11px;color:#6b7280">Beim ersten Start richtet ein Assistent Orchestrator, lokale Modelle und Workspace ein.</div>
  </div>
</div>`, scale)

const targets = [
  { file: 'installerSidebar.bmp', width: 164, height: 314, html: sidebar('Premium-Orchestrator<br>+ lokale Coding-Modelle.<br><br>Nach der Installation führt dich ein Assistent durch die Einrichtung.') },
  { file: 'uninstallerSidebar.bmp', width: 164, height: 314, html: sidebar('Deinstallation.<br><br>Deine Projektordner bleiben erhalten.') },
  { file: 'installerHeader.bmp', width: 150, height: 57, html: header },
  { file: 'background.png', width: 540, height: 380, html: dmg(1) },
  { file: 'background@2x.png', width: 1080, height: 760, html: dmg(2) },
]

/** 24-bit bottom-up BMP from Electron's BGRA bitmap (NSIS only accepts BMP). */
function bmp(bgra, width, height) {
  const row = Math.ceil((width * 3) / 4) * 4
  const out = Buffer.alloc(54 + row * height)
  out.write('BM', 0)
  out.writeUInt32LE(out.length, 2)
  out.writeUInt32LE(54, 10)
  out.writeUInt32LE(40, 14)
  out.writeInt32LE(width, 18)
  out.writeInt32LE(height, 22)
  out.writeUInt16LE(1, 26)
  out.writeUInt16LE(24, 28)
  out.writeUInt32LE(row * height, 34)
  for (let y = 0; y < height; y += 1) {
    const target = 54 + (height - 1 - y) * row
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4
      out[target + x * 3] = bgra[source]
      out[target + x * 3 + 1] = bgra[source + 1]
      out[target + x * 3 + 2] = bgra[source + 2]
    }
  }
  return out
}

async function render(target) {
  const window = new BrowserWindow({ show: false, width: target.width, height: target.height, useContentSize: true, frame: false, webPreferences: { offscreen: true } })
  // a file, not a data: URL (the embedded fonts exceed the data: URL size limit)
  const page = path.join(os.tmpdir(), `mac-installer-art-${process.pid}.html`)
  fs.writeFileSync(page, target.html)
  await window.loadFile(page)
  fs.rmSync(page, { force: true })
  await window.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))')
  let image = await window.webContents.capturePage({ x: 0, y: 0, width: target.width, height: target.height })
  const size = image.getSize()
  if (size.width !== target.width || size.height !== target.height) image = image.resize({ width: target.width, height: target.height, quality: 'best' })
  window.destroy()
  const file = path.join(build, target.file)
  fs.writeFileSync(file, target.file.endsWith('.bmp') ? bmp(image.toBitmap(), target.width, target.height) : image.toPNG())
  // optional PNG copies for reviewing the BMPs
  if (process.env.MAC_ART_PREVIEW_DIR) fs.writeFileSync(path.join(process.env.MAC_ART_PREVIEW_DIR, `${target.file}.png`), image.toPNG())
  console.log(`${path.relative(root, file)} (${target.width}×${target.height})`)
}

app.disableHardwareAcceleration()
// one window per image: closing the last one must not quit before the next is created
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  try {
    for (const target of targets) await render(target)
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
