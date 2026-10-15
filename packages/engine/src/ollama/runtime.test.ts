import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { startOllamaServer, stopOwnedOllamaServers } from './runtime.js'

describe('Ollama ownership', () => {
  it('reuses an available endpoint without starting or stopping it', async () => {
    const server = createServer((_request, response) => response.end(JSON.stringify({ version: 'fixture' })))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      const values = await Promise.all([startOllamaServer({ baseUrl: url }), startOllamaServer({ baseUrl: url })])
      expect(values.every((value) => !value.started && value.pid === undefined)).toBe(true)
      await stopOwnedOllamaServers()
      expect((await fetch(`${url}/api/version`)).status).toBe(200)
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
})
