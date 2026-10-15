// Database Tools: SQLite files of the open project (node:sqlite) and PostgreSQL (postgres.cjs).
// Read queries run read-only at database level (SQLite opened read-only, PostgreSQL inside a
// READ ONLY transaction); anything else needs an explicit confirmation by the user.
const path = require('node:path')
const postgres = require('./postgres.cjs')

const DB_FILE = /\.(db|sqlite|sqlite3|db3)$/i
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage'])

/** Strips comments and decides whether a statement only reads. Several statements count as writing. */
function isReadOnly(sql) {
  const text = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;\s*$/, '')
  if (!text || text.includes(';')) return false
  const keyword = text.split(/\s+/)[0].toLowerCase()
  // SELECT … INTO creates a table (PostgreSQL)
  if (keyword === 'select') return !/\binto\b/i.test(text)
  if (['show', 'values', 'table', 'describe'].includes(keyword)) return true
  if (keyword === 'explain') return !/\banalyze\b/i.test(text)
  if (keyword === 'pragma') return !text.includes('=')
  if (keyword === 'with') return !/\b(insert|update|delete|merge|create|drop|alter)\b/i.test(text)
  return false
}

async function settings(context) {
  return {
    connection: (await context.settings.get('connection')) || 'sqlite',
    sqliteFile: String((await context.settings.get('sqliteFile')) || '').trim(),
    maxRows: Math.min(Math.max(Number(await context.settings.get('maxRows')) || 500, 1), 5000),
  }
}

async function sqlitePath(context, relative) {
  const project = await context.project()
  if (!project) throw new Error('Kein Projekt geöffnet.')
  if (!relative) throw new Error('Keine SQLite-Datei gewählt (Plugin-Einstellungen oder Auswahl unten).')
  const absolute = path.resolve(project.repoPath, relative)
  if (!absolute.toLowerCase().startsWith(path.resolve(project.repoPath).toLowerCase() + path.sep)) throw new Error('Die Datei muss im Projekt liegen.')
  return absolute
}

function runSqlite(file, sql, { readOnly, maxRows }) {
  const { DatabaseSync } = require('node:sqlite')
  const database = new DatabaseSync(file, { readOnly })
  try {
    const statement = database.prepare(sql)
    if (statement.columns && statement.columns().length === 0) {
      const result = statement.run()
      return { columns: [], rows: [], command: `${result.changes} Zeile(n) geändert` }
    }
    const rows = []
    let truncated = false
    for (const row of statement.iterate()) {
      if (rows.length >= maxRows) {
        truncated = true
        break
      }
      rows.push(row)
    }
    const columns = statement.columns ? statement.columns().map((column) => column.name) : Object.keys(rows[0] || {})
    return { columns, rows: rows.map((row) => columns.map((column) => row[column])), truncated }
  } finally {
    database.close()
  }
}

async function execute(context, sql, { confirmed = false, sqliteFile, connection, maxRows } = {}) {
  const config = await settings(context)
  const kind = connection || config.connection
  const readOnly = isReadOnly(sql)
  if (!readOnly && !confirmed) return { needsConfirmation: true }
  const limit = maxRows || config.maxRows
  const started = Date.now()
  if (kind === 'postgres') {
    const url = await context.secrets.get('postgresUrl')
    if (!url) throw new Error('Keine PostgreSQL-URL hinterlegt (Plugin-Einstellungen).')
    const wrapped = readOnly ? `BEGIN TRANSACTION READ ONLY; ${sql.replace(/;\s*$/, '')}; COMMIT;` : sql
    const results = (await postgres.query(url, wrapped)).filter((result) => !/^(BEGIN|COMMIT)$/.test(result.command))
    const result = results[results.length - 1] || { columns: [], rows: [], command: 'OK' }
    return { ...result, rows: result.rows.slice(0, limit), truncated: result.rows.length > limit, durationMs: Date.now() - started, readOnly }
  }
  const file = await sqlitePath(context, sqliteFile || config.sqliteFile)
  return { ...runSqlite(file, sql, { readOnly, maxRows: limit }), durationMs: Date.now() - started, readOnly }
}

async function schema(context, overrides = {}) {
  const config = await settings(context)
  const kind = overrides.connection || config.connection
  if (kind === 'postgres') {
    const result = await execute(context, "SELECT table_schema || '.' || table_name, column_name, data_type FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name, ordinal_position", { ...overrides, maxRows: 5000 })
    const tables = new Map()
    for (const [table, column, type] of result.rows) tables.set(table, [...(tables.get(table) || []), `${column} ${type}`])
    return [...tables].map(([name, columns]) => ({ name, columns }))
  }
  const tables = await execute(context, "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name", overrides)
  const result = []
  for (const [name] of tables.rows) {
    const info = await execute(context, `PRAGMA table_info(${JSON.stringify(name)})`, overrides)
    result.push({ name, columns: info.rows.map((row) => `${row[1]} ${row[2]}${row[5] ? ' PK' : ''}`) })
  }
  return result
}

async function findSqliteFiles(context) {
  if (!(await context.project())) return []
  const found = []
  const walk = async (dir, depth) => {
    if (depth > 3 || found.length >= 30) return
    for (const entry of await context.fs.list(dir).catch(() => [])) {
      if (entry.type === 'directory' && !SKIP.has(entry.name)) await walk(entry.path, depth + 1)
      else if (entry.type === 'file' && DB_FILE.test(entry.name)) found.push(entry.path)
    }
  }
  await walk('', 0)
  return found
}

const cell = (value) => (value === null || value === undefined ? 'NULL' : typeof value === 'object' ? (value instanceof Uint8Array ? `<${value.length} Bytes>` : JSON.stringify(value)) : String(value))

function resultView(sql, result, args) {
  if (result.needsConfirmation) {
    return {
      type: 'stack',
      children: [
        { type: 'text', tone: 'warning', text: 'Diese Abfrage kann Daten oder Schema ändern. Sie wird erst nach Bestätigung ausgeführt.' },
        { type: 'code', content: sql, language: 'sql' },
        { type: 'actions', items: [{ label: 'Schreibend ausführen', command: 'query', args: { ...args, confirmed: true }, confirm: 'Die Abfrage verändert möglicherweise Daten. Wirklich ausführen?' }] },
      ],
    }
  }
  const summary = `${result.command ? `${result.command} · ` : ''}${result.rows.length} Zeile(n)${result.truncated ? ' (gekürzt)' : ''} · ${result.durationMs} ms${result.readOnly ? ' · nur lesend' : ''}`
  return {
    type: 'stack',
    children: [{ type: 'text', tone: 'muted', text: summary }, ...(result.columns.length ? [{ type: 'table', columns: result.columns, rows: result.rows.map((row) => ({ cells: row.map(cell) })) }] : [])],
  }
}

module.exports = {
  isReadOnly,
  activate(context) {
    context.views.register('main', async (input) => {
      const config = await settings(context)
      const connection = input.connection || config.connection
      const files = connection === 'sqlite' ? await findSqliteFiles(context) : []
      const sqliteFile = input.sqliteFile || config.sqliteFile || files[0] || ''
      const children = [{ type: 'heading', text: 'Datenbank' }]
      children.push({
        type: 'form',
        fields: [
          { name: 'connection', label: 'Verbindung', type: 'select', options: ['sqlite', 'postgres'], value: connection },
          ...(connection === 'sqlite' ? [{ name: 'sqliteFile', label: 'SQLite-Datei', type: files.length ? 'select' : 'text', options: files, value: sqliteFile, placeholder: 'pfad/zur/datei.db' }] : []),
          { name: 'sql', label: 'SQL', type: 'textarea', value: input.sql || '', placeholder: 'SELECT …' },
        ],
        submit: { label: 'Ausführen', command: 'query' },
      })
      try {
        const tables = await schema(context, { connection, sqliteFile })
        children.push({ type: 'heading', text: `Tabellen (${tables.length})` })
        children.push({
          type: 'table',
          columns: ['Tabelle', 'Spalten'],
          rows: tables.map((table) => ({ cells: [table.name, table.columns.join(', ')], actions: [{ label: 'Anzeigen', command: 'table', args: { table: table.name, connection, sqliteFile } }] })),
        })
        children.push({ type: 'actions', items: [{ label: 'Schema in den Chat', command: 'schemaToChat', args: { connection, sqliteFile }, resultTarget: 'chat' }] })
      } catch (error) {
        children.push({ type: 'text', tone: 'warning', text: error.message })
      }
      return { type: 'stack', children }
    })

    context.commands.register('query', async (args) => {
      const sql = String(args.sql || '').trim()
      if (!sql) throw new Error('Keine Abfrage.')
      const result = await execute(context, sql, { confirmed: args.confirmed === true, connection: args.connection, sqliteFile: args.sqliteFile })
      if (!result.needsConfirmation && !result.readOnly) context.log('info', `write query executed: ${sql.slice(0, 200)}`)
      return { title: 'Ergebnis', view: resultView(sql, result, args) }
    })

    context.commands.register('table', async (args) => {
      const table = String(args.table || '')
      const quoted = table
        .split('.')
        .map((part) => `"${part.replace(/"/g, '""')}"`)
        .join('.')
      const sql = `SELECT * FROM ${quoted} LIMIT 200`
      return { title: table, view: resultView(sql, await execute(context, sql, args), args) }
    })

    context.commands.register('schema', async (args) => ({ view: { type: 'code', content: (await schema(context, args)).map((table) => `${table.name}(${table.columns.join(', ')})`).join('\n') } }))
    context.commands.register('schemaToChat', async (args) => ({ text: `Datenbankschema:\n${(await schema(context, args)).map((table) => `${table.name}(${table.columns.join(', ')})`).join('\n')}`, message: 'Schema in den Chat übernommen.' }))

    context.tools.register('db_schema', async () => (await schema(context)).map((table) => `${table.name}(${table.columns.join(', ')})`).join('\n'))
    context.tools.register('db_query', async (args) => {
      const sql = String(args.sql || '')
      if (!isReadOnly(sql)) throw new Error('Agents may only run read-only queries (SELECT/WITH/EXPLAIN/SHOW/PRAGMA).')
      const result = await execute(context, sql, { maxRows: 100 })
      return { columns: result.columns, rows: result.rows.map((row) => row.map(cell)), truncated: result.truncated }
    })
  },
}
