/** Pure text helpers of the IDE features (no DOM, no Monaco): line diff, fuzzy matching, edits. */

export interface TextRange {
  line: number
  column: number
  endLine?: number
  endColumn?: number
}

export type LineChange = { kind: 'added' | 'modified' | 'deleted'; from: number; to: number }

/** Line changes of `current` against `base` (prefix/suffix trimming + LCS on the middle). */
export function lineChanges(base: string, current: string): LineChange[] {
  const a = base.split(/\r?\n/)
  const b = current.split(/\r?\n/)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1
    endB -= 1
  }
  const middleA = a.slice(start, endA + 1)
  const middleB = b.slice(start, endB + 1)
  if (!middleA.length && !middleB.length) return []
  if (!middleA.length) return [{ kind: 'added', from: start + 1, to: endB + 1 }]
  if (!middleB.length) return [{ kind: 'deleted', from: start + 1, to: start + 1 }]
  // too large for a line LCS: mark the changed block
  if (middleA.length * middleB.length > 4_000_000) return [{ kind: 'modified', from: start + 1, to: endB + 1 }]
  const rows = middleA.length + 1
  const cols = middleB.length + 1
  const table = new Uint32Array(rows * cols)
  for (let i = middleA.length - 1; i >= 0; i -= 1) {
    for (let j = middleB.length - 1; j >= 0; j -= 1) table[i * cols + j] = middleA[i] === middleB[j] ? table[(i + 1) * cols + j + 1]! + 1 : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!)
  }
  const changes: LineChange[] = []
  let i = 0
  let j = 0
  let removed = 0
  let addedFrom = -1
  const flush = () => {
    if (addedFrom >= 0) changes.push({ kind: removed ? 'modified' : 'added', from: start + addedFrom + 1, to: start + j })
    else if (removed) changes.push({ kind: 'deleted', from: start + j + 1, to: start + j + 1 })
    removed = 0
    addedFrom = -1
  }
  while (i < middleA.length || j < middleB.length) {
    if (i < middleA.length && j < middleB.length && middleA[i] === middleB[j]) {
      flush()
      i += 1
      j += 1
    } else if (j < middleB.length && (i >= middleA.length || table[i * cols + j + 1]! >= table[(i + 1) * cols + j]!)) {
      if (addedFrom < 0) addedFrom = j
      j += 1
    } else {
      removed += 1
      i += 1
    }
  }
  flush()
  return changes
}

/** Fuzzy score: all query characters in order; consecutive and word-start matches score higher. */
export function fuzzyScore(text: string, query: string): { score: number; positions: number[] } | undefined {
  if (!query) return { score: 0, positions: [] }
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  const positions: number[] = []
  let score = 0
  let from = 0
  for (const char of needle) {
    const index = haystack.indexOf(char, from)
    if (index < 0) return undefined
    const previous = positions.at(-1)
    score += previous !== undefined && index === previous + 1 ? 6 : 1
    if (index === 0 || '/._- '.includes(text[index - 1] ?? '')) score += 4
    positions.push(index)
    from = index + 1
  }
  // shorter texts and matches in the file name rank first
  const slash = text.lastIndexOf('/')
  if (positions[0]! > slash) score += 8
  return { score: score - text.length * 0.02, positions }
}

/** Applies edits (1-based line/column ranges) to a plain text (files that are not open). */
export function applyEditsToText(text: string, edits: Array<{ range: TextRange; text: string }>) {
  const lineStarts = [0]
  for (let index = 0; index < text.length; index += 1) if (text[index] === '\n') lineStarts.push(index + 1)
  const offset = (line: number, column: number) => (lineStarts[line - 1] ?? text.length) + column - 1
  const sorted = [...edits].sort((a, b) => offset(b.range.line, b.range.column) - offset(a.range.line, a.range.column))
  let result = text
  for (const edit of sorted) result = result.slice(0, offset(edit.range.line, edit.range.column)) + edit.text + result.slice(offset(edit.range.endLine ?? edit.range.line, edit.range.endColumn ?? edit.range.column))
  return result
}
