import type { ConflictHunk } from '@multi-ai-coder/engine'

/**
 * One conflicting region, phrased as a small, exact task (small local models handle a single region
 * with its surroundings well; the whole file would be too much). `feedback`: the checks' failure
 * output of a previous merge attempt of the same conflicts.
 */
export function mergePrompt(hunk: ConflictHunk, feedback?: string): Array<{ role: 'system' | 'user'; content: string }> {
  const block = (text: string) => (text ? text.replace(/\n$/, '') : '(empty)')
  return [
    {
      role: 'system',
      content:
        'You merge one git conflict region. Combine BOTH versions: keep every change of VERSION A (made by the coding agent) and every change of VERSION B (the newer state of the project). ' +
        'If the two versions change the same text in contradicting ways, take the text of VERSION B and add what VERSION A added on top of it. ' +
        'If VERSION A renames or restructures something (e.g. a renamed component or function), apply that change to the lines VERSION B added as well. ' +
        'Answer with the merged region only: no explanation, no code fence, no conflict markers, no lines from the context before or after.',
    },
    {
      role: 'user',
      content: [
        `File: ${hunk.path}`,
        '--- CONTEXT BEFORE (unchanged, do not repeat) ---',
        block(hunk.before),
        '--- ORIGINAL (common base) ---',
        block(hunk.base),
        '--- VERSION A (coding agent) ---',
        block(hunk.agent),
        '--- VERSION B (newer project state) ---',
        block(hunk.current),
        '--- CONTEXT AFTER (unchanged, do not repeat) ---',
        block(hunk.after),
        '--- END ---',
        ...(feedback ? ['A previous merge of these conflicts failed the project checks with this output; produce a merge that avoids it:', feedback, '--- END OF CHECK OUTPUT ---'] : []),
        'Merged region:',
      ].join('\n'),
    },
  ]
}

/**
 * The model's answer as region text: an enclosing code fence is removed, and so is context the model
 * repeated around the region (small models often do, despite the instruction) – but only lines that
 * exactly match the real text before and after the region.
 */
export function cleanMergeAnswer(answer: string, hunk?: Pick<ConflictHunk, 'before' | 'after' | 'base'>): string | undefined {
  let text = answer.replace(/\r\n/g, '\n')
  const fenced = text.trim().match(/^```[\w.+-]*\n([\s\S]*?)\n?```$/)
  if (fenced) text = fenced[1]!
  text = text.replace(/^\s*\n/, '').replace(/\s+$/, '')
  if (text && hunk) text = stripRepeatedContext(text.split('\n'), hunk).join('\n')
  return text ? `${text}\n` : undefined
}

function stripRepeatedContext(lines: string[], hunk: Pick<ConflictHunk, 'before' | 'after' | 'base'>): string[] {
  const contextLines = (text: string) => text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((line, index) => line.trim() === b[index]!.trim())
  // a region that itself starts like the base region is not context
  const baseFirst = hunk.base.split('\n')[0]?.trim()
  const before = hunk.before ? contextLines(hunk.before) : []
  for (let count = Math.min(before.length, lines.length - 1); count > 0; count -= 1) {
    if (same(lines.slice(0, count), before.slice(-count)) && lines[0]?.trim() !== baseFirst) {
      lines = lines.slice(count)
      break
    }
  }
  const after = hunk.after ? contextLines(hunk.after) : []
  for (let count = Math.min(after.length, lines.length - 1); count > 0; count -= 1) {
    if (same(lines.slice(-count), after.slice(0, count))) {
      lines = lines.slice(0, -count)
      break
    }
  }
  return lines
}

const meaningful = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean)

/** Same line, possibly adapted (e.g. a renamed identifier): at least half of the words are shared. */
function similar(a: string, b: string): boolean {
  if (a === b) return true
  const words = (line: string) => new Set(line.match(/[\p{L}\p{N}_]+/gu) ?? [])
  const left = words(a)
  const right = words(b)
  const shared = [...left].filter((word) => right.has(word)).length
  return shared > 0 && shared / new Set([...left, ...right]).size >= 0.5
}

/**
 * Plausibility check of a merged region: a side that only added lines (nothing of the base removed or
 * changed) must find all of them in the result, possibly adapted to the other side's renames –
 * otherwise the model dropped one side's work.
 */
export function acceptMerge(hunk: ConflictHunk, merged: string): boolean {
  const base = new Set(meaningful(hunk.base))
  const result = new Set(meaningful(merged))
  if (!result.size && (meaningful(hunk.agent).length || meaningful(hunk.current).length)) return false
  for (const side of [hunk.agent, hunk.current]) {
    const lines = meaningful(side)
    const sideSet = new Set(lines)
    const onlyAdded = [...base].every((line) => sideSet.has(line))
    if (onlyAdded && lines.some((line) => !base.has(line) && ![...result].some((candidate) => similar(line, candidate)))) return false
  }
  // a model must not repeat the context around the region
  const context = meaningful(`${hunk.before}\n${hunk.after}`).filter((line) => line.length > 3 && !base.has(line))
  return !context.some((line) => result.has(line) && !meaningful(`${hunk.agent}\n${hunk.current}`).includes(line))
}
