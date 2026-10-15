// Minimal PostgreSQL client (frontend/backend protocol 3.0, simple query flow).
// Authentication: trust, cleartext, MD5 and SCRAM-SHA-256. TLS with sslmode=require/verify-full.
const crypto = require('node:crypto')
const net = require('node:net')
const tls = require('node:tls')

function parseUrl(raw) {
  const url = new URL(raw)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Die URL muss mit postgres:// beginnen.')
  return {
    host: url.hostname || 'localhost',
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username || 'postgres'),
    password: decodeURIComponent(url.password || ''),
    database: decodeURIComponent(url.pathname.replace(/^\//, '') || url.username || 'postgres'),
    ssl: url.searchParams.get('sslmode') || 'disable',
  }
}

function message(type, body) {
  const header = Buffer.alloc(type ? 5 : 4)
  if (type) {
    header.write(type, 0, 'ascii')
    header.writeInt32BE(body.length + 4, 1)
  } else header.writeInt32BE(body.length + 4, 0)
  return Buffer.concat([header, body])
}
const cstring = (text) => Buffer.from(`${text}\0`, 'utf8')

class Connection {
  constructor(socket) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.waiters = []
    this.queue = []
    this.closed = false
    socket.on('data', (chunk) => this.onData(chunk))
    socket.on('error', (error) => this.fail(error))
    socket.on('close', () => this.fail(new Error('Verbindung zur Datenbank geschlossen.')))
  }

  fail(error) {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
    this.error = error
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 5) {
      const length = this.buffer.readInt32BE(1)
      if (this.buffer.length < length + 1) break
      const packet = { type: String.fromCharCode(this.buffer[0]), body: this.buffer.subarray(5, length + 1) }
      this.buffer = this.buffer.subarray(length + 1)
      const waiter = this.waiters.shift()
      if (waiter) waiter.resolve(packet)
      else this.queue.push(packet)
    }
  }

  next() {
    if (this.queue.length) return Promise.resolve(this.queue.shift())
    if (this.closed) return Promise.reject(this.error || new Error('Verbindung geschlossen.'))
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  send(buffer) {
    this.socket.write(buffer)
  }

  close() {
    if (!this.closed) {
      try {
        this.send(message('X', Buffer.alloc(0)))
      } catch {}
      this.socket.end()
    }
    this.closed = true
  }
}

function errorFields(body) {
  const fields = {}
  let offset = 0
  while (offset < body.length && body[offset] !== 0) {
    const code = String.fromCharCode(body[offset])
    const end = body.indexOf(0, offset + 1)
    fields[code] = body.toString('utf8', offset + 1, end)
    offset = end + 1
  }
  return fields
}

function pgError(body) {
  const fields = errorFields(body)
  const error = new Error(`${fields.M || 'Datenbankfehler'}${fields.D ? ` (${fields.D})` : ''}${fields.H ? ` Hinweis: ${fields.H}` : ''}`)
  error.code = fields.C
  return error
}

function connectSocket(options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: options.host, port: options.port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Keine Verbindung zu ${options.host}:${options.port} (Timeout).`))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`Keine Verbindung zu ${options.host}:${options.port}: ${error.message}`))
    })
  })
}

async function upgradeTls(socket, options) {
  const request = Buffer.alloc(8)
  request.writeInt32BE(8, 0)
  request.writeInt32BE(80877103, 4)
  socket.write(request)
  const answer = await new Promise((resolve, reject) => {
    socket.once('data', (chunk) => resolve(String.fromCharCode(chunk[0])))
    socket.once('error', reject)
  })
  if (answer !== 'S') throw new Error('Der Server unterstützt kein TLS (sslmode=disable verwenden).')
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: options.host, rejectUnauthorized: options.ssl === 'verify-full' || options.ssl === 'verify-ca' }, () => resolve(secure))
    secure.once('error', reject)
  })
}

async function authenticate(connection, options) {
  let scram
  for (;;) {
    const packet = await connection.next()
    if (packet.type === 'E') throw pgError(packet.body)
    if (packet.type !== 'R') continue
    const code = packet.body.readInt32BE(0)
    if (code === 0) return
    if (code === 3) connection.send(message('p', cstring(options.password)))
    else if (code === 5) {
      const salt = packet.body.subarray(4, 8)
      const inner = crypto.createHash('md5').update(options.password + options.user).digest('hex')
      const outer = crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex')
      connection.send(message('p', cstring(`md5${outer}`)))
    } else if (code === 10) {
      const mechanisms = packet.body.toString('utf8', 4).split('\0')
      if (!mechanisms.includes('SCRAM-SHA-256')) throw new Error(`Nicht unterstützte Authentifizierung: ${mechanisms.join(', ')}`)
      const nonce = crypto.randomBytes(18).toString('base64')
      scram = { clientFirstBare: `n=*,r=${nonce}`, nonce }
      const data = Buffer.from(`n,,${scram.clientFirstBare}`)
      const length = Buffer.alloc(4)
      length.writeInt32BE(data.length, 0)
      connection.send(message('p', Buffer.concat([cstring('SCRAM-SHA-256'), length, data])))
    } else if (code === 11) {
      const serverFirst = packet.body.toString('utf8', 4)
      const attributes = Object.fromEntries(serverFirst.split(',').map((part) => [part[0], part.slice(2)]))
      if (!attributes.r || !attributes.r.startsWith(scram.nonce)) throw new Error('SCRAM: ungültige Server-Nonce.')
      const salted = crypto.pbkdf2Sync(options.password, Buffer.from(attributes.s, 'base64'), Number(attributes.i), 32, 'sha256')
      const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest()
      const storedKey = crypto.createHash('sha256').update(clientKey).digest()
      const finalWithoutProof = `c=biws,r=${attributes.r}`
      const authMessage = `${scram.clientFirstBare},${serverFirst},${finalWithoutProof}`
      const signature = crypto.createHmac('sha256', storedKey).update(authMessage).digest()
      const proof = Buffer.from(clientKey.map((byte, index) => byte ^ signature[index]))
      scram.serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest()
      scram.authMessage = authMessage
      connection.send(message('p', Buffer.from(`${finalWithoutProof},p=${proof.toString('base64')}`)))
    } else if (code === 12) {
      const verifier = packet.body.toString('utf8', 4).replace(/^v=/, '')
      const expected = crypto.createHmac('sha256', scram.serverKey).update(scram.authMessage).digest('base64')
      if (verifier !== expected) throw new Error('SCRAM: Server-Signatur ungültig.')
    } else throw new Error(`Nicht unterstützte Authentifizierung (Code ${code}).`)
  }
}

/** Connects, runs one simple query (may contain several statements) and returns every result set. */
async function query(url, sql, { timeoutMs = 30000 } = {}) {
  const options = parseUrl(url)
  let socket = await connectSocket(options, 10000)
  if (options.ssl !== 'disable') socket = await upgradeTls(socket, options)
  const connection = new Connection(socket)
  const timer = setTimeout(() => connection.fail(new Error(`Abfrage nach ${timeoutMs / 1000} s abgebrochen.`)), timeoutMs)
  try {
    connection.send(message('', Buffer.concat([Buffer.from([0, 3, 0, 0]), cstring('user'), cstring(options.user), cstring('database'), cstring(options.database), cstring('application_name'), cstring('multi-ai-coder'), Buffer.from([0])])))
    await authenticate(connection, options)
    for (;;) {
      const packet = await connection.next()
      if (packet.type === 'E') throw pgError(packet.body)
      if (packet.type === 'Z') break
    }
    connection.send(message('Q', cstring(sql)))
    const results = []
    let current
    let error
    for (;;) {
      const packet = await connection.next()
      if (packet.type === 'T') {
        const count = packet.body.readInt16BE(0)
        const columns = []
        let offset = 2
        for (let index = 0; index < count; index += 1) {
          const end = packet.body.indexOf(0, offset)
          columns.push(packet.body.toString('utf8', offset, end))
          offset = end + 1 + 18
        }
        current = { columns, rows: [] }
      } else if (packet.type === 'D') {
        const count = packet.body.readInt16BE(0)
        const row = []
        let offset = 2
        for (let index = 0; index < count; index += 1) {
          const length = packet.body.readInt32BE(offset)
          offset += 4
          if (length === -1) row.push(null)
          else {
            row.push(packet.body.toString('utf8', offset, offset + length))
            offset += length
          }
        }
        if (current) current.rows.push(row)
      } else if (packet.type === 'C') {
        const tag = packet.body.toString('utf8', 0, packet.body.length - 1)
        results.push({ columns: current ? current.columns : [], rows: current ? current.rows : [], command: tag })
        current = undefined
      } else if (packet.type === 'E') error = pgError(packet.body)
      else if (packet.type === 'Z') break
    }
    if (error) throw error
    return results
  } finally {
    clearTimeout(timer)
    connection.close()
  }
}

module.exports = { query, parseUrl }
