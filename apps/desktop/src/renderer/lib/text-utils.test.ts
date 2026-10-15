import { describe, expect, it } from 'vitest'
import { applyEditsToText, fuzzyScore, lineChanges } from './text-utils'

describe('lineChanges (git gutter)', () => {
  it('detects added, modified and deleted lines', () => {
    expect(lineChanges('a\nb\nc', 'a\nb\nc')).toEqual([])
    expect(lineChanges('a\nb\nc', 'a\nx\nb\nc')).toEqual([{ kind: 'added', from: 2, to: 2 }])
    expect(lineChanges('a\nb\nc', 'a\nB\nc')).toEqual([{ kind: 'modified', from: 2, to: 2 }])
    expect(lineChanges('a\nb\nc', 'a\nc')).toEqual([{ kind: 'deleted', from: 2, to: 2 }])
    expect(lineChanges('a\nb\nc\nd\ne', 'a\nB\nc\nd\ne\nf')).toEqual([
      { kind: 'modified', from: 2, to: 2 },
      { kind: 'added', from: 6, to: 6 },
    ])
    expect(lineChanges('a\r\nb', 'a\nb')).toEqual([])
  })
})

describe('fuzzyScore (quick open)', () => {
  it('matches characters in order and prefers file names and consecutive runs', () => {
    expect(fuzzyScore('src/components/Button.tsx', 'btn')).toBeDefined()
    expect(fuzzyScore('src/components/Button.tsx', 'xyz')).toBeUndefined()
    const fileName = fuzzyScore('src/components/Button.tsx', 'button')!
    const path = fuzzyScore('src/button-utils/index.ts', 'button')!
    expect(fileName.score).toBeGreaterThan(path.score)
    expect(fuzzyScore('abc', 'ac')!.positions).toEqual([0, 2])
  })
})

describe('applyEditsToText (rename/replace in closed files)', () => {
  it('applies several edits with 1-based ranges, last first', () => {
    const text = 'const a = add(1)\nadd(a)\n'
    const edits = [
      { range: { line: 1, column: 11, endLine: 1, endColumn: 14 }, text: 'sum' },
      { range: { line: 2, column: 1, endLine: 2, endColumn: 4 }, text: 'sum' },
    ]
    expect(applyEditsToText(text, edits)).toBe('const a = sum(1)\nsum(a)\n')
  })
})
