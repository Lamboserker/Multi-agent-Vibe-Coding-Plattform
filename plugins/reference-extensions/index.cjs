// Reference implementation of all six extension points. Sandboxed like every plugin: network only to
// local OpenAI-compatible servers, files only inside the project or the directory the app hands to
// the current call (agent worktree), processes only git / package managers / python, no shell.

const MANIFESTS = ['package.json', 'pnpm-workspace.yaml', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile', 'tsconfig.json', 'deno.json', 'Dockerfile', 'compose.yaml', 'docker-compose.yml']

// ---------------------------------------------------------------------------
// OpenAI-compatible local server (model provider + orchestrator)
// ---------------------------------------------------------------------------

async function baseUrl(context) {
  const value = String((await context.settings.get('baseUrl')) || 'http://127.0.0.1:1234/v1').replace(/\/+$/, '')
  const url = new URL(value)
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Nur lokale Server (127.0.0.1/localhost) sind erlaubt.')
  return value
}

async function api(context, path, body, timeoutMs = 600000) {
  const base = await baseUrl(context)
  let response
  try {
    response = await context.http.fetch(`${base}${path}`, body === undefined ? { timeoutMs: 15000 } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs })
  } catch (error) {
    throw new Error(`Lokaler Modellserver ${base} nicht erreichbar (${error instanceof Error ? error.message : String(error)}). LM Studio/llama.cpp-Server starten oder Basis-URL in den Plugin-Einstellungen anpassen.`)
  }
  if (response.status < 200 || response.status >= 300) throw new Error(`Modellserver antwortete mit HTTP ${response.status}: ${response.body.slice(0, 400)}`)
  try {
    return JSON.parse(response.body)
  } catch {
    throw new Error('Modellserver lieferte kein JSON.')
  }
}

async function models(context) {
  const contextTokens = Math.max(1024, Number(await context.settings.get('contextTokens')) || 8192)
  const listed = await api(context, '/models')
  const data = Array.isArray(listed.data) ? listed.data : []
  return data.filter((model) => typeof model.id === 'string').map((model) => ({ id: model.id, contextTokens, toolCalling: false }))
}

function responseFormat(format) {
  if (format && typeof format === 'object') return { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: format } }
  if (format === 'json') return { type: 'json_object' }
  return undefined
}

async function generate(context, input) {
  if (typeof input.model !== 'string' || !Array.isArray(input.messages)) throw new Error('model und messages sind erforderlich.')
  const body = {
    model: input.model,
    messages: input.messages.map((message) => ({ role: ['system', 'user', 'assistant'].includes(message.role) ? message.role : 'user', content: String(message.content ?? '') })),
    stream: false,
  }
  if (Number.isSafeInteger(input.maxTokens) && input.maxTokens > 0) body.max_tokens = input.maxTokens
  const format = responseFormat(input.format)
  if (format) body.response_format = format
  if (input.contextTokens !== undefined) {
    // Conservative byte envelope; the API has no portable native context-window override.
    const envelope = Buffer.byteLength(JSON.stringify(body.messages)) + Buffer.byteLength(JSON.stringify(format || {})) + 256
    if (envelope > input.contextTokens) throw new Error('Kontextlimit: konservative Eingabegrenze überschritten; kein Modellaufruf gestartet.')
  }
  const result = await api(context, '/chat/completions', body)
  const text = result.choices?.[0]?.message?.content
  if (typeof text !== 'string') throw new Error('Modellserver lieferte keine Antwort (choices[0].message.content fehlt).')
  if (input.contextTokens !== undefined && (!Number.isSafeInteger(result.usage?.prompt_tokens) || result.usage.prompt_tokens > input.contextTokens)) throw new Error('Kontextlimit nicht verifizierbar oder überschritten; Antwort verworfen.')
  if (input.maxTokens !== undefined && (!Number.isSafeInteger(result.usage?.completion_tokens) || result.usage.completion_tokens > input.maxTokens)) throw new Error('Ausgabelimit nicht verifizierbar oder überschritten; Antwort verworfen.')
  return { text, inputTokens: result.usage?.prompt_tokens, outputTokens: result.usage?.completion_tokens }
}

async function orchestratorModel(context) {
  const configured = String((await context.settings.get('model')) || '')
  if (configured) return configured
  const available = await models(context)
  if (!available.length) throw new Error('Der lokale Modellserver bietet kein Modell an.')
  return available[0].id
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1))
    throw new Error('Das Modell lieferte kein gültiges JSON.')
  }
}

async function structured(context, system, user, schema) {
  const model = await orchestratorModel(context)
  const { text } = await generate(context, { model, format: schema, messages: [{ role: 'system', content: `${system}\nAntworte ausschließlich mit JSON nach diesem Schema:\n${JSON.stringify(schema)}` }, { role: 'user', content: user }] })
  return parseJson(text)
}

const contextText = (input) => {
  const digest = input.context || {}
  const files = Array.isArray(digest.relevantFiles) ? digest.relevantFiles.map((file) => `- ${file.path || file}`).join('\n') : ''
  return `${digest.summary || ''}${files ? `\nRelevante Dateien:\n${files}` : ''}`.slice(0, 20000)
}

const EDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'files', 'openIssues'],
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } } },
    openIssues: { type: 'array', items: { type: 'string' } },
  },
}

async function execute(context, input) {
  const root = input.cwd
  const sources = []
  for (const file of (input.relevantFiles || []).slice(0, 8)) {
    try {
      sources.push(`### ${file}\n${(await context.fs.read(file, { root })).slice(0, 12000)}`)
    } catch {
      sources.push(`### ${file}\n(neue Datei)`)
    }
  }
  const prompt = [`Aufgabe: ${input.title}`, input.instructions, `Akzeptanzkriterien:\n${(input.acceptanceCriteria || []).map((item) => `- ${item}`).join('\n')}`, input.previousFailures ? `Fehler aus dem letzten Versuch:\n${input.previousFailures}` : '', `Dateien:\n${sources.join('\n\n')}`].filter(Boolean).join('\n\n')
  const result = await structured(context, 'Du bist ein Software-Entwickler. Gib für jede geänderte oder neue Datei den VOLLSTÄNDIGEN neuen Inhalt zurück (projektrelative Pfade).', prompt, EDIT_SCHEMA)
  const changed = []
  for (const file of Array.isArray(result.files) ? result.files : []) {
    if (typeof file.path !== 'string' || typeof file.content !== 'string') continue
    await context.fs.write(file.path, file.content, { root }) // the host confines paths to the worktree
    changed.push(file.path)
  }
  return { summary: String(result.summary || ''), filesChanged: changed, commandsRun: [] }
}

async function orchestrate(context, method, input) {
  if (method === 'chat') {
    const model = await orchestratorModel(context)
    const history = Array.isArray(input.history) ? input.history.slice(-10).map((entry) => ({ role: entry.role === 'assistant' ? 'assistant' : 'user', content: String(entry.content) })) : []
    const { text } = await generate(context, { model, messages: [{ role: 'system', content: `Du beantwortest Fragen zu diesem Repository.\n${contextText(input)}` }, ...history, { role: 'user', content: String(input.question || '') }] })
    return { answer: text }
  }
  if (method === 'execute') return execute(context, input)
  if (method === 'review') {
    const tasks = (input.tasks || []).map((task) => `- ${task.title}: ${task.status} (Tests ${task.testsPassed}/${task.testsPassed + task.testsFailed})`).join('\n')
    return structured(context, 'Du prüfst Code-Änderungen kritisch.', `Ziel: ${input.goal}\nAufgaben:\n${tasks}\nValidierung: ${input.validationSummary}\nDiff:\n${String(input.diff || '').slice(0, 40000)}`, input.schema)
  }
  // plan: "analyze" (task analysis) or "plan" (execution plan)
  const instructions = input.operation === 'analyze' ? 'Analysiere die Aufgabe.' : `Erstelle einen Ausführungsplan mit höchstens ${input.maxTasks || 6} Aufgaben. Kostenmodus: ${input.costMode || 'balanced'}.${input.feedback ? ` Feedback: ${input.feedback}` : ''}`
  return structured(context, `Du bist ein Software-Architekt. ${instructions}`, `Ziel: ${input.goal}\n\nRepository:\n${contextText(input)}`, input.schema)
}

// ---------------------------------------------------------------------------
// Repository analyzer
// ---------------------------------------------------------------------------

async function analyze(context, input) {
  const root = input.project && input.project.repoPath
  const entries = await context.fs.list('', { root })
  const present = MANIFESTS.filter((name) => entries.some((entry) => entry.name === name))
  const lines = []
  const languages = new Set()
  if (present.includes('package.json')) {
    const pkg = JSON.parse(await context.fs.read('package.json', { root }))
    languages.add(present.includes('tsconfig.json') ? 'TypeScript' : 'JavaScript')
    const manager = entries.some((entry) => entry.name === 'pnpm-lock.yaml') ? 'pnpm' : entries.some((entry) => entry.name === 'yarn.lock') ? 'yarn' : 'npm'
    lines.push(`Node-Projekt "${pkg.name || '(ohne Namen)'}" mit ${manager}${pkg.workspaces || present.includes('pnpm-workspace.yaml') ? ' (Workspaces/Monorepo)' : ''}.`)
    const scripts = Object.keys(pkg.scripts || {})
    if (scripts.length) lines.push(`Skripte: ${scripts.slice(0, 20).join(', ')}.`)
    const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })
    if (deps.length) lines.push(`Abhängigkeiten (${deps.length}): ${deps.slice(0, 30).join(', ')}${deps.length > 30 ? ', …' : ''}.`)
  }
  if (present.some((name) => ['pyproject.toml', 'requirements.txt', 'setup.py'].includes(name))) {
    languages.add('Python')
    if (present.includes('requirements.txt')) lines.push(`Python-Abhängigkeiten: ${(await context.fs.read('requirements.txt', { root })).split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#')).slice(0, 30).join(', ')}.`)
  }
  if (present.includes('Cargo.toml')) languages.add('Rust')
  if (present.includes('go.mod')) {
    languages.add('Go')
    const module = /^module\s+(\S+)/m.exec(await context.fs.read('go.mod', { root }))
    if (module) lines.push(`Go-Modul ${module[1]}.`)
  }
  if (present.some((name) => ['pom.xml', 'build.gradle', 'build.gradle.kts'].includes(name))) languages.add('Java/Kotlin')
  if (present.includes('composer.json')) languages.add('PHP')
  if (present.includes('Gemfile')) languages.add('Ruby')
  if (present.some((name) => /docker|compose/i.test(name))) lines.push('Container-Konfiguration vorhanden.')
  const summary = [`Sprachen: ${[...languages].join(', ') || 'unbekannt'}. Manifeste: ${present.join(', ') || 'keine'}.`, ...lines].join('\n')
  return { summary, relevantFiles: present }
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

function countTests(output) {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '')
  let match = /Tests?\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/i.exec(text) // vitest
  if (match) return { passed: Number(match[2]), failed: Number(match[1] || 0) }
  match = /Tests:\s+(?:(\d+)\s+failed,\s+)?(?:\d+\s+skipped,\s+)?(\d+)\s+passed/i.exec(text) // jest
  if (match) return { passed: Number(match[2]), failed: Number(match[1] || 0) }
  const pass = /^(?:#|ℹ)\s+pass (\d+)/m.exec(text) // node:test TAP and spec reporters
  const fail = /^(?:#|ℹ)\s+fail (\d+)/m.exec(text)
  if (pass) return { passed: Number(pass[1]), failed: Number(fail ? fail[1] : 0) }
  const passing = /(\d+) passing/.exec(text) // mocha
  if (passing) return { passed: Number(passing[1]), failed: Number((/(\d+) failing/.exec(text) || [])[1] || 0) }
  const pytestPassed = /(\d+) passed/.exec(text) // pytest
  const pytestFailed = /(\d+) failed/.exec(text)
  if (pytestPassed || pytestFailed) return { passed: Number(pytestPassed ? pytestPassed[1] : 0), failed: Number(pytestFailed ? pytestFailed[1] : 0) }
  return undefined
}

async function runTests(context, input) {
  const root = input.cwd
  const entries = await context.fs.list('', { root })
  const has = (name) => entries.some((entry) => entry.name === name)
  let executable
  let args
  if (has('package.json') && JSON.parse(await context.fs.read('package.json', { root })).scripts?.test) {
    executable = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm'
    args = executable === 'npm' ? ['test', '--silent'] : ['test']
  } else if (has('pyproject.toml') || has('pytest.ini') || has('setup.py')) {
    executable = 'python'
    args = ['-m', 'pytest', '-q']
  } else {
    throw new Error('Kein Test-Skript gefunden (package.json "test" oder pytest).')
  }
  const result = await context.process.run(executable, args, { cwd: root, timeoutMs: 9 * 60000 })
  const output = `${result.stdout}\n${result.stderr}`.trim()
  const counted = countTests(output)
  if (!counted || (counted.passed === 0 && counted.failed === 0)) throw new Error('Testlauf lieferte keine überprüfbaren Testfälle; Erfolg wird nicht angenommen.')
  // a non-zero exit without parsed failures is still a failure
  if (result.exitCode !== 0 && counted.failed === 0) counted.failed = 1
  return { ...counted, output: `$ ${executable} ${args.join(' ')}\n${output}`.slice(-20000) }
}

// ---------------------------------------------------------------------------
// Language integration (JSON)
// ---------------------------------------------------------------------------

/** Offset of the first JSON syntax error (JSON.parse messages do not always carry a position). */
function errorOffset(text) {
  let i = 0
  const fail = () => { throw i }
  const ws = () => { while (i < text.length && ' \t\r\n'.includes(text[i])) i++ }
  const literal = (word) => { if (text.startsWith(word, i)) i += word.length; else fail() }
  const string = () => {
    i++
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i++
      else if (text.charCodeAt(i) < 0x20) fail()
      i++
    }
    if (i >= text.length) fail()
    i++
  }
  const number = () => { const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i)); if (!match) fail(); i += match[0].length }
  const value = () => {
    ws()
    const char = text[i]
    if (char === '{') {
      i++; ws()
      if (text[i] === '}') { i++; return }
      for (;;) { ws(); if (text[i] !== '"') fail(); string(); ws(); if (text[i] !== ':') fail(); i++; value(); ws(); if (text[i] === ',') { i++; continue } if (text[i] === '}') { i++; return } fail() }
    }
    if (char === '[') {
      i++; ws()
      if (text[i] === ']') { i++; return }
      for (;;) { value(); ws(); if (text[i] === ',') { i++; continue } if (text[i] === ']') { i++; return } fail() }
    }
    if (char === '"') return string()
    if (char === 't') return literal('true')
    if (char === 'f') return literal('false')
    if (char === 'n') return literal('null')
    return number()
  }
  try {
    value(); ws()
    return i < text.length ? i : undefined
  } catch (offset) {
    return typeof offset === 'number' ? Math.min(offset, text.length) : 0
  }
}

function position(text, offset) {
  const before = text.slice(0, offset)
  const line = before.split('\n').length
  return { line, column: offset - before.lastIndexOf('\n') }
}

async function language(context, input) {
  const file = String(input.params && input.params.file)
  if (!/\.json$/i.test(file) || /(^|\/)tsconfig[^/]*\.json$/i.test(file)) return { unsupported: true } // tsconfig allows comments
  const args = (input.params && input.params.args) || []
  if (input.method === 'info') return { semantic: false, protocol: 'plugin', language: 'json' }
  if (input.method !== 'diagnostics') return input.method === 'hover' ? null : input.method === 'rename' ? { canRename: false, reason: 'JSON unterstützt kein Umbenennen.' } : []
  const text = typeof args[1] === 'string' ? args[1] : await context.fs.read(file, { root: input.project && input.project.repoPath })
  try {
    JSON.parse(text)
    return []
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const at = position(text, errorOffset(text) ?? text.length)
    // first line of the engine message only (it may quote the document)
    return [{ path: file, line: at.line, column: at.column, endLine: at.line, endColumn: at.column + 1, severity: 'error', code: 'json', message: message.split('\n')[0].replace(/, "\.\.\..*$/, '').slice(0, 200), source: 'json' }]
  }
}

// ---------------------------------------------------------------------------
// Git integration (git CLI)
// ---------------------------------------------------------------------------

async function git(context, root, args) {
  const result = await context.process.run('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, timeoutMs: 30000 })
  return result
}

function parseStatus(output) {
  const entries = []
  const parts = output.split('\0')
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index]
    if (!record || record.length < 4) continue
    const x = record[0]
    const y = record[1]
    const entry = { path: record.slice(3), index: x, worktree: y, untracked: x === '?' && y === '?', conflicted: x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D') }
    if (x === 'R' || x === 'C') entry.originalPath = parts[++index]
    entries.push(entry)
  }
  return entries
}

async function gitRequest(context, input) {
  const root = input.project && input.project.repoPath
  const args = input.args || {}
  if (input.operation === 'status') {
    const inside = await git(context, root, ['rev-parse', '--is-inside-work-tree'])
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return { isRepo: false }
    const [status, branch, head] = await Promise.all([git(context, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']), git(context, root, ['branch', '--show-current']), git(context, root, ['rev-parse', 'HEAD'])])
    if (status.exitCode !== 0) throw new Error(status.stderr.trim() || 'git status fehlgeschlagen.')
    return { isRepo: true, branch: branch.stdout.trim(), head: head.exitCode === 0 ? head.stdout.trim() : '', entries: parseStatus(status.stdout) }
  }
  if (input.operation === 'diff') {
    const diffArgs = ['diff', '--no-color', '--no-ext-diff']
    if (args.staged) diffArgs.push('--cached')
    if (typeof args.file === 'string' && args.file) diffArgs.push('--', args.file)
    return { diff: (await git(context, root, diffArgs)).stdout }
  }
  if (input.operation === 'branches') {
    const result = await git(context, root, ['branch', '--format=%(HEAD)\t%(refname:short)\t%(objectname)'])
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'git branch fehlgeschlagen.')
    return result.stdout.split('\n').filter(Boolean).map((line) => {
      const [current, name, sha] = line.split('\t')
      return { name: name || '', current: current === '*', sha: sha || '' }
    })
  }
  return { unsupported: true }
}

module.exports = {
  activate(context) {
    context.contributions.register('modelProviders', 'openai-compatible', {
      models: () => models(context),
      generate: (input) => generate(context, input),
    })
    context.contributions.register('orchestratorAdapters', 'local-orchestrator', {
      plan: (input) => orchestrate(context, 'plan', input),
      execute: (input) => orchestrate(context, 'execute', input),
      review: (input) => orchestrate(context, 'review', input),
      chat: (input) => orchestrate(context, 'chat', input),
    })
    context.contributions.register('repositoryAnalyzers', 'manifest-analyzer', { analyze: (input) => analyze(context, input) })
    context.contributions.register('testRunners', 'package-tests', { run: (input) => runTests(context, input) })
    context.contributions.register('languageIntegrations', 'json-diagnostics', { request: (input) => language(context, input) })
    context.contributions.register('gitIntegrations', 'git-cli', { request: (input) => gitRequest(context, input) })
  },
  // exported for unit tests of the pure helpers
  _internal: { countTests, parseStatus, responseFormat, errorOffset, position },
}
