import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildRepoIndex } from '../index/repo-index.js'
import { createTempRepo } from '../test-utils.js'
import { classifyFastPath, runFastPathTool } from './fast-path.js'

const FILES = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, module: 'ESNext', moduleResolution: 'Bundler', target: 'ES2022', noEmit: true }, include: ['src'] }),
  'src/math.ts': 'export function addNumbers(a: number, b: number) {\n  return a + b\n}\n',
  'src/use.ts': "import { readFileSync } from 'node:fs'\nimport { addNumbers } from './math'\n\nexport const total = addNumbers(1, 2)\n",
  'src/auth/login.ts': 'export const login = () => true\n',
}

describe('classifyFastPath', () => {
  it('applies the documented decision rules', async () => {
    const index = await buildRepoIndex(await createTempRepo(FILES))
    expect(classifyFastPath('Benenne die Funktion addNumbers in sum um (src/math.ts)', index)).toMatchObject({ mode: 'tool', tool: { kind: 'rename', from: 'addNumbers', to: 'sum', files: ['src/math.ts'] } })
    expect(classifyFastPath('Benenne die Komponente addNumbers in sum um (math.ts)', index)).toMatchObject({ mode: 'tool', tool: { kind: 'rename', from: 'addNumbers' } })
    expect(classifyFastPath('Organisiere die Importe in `src/use.ts`', index)).toMatchObject({ mode: 'tool', tool: { kind: 'organize-imports' } })
    expect(classifyFastPath('Formatiere use.ts', index)).toMatchObject({ mode: 'tool', tool: { kind: 'format', files: ['src/use.ts'] } })
    expect(classifyFastPath('Behebe die ESLint-Fehler in src/use.ts', index)).toMatchObject({ mode: 'tool', tool: { kind: 'lint-fix' } })
    expect(classifyFastPath('Ergänze in src/math.ts eine Funktion multiply', index)).toMatchObject({ mode: 'local-single', file: 'src/math.ts' })
    // never: no named file, risky area, several goals
    expect(classifyFastPath('Füge eine Suchfunktion hinzu', index).mode).toBe('none')
    expect(classifyFastPath('Formatiere src/auth/login.ts und prüfe das Passwort-Hashing', index).mode).toBe('none')
    expect(classifyFastPath('Ergänze multiply in src/math.ts und dann einen Test', index).mode).toBe('none')
  })
})

describe('runFastPathTool', () => {
  it('renames a symbol across the project with the TypeScript language service', async () => {
    const repo = await createTempRepo(FILES)
    const result = await runFastPathTool(repo, { kind: 'rename', files: ['src/math.ts'], from: 'addNumbers', to: 'sum' })
    expect(result.ok).toBe(true)
    expect(result.changed.sort()).toEqual(['src/math.ts', 'src/use.ts'])
    expect(await fs.readFile(path.join(repo, 'src', 'math.ts'), 'utf8')).toContain('export function sum(')
    expect(await fs.readFile(path.join(repo, 'src', 'use.ts'), 'utf8')).toContain("import { sum } from './math'")
  })

  it('removes unused imports', async () => {
    const repo = await createTempRepo(FILES)
    const result = await runFastPathTool(repo, { kind: 'organize-imports', files: ['src/use.ts'] })
    expect(result.changed).toEqual(['src/use.ts'])
    expect(await fs.readFile(path.join(repo, 'src', 'use.ts'), 'utf8')).not.toContain('readFileSync')
  })

  it('reports a missing formatter instead of guessing (the task then falls back to an agent)', async () => {
    const repo = await createTempRepo(FILES)
    expect(await runFastPathTool(repo, { kind: 'format', files: ['src/use.ts'] })).toMatchObject({ ok: false, changed: [] })
  })
})
