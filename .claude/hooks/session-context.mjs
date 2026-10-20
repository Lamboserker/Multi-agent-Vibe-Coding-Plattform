// SessionStart hook: injects docs/ai/CONTEXT.md and the handoff section of the active task,
// so a session after /clear, a resume or a compaction continues from the documented state.
// Never fails the session: any problem ends silently with exit code 0.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd()
const docs = path.join(root, 'docs', 'ai')

function section(text, heading) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`)
  if (start === -1) return ''
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').replace(/<!--[\s\S]*?-->/g, '').trim()
}

try {
  const contextFile = path.join(docs, 'CONTEXT.md')
  if (!existsSync(contextFile)) process.exit(0)
  const context = readFileSync(contextFile, 'utf8')
  const parts = ['# Projektstand (docs/ai/CONTEXT.md, automatisch geladen)', context.trim()]

  const id = section(context, 'Aktiver Task').match(/TASK-\d{3}/)?.[0]
  const tasksDir = path.join(docs, 'tasks')
  const file = id && existsSync(tasksDir) ? readdirSync(tasksDir).find((name) => name.startsWith(`${id}-`) && name.endsWith('.md')) : undefined
  if (file) {
    const handoff = section(readFileSync(path.join(tasksDir, file), 'utf8'), 'Übergabe')
    parts.push(`# Übergabe des aktiven Tasks (docs/ai/tasks/${file})`, handoff || '(noch leer – Task-File vollständig lesen)')
  }
  parts.push('Vor der Arbeit: docs/ai/lessons.md und das aktive Task-File lesen (oder /weiter). Vor /clear: /handoff.')

  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') } }))
} catch {
  process.exit(0)
}
