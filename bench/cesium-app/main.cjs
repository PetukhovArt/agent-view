const { app, BrowserWindow } = require('electron')

const page = process.argv.includes('--page=plain') ? 'plain' : 'index'

// A window behind other windows stops painting: Cesium skips frames, picks miss, screenshots hang.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

app.whenReady().then(() => {
  const [x, y] = process.env.BENCH_WINDOW_POS?.split(',').map(Number) ?? []
  const win = new BrowserWindow({ x, y, width: 1280, height: 800, webPreferences: { backgroundThrottling: false } })
  win.loadURL(`http://localhost:5199/${page}.html`)
})

app.on('window-all-closed', () => app.quit())
