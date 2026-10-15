// Read-only inspection of retained E2E profiles and package/source correspondence.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const root = process.cwd()
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const walk = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]) : []
if (process.argv[2] === 'failures') {
  const ids = ['2026-10-13T11-46-00-112Z', '2026-10-13T12-11-51-401Z'].map((stamp) => {
    const report = JSON.parse(fs.readFileSync(path.join(root, `apps/desktop/e2e/results/${stamp}-navigation-run-report.json`)))
    return { stamp, id: report.steps.find((step) => step.name === 'run started').executionId }
  })
  const found = []
  for (const entry of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('mac-e2e-profile-')) continue
    const file = path.join(os.tmpdir(), entry.name, 'multi-ai-coder.db')
    if (!fs.existsSync(file)) continue
    let db
    try {
      db = new DatabaseSync(file, { readOnly: true })
      for (const target of ids) {
        const run = db.prepare('SELECT * FROM ExecutionRun WHERE id = ?').get(target.id)
        if (!run) continue
        const project = db.prepare('SELECT name, repoPath FROM Project WHERE id = ?').get(run.projectId)
        const tasks = db.prepare('SELECT * FROM Subtask WHERE taskId = ?').all(run.taskId)
        const task = db.prepare('SELECT * FROM Task WHERE id = ?').get(run.taskId)
        const attempts = db.prepare('SELECT * FROM AgentRun WHERE executionId = ? ORDER BY startedAt').all(target.id)
        const events = db.prepare("SELECT type, message, data FROM RunEvent WHERE executionId = ? AND level IN ('warn','error')").all(target.id)
        found.push({ ...target, database: file, project, task, run, tasks, attempts, events })
      }
    } catch (error) {
      if (!/no such table/.test(error.message)) process.stderr.write(`${entry.name}: ${error.message}\n`)
    } finally { db?.close() }
  }
  console.log(JSON.stringify({ found, missing: ids.filter((target) => !found.some((entry) => entry.id === target.id)) }, null, 2))
} else if (process.argv[2] === 'provenance') {
  const app = path.join(root, 'apps/desktop')
  const packaged = path.join(app, 'release/win-unpacked/resources/app')
  const comparisons = []
  for (const [source, dest] of [['dist/backend', 'backend'], ['dist/main', 'dist/main'], ['dist/preload', 'dist/preload'], ['dist/renderer', 'dist/renderer'], ['plugins', 'plugins'], ['skills', 'skills'], ['prisma/migrations', 'backend/migrations']]) {
    const base = source.startsWith('dist/') ? app : root
    for (const file of walk(path.join(base, source)).filter((file) => !file.endsWith('.map') && !file.includes(`${path.sep}node_modules${path.sep}`))) {
      const target = path.join(packaged, dest, path.relative(path.join(base, source), file))
      comparisons.push({ file: path.relative(root, file), equal: fs.existsSync(target) && sha(file) === sha(target) })
    }
  }
  const sources = []
  const maps = [...walk(path.join(app, 'dist')).filter((file) => file.endsWith('.map')), ...walk(path.join(root, 'packages/engine/dist')).filter((file) => file.endsWith('.map'))]
  for (const mapFile of maps) {
    const map = JSON.parse(fs.readFileSync(mapFile))
    for (let index = 0; index < (map.sources ?? []).length; index++) {
      const file = path.resolve(path.dirname(mapFile), map.sourceRoot ?? '', map.sources[index])
      if (!file.startsWith(root + path.sep) || file.includes(`${path.sep}node_modules${path.sep}`) || !fs.existsSync(file) || map.sourcesContent?.[index] == null) continue
      const current = fs.readFileSync(file, 'utf8')
      sources.push({ file: path.relative(root, file), map: path.relative(root, mapFile), equal: current === map.sourcesContent[index], normalizedEqual: current.replace(/\r\n/g, '\n') === map.sourcesContent[index].replace(/\r\n/g, '\n') })
    }
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), build: JSON.parse(fs.readFileSync(path.join(packaged, 'build-info.json'))), artifactFiles: comparisons.length, artifactMismatches: comparisons.filter((entry) => !entry.equal), mappedSources: sources.length, mappedSourceMismatches: sources.filter((entry) => !entry.normalizedEqual), mappedSourceFiles: [...new Set(sources.map((entry) => entry.file))] }, null, 2))
} else if (process.argv[2] === 'live') {
  const dir = path.join(os.homedir(), '.codex/sessions/2026/10/13')
  const matches = []
  for (const file of walk(dir).filter((file) => file.endsWith('.jsonl'))) {
    if (!file.includes('14-59-11-01a13558-727b') && !file.includes('14-51-42-01a13551-9a5b')) continue
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      let record
      try { record = JSON.parse(line) } catch { continue }
      const event = record.payload
      if (file.includes('14-59-11') && event?.type === 'token_count') { matches.push({ file, at: record.timestamp, type: 'usage', usage: event.info?.total_token_usage }); continue }
      if (file.includes('14-51-42') && /automatic approval review rejected/.test(line)) {
        matches.push({ file, at: record.timestamp, type: 'prior_rejection', message: JSON.stringify(event?.output ?? event?.message ?? event?.content ?? '').match(/automatic approval review rejected.{0,200}/)?.[0] })
        continue
      }
      if (file.includes('14-59-11') && record.type === 'response_item') {
        if (event?.type === 'custom_tool_call' || event?.type === 'custom_tool_call_output') matches.push({ file, at: record.timestamp, type: event.type, name: event.name, callId: event.call_id, input: event.input, output: event.output })
        if (event?.type === 'message' && event.role === 'user' && /Use your MCP tools/.test(JSON.stringify(event.content))) matches.push({ file, at: record.timestamp, type: 'test_prompt', content: event.content })
        continue
      }
      if (event?.type === 'function_call' && /^mcp__app__(search_tools|call_tool|read_result)$/.test(event.name ?? '')) {
        matches.push({ file, at: record.timestamp, type: event.type, name: event.name, callId: event.call_id, arguments: event.arguments })
        continue
      }
      if (event?.type === 'function_call_output' && matches.some((entry) => entry.file === file && entry.callId === event.call_id)) {
        matches.push({ file, at: record.timestamp, type: event.type, callId: event.call_id, output: event.output })
        continue
      }
      if (record.type === 'session_meta' && file.includes('14-59-11')) { matches.push({ file, at: record.timestamp, type: record.type, cwd: event?.cwd, cliVersion: event?.cli_version }); continue }
      if (!/\[live:codex\]/.test(line) || event?.type === 'custom_tool_call' || record.type === 'token_usage_record' || event?.type === 'patch_apply_end') continue
      const output = typeof event?.output === 'string' ? event.output : typeof event?.message === 'string' ? event.message : ''
      const hit = output.match(/\[live:codex\][^\n]*/)?.[0]
      matches.push({ file, at: record.timestamp, type: record.type, payloadType: event?.type, keys: Object.keys(event ?? {}), callId: event?.call_id, hit, tail: output.slice(-1800) })
    }
  }
  console.log(JSON.stringify({ sourceSha256: [...new Set(matches.map((entry) => entry.file))].map((file) => ({ file, sha256: sha(file) })), events: matches }, null, 2))
} else throw new Error('Use failures, provenance or live')
