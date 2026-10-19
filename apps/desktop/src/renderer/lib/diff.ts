/** Unified diff (git) → files, hunks and numbered lines, for the approval view. */

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'note'
  text: string
  oldLine?: number
  newLine?: number
}

export interface FileDiff {
  path: string
  oldPath?: string
  status: 'added' | 'deleted' | 'modified' | 'renamed'
  binary: boolean
  added: number
  deleted: number
  lines: DiffLine[]
}

const unquote = (value: string) => (value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replace(/\\(["\\])/g, '$1') : value)
const strip = (value: string) => unquote(value.trim()).replace(/^[ab]\//, '')

export function parseUnifiedDiff(diff: string | null | undefined): FileDiff[] {
  const files: FileDiff[] = []
  let file: FileDiff | undefined
  let oldLine = 0
  let newLine = 0
  for (const raw of (diff ?? '').split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(line)
      const path = match ? strip(match[2]!) : line.slice(11)
      file = { path, oldPath: match ? strip(match[1]!) : undefined, status: 'modified', binary: false, added: 0, deleted: 0, lines: [] }
      files.push(file)
      continue
    }
    if (!file) continue
    if (line.startsWith('new file mode')) file.status = 'added'
    else if (line.startsWith('deleted file mode')) file.status = 'deleted'
    else if (line.startsWith('rename from ')) {
      file.status = 'renamed'
      file.oldPath = line.slice(12)
    } else if (line.startsWith('rename to ')) file.path = line.slice(10)
    else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      file.binary = true
      file.lines.push({ kind: 'note', text: 'Binärdatei' })
    } else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      if (line === '--- /dev/null') file.status = 'added'
      if (line === '+++ /dev/null') file.status = 'deleted'
    } else if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      oldLine = match ? Number(match[1]) : 0
      newLine = match ? Number(match[2]) : 0
      file.lines.push({ kind: 'hunk', text: line })
    } else if (line.startsWith('+')) {
      file.added += 1
      file.lines.push({ kind: 'add', text: line.slice(1), newLine: newLine++ })
    } else if (line.startsWith('-')) {
      file.deleted += 1
      file.lines.push({ kind: 'del', text: line.slice(1), oldLine: oldLine++ })
    } else if (line.startsWith(' ')) {
      file.lines.push({ kind: 'ctx', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ })
    } else if (line.startsWith('\\')) file.lines.push({ kind: 'note', text: line.slice(2) })
  }
  return files
}

/** Lines of the new file version that a diff added (1-based), e.g. for agent highlighting. */
export function addedLines(file: FileDiff): number[] {
  return file.lines.filter((line) => line.kind === 'add' && line.newLine !== undefined).map((line) => line.newLine!)
}

export function splitPath(path: string) {
  const index = path.lastIndexOf('/')
  return { dir: index >= 0 ? path.slice(0, index + 1) : '', name: index >= 0 ? path.slice(index + 1) : path }
}
