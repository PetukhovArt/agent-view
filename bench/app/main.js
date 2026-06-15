const { app, BrowserWindow } = require('electron')
const path = require('path')
const http = require('http')
const crypto = require('crypto')

const NET_PORT = 19333

// ── Minimal HTTP + WebSocket-echo server for the `network` smoke ──────────────
// Dependency-free: hand-rolled WS framing (text frames only, small payloads).
function decodeFrame(buf) {
  const opcode = buf[0] & 0x0f
  if (opcode === 0x8) return { close: true }
  let len = buf[1] & 0x7f
  let off = 2
  if (len === 126) { len = buf.readUInt16BE(2); off = 4 }
  else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10 }
  const masked = buf[1] & 0x80
  let mask = null
  if (masked) { mask = buf.slice(off, off + 4); off += 4 }
  const data = buf.slice(off, off + len)
  if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3]
  return { text: data.toString('utf8'), opcode }
}

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8')
  const len = payload.length
  let header
  if (len < 126) header = Buffer.from([0x81, len])
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2) }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2) }
  return Buffer.concat([header, payload])
}

function startNetServer() {
  const server = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
    if (req.url === '/api/bootstrap') {
      res.writeHead(200, cors)
      res.end(JSON.stringify({ ok: true, user: 'bench', ts: Date.now() }))
      return
    }
    if (req.url === '/api/missing') {
      res.writeHead(404, cors)
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    res.writeHead(200, cors)
    res.end('{}')
  })

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n',
    )
    socket.write(encodeFrame('WELCOME_FROM_SERVER'))
    socket.on('data', (buf) => {
      const frame = decodeFrame(buf)
      if (frame.close) { socket.end(); return }
      if (frame.text !== undefined) socket.write(encodeFrame('echo:' + frame.text))
    })
    socket.on('error', () => {})
  })

  server.listen(NET_PORT, '127.0.0.1')
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  win.loadFile(path.join(__dirname, 'index.html'))
}

startNetServer()
app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
