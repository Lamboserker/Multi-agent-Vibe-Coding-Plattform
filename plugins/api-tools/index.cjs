// API Tools: a small REST client. Requests go through context.http (the network grant "*" is shown
// to the user as "any host"); collections and environment live in the plugin's private storage.

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

function parseHeaders(text) {
  const headers = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index > 0) headers[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return headers
}

const headerText = (headers) =>
  Object.entries(headers || {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')

function substitute(text, environment) {
  return String(text ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name) => (name in environment ? environment[name] : match))
}

async function environment(context) {
  return (await context.storage.get('environment')) || {}
}

async function send(context, request) {
  const env = await environment(context)
  const method = String(request.method || 'GET').toUpperCase()
  if (!METHODS.includes(method)) throw new Error(`Unbekannte Methode ${method}.`)
  const url = substitute(request.url, env).trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('Die URL muss mit http:// oder https:// beginnen.')
  const headers = Object.fromEntries(Object.entries(typeof request.headers === 'string' ? parseHeaders(request.headers) : request.headers || {}).map(([key, value]) => [key, substitute(value, env)]))
  const body = ['GET', 'HEAD'].includes(method) ? undefined : substitute(request.body, env) || undefined
  if (body && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type') && /^\s*[[{]/.test(body)) headers['Content-Type'] = 'application/json'
  const response = await context.http.fetch(url, { method, headers, body, timeoutMs: 30000 })
  return { method, url, ...response }
}

function pretty(body, headers) {
  const type = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] || ''
  if (/json/i.test(type) || /^\s*[[{]/.test(body)) {
    try {
      return { content: JSON.stringify(JSON.parse(body), null, 2), language: 'json' }
    } catch {}
  }
  return { content: body, language: /html/i.test(type) ? 'html' : /xml/i.test(type) ? 'xml' : 'plaintext' }
}

function responseView(result) {
  const formatted = pretty(result.body, result.headers)
  const tone = result.status < 300 ? 'ok' : result.status < 400 ? 'accent' : result.status < 500 ? 'warn' : 'error'
  return {
    type: 'stack',
    children: [
      { type: 'badge', text: `${result.status} · ${result.durationMs} ms · ${result.body.length} Zeichen`, tone },
      { type: 'text', tone: 'muted', text: `${result.method} ${result.url}` },
      { type: 'code', content: formatted.content.slice(0, 200000) || '(leer)', language: formatted.language },
      { type: 'kv', items: Object.entries(result.headers).map(([label, value]) => ({ label, value })) },
    ],
  }
}

function requestText(result) {
  return `HTTP-Anfrage ${result.method} ${result.url}\nStatus: ${result.status} (${result.durationMs} ms)\n\n${pretty(result.body, result.headers).content.slice(0, 8000)}`
}

module.exports = {
  activate(context) {
    context.views.register('main', async (input) => {
      const collection = (await context.storage.get('collection')) || []
      const env = await environment(context)
      const draft = input.request || {}
      return {
        type: 'stack',
        children: [
          { type: 'heading', text: 'Anfrage' },
          {
            type: 'form',
            fields: [
              { name: 'method', label: 'Methode', type: 'select', options: METHODS, value: draft.method || 'GET' },
              { name: 'url', label: 'URL', type: 'text', value: draft.url || '', placeholder: '{{baseUrl}}/api/health' },
              { name: 'headers', label: 'Header (Name: Wert je Zeile)', type: 'textarea', value: headerText(draft.headers) },
              { name: 'body', label: 'Body', type: 'textarea', value: draft.body || '' },
              { name: 'name', label: 'Name (zum Speichern)', type: 'text', value: draft.name || '' },
            ],
            submit: { label: 'Senden', command: 'send' },
          },
          { type: 'heading', text: `Sammlung (${collection.length})` },
          collection.length
            ? {
                type: 'table',
                columns: ['Name', 'Methode', 'URL'],
                rows: collection.map((entry) => ({
                  cells: [entry.name, entry.method, entry.url],
                  actions: [
                    { label: 'Ausführen', command: 'run', args: { name: entry.name } },
                    { label: 'Laden', command: 'load', args: { name: entry.name } },
                    { label: 'Löschen', command: 'delete', args: { name: entry.name }, confirm: `"${entry.name}" löschen?` },
                  ],
                })),
              }
            : { type: 'text', tone: 'muted', text: 'Noch keine gespeicherten Anfragen. Namen eintragen und „Senden“ speichert die Anfrage.' },
          ...(collection.length ? [{ type: 'actions', items: [{ label: 'Alle ausführen', command: 'runCollection' }] }] : []),
          { type: 'heading', text: 'Umgebung' },
          {
            type: 'form',
            fields: [{ name: 'variables', label: 'Variablen (name=wert je Zeile)', type: 'textarea', value: Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') }],
            submit: { label: 'Speichern', command: 'saveEnvironment' },
          },
        ],
      }
    })

    context.commands.register('send', async (args) => {
      const result = await send(context, args)
      if (String(args.name || '').trim()) {
        const collection = ((await context.storage.get('collection')) || []).filter((entry) => entry.name !== args.name.trim())
        collection.push({ name: args.name.trim(), method: result.method, url: String(args.url), headers: parseHeaders(args.headers), body: String(args.body || '') })
        await context.storage.set('collection', collection)
      }
      return { title: `${result.status} ${result.method}`, view: { type: 'stack', children: [responseView(result), { type: 'actions', items: [{ label: 'Antwort in den Chat', command: 'run', args: { request: { method: args.method, url: args.url, headers: args.headers, body: args.body }, toChat: true }, resultTarget: 'chat' }] }] } }
    })

    const find = async (name) => {
      const entry = ((await context.storage.get('collection')) || []).find((item) => item.name === name)
      if (!entry) throw new Error(`"${name}" ist nicht gespeichert.`)
      return entry
    }

    context.commands.register('run', async (args) => {
      const request = args.request || (await find(String(args.name)))
      const result = await send(context, request)
      if (args.toChat) return { text: requestText(result), message: 'Antwort in den Chat übernommen.' }
      return { title: request.name || `${result.method} ${result.url}`, view: responseView(result) }
    })

    context.commands.register('load', async (args) => ({ view: { type: 'text', text: 'Geladen.' }, reloadView: { request: await find(String(args.name)) } }))

    context.commands.register('delete', async (args) => {
      await context.storage.set('collection', ((await context.storage.get('collection')) || []).filter((entry) => entry.name !== args.name))
      return { message: `"${args.name}" gelöscht.` }
    })

    context.commands.register('saveEnvironment', async (args) => {
      const variables = {}
      for (const line of String(args.variables || '').split(/\r?\n/)) {
        const index = line.indexOf('=')
        if (index > 0) variables[line.slice(0, index).trim()] = line.slice(index + 1).trim()
      }
      await context.storage.set('environment', variables)
      return { message: `${Object.keys(variables).length} Variable(n) gespeichert.` }
    })

    context.commands.register('runCollection', async () => {
      const collection = (await context.storage.get('collection')) || []
      const rows = []
      for (const entry of collection) {
        try {
          const result = await send(context, entry)
          rows.push({ cells: [entry.name, `${result.status}`, `${result.durationMs} ms`] })
        } catch (error) {
          rows.push({ cells: [entry.name, 'Fehler', error.message] })
        }
      }
      return { title: 'Sammlung', view: { type: 'table', columns: ['Name', 'Status', 'Dauer'], rows } }
    })

    context.tools.register('http_request', async (args) => {
      const result = await send(context, args)
      return { status: result.status, headers: result.headers, body: result.body.slice(0, 20000), durationMs: result.durationMs }
    })
  },
}
