import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, useTempDatabase } from '../test-db.js'
import { findMatches, globMatcher, searchPattern } from './ide.service.js'

const db = useTempDatabase('mac-ide-')
process.env.MAC_DATA_DIR = db.dir
const { PrismaService } = await import('../common/prisma.service.js')
const { applyMigrations } = await import('../runtime/migrator.js')
const { EventBusService } = await import('../runtime/event-bus.service.js')
const { SettingsService } = await import('../runtime/settings.service.js')
const { WorkspaceFsService } = await import('../workspace-fs/workspace-fs.service.js')
const { LocalHistoryService } = await import('./local-history.service.js')
const { IdeService } = await import('./ide.service.js')

const prisma = new PrismaService()
const events = new EventBusService()
const history = new LocalHistoryService()
const files = new WorkspaceFsService(prisma, events, history)
const ide = new IdeService(prisma, events, new SettingsService(prisma, events), files, history, {} as never)
const repo = mkdtempSync(path.join(os.tmpdir(), 'mac-ide-repo-'))
const workerScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/ide/ts-worker.js')
let projectId = ''

const write = (file: string, content: string) => {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  writeFileSync(path.join(repo, file), content)
}

beforeAll(async () => {
  await applyMigrations(prisma, MIGRATIONS_DIR, () => undefined)
  ide.onModuleInit()
  write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', noEmit: true, skipLibCheck: true }, include: ['src'] }))
  write('src/math.ts', 'export function add(a: number, b: number): number {\n  return a + b\n}\n')
  write('src/main.ts', "import { add } from './math'\n\nexport const total = add(1, 2)\nexport const again = add(total, 3)\n")
  write('src/notes.md', 'TODO: add tests\nAnother todo here\n')
  write('ignored/out.txt', 'TODO ignored')
  write('.gitignore', 'ignored/\n')
  execFileSync('git', ['init', '-q'], { cwd: repo })
  projectId = (await prisma.project.create({ data: { name: 'ide', repoPath: repo } })).id
  // Cold start of the TypeScript worker (thread + program, ~2 s alone, >5 s while all test files run
  // in parallel) belongs to the setup; the feature tests below keep the default 5 s limit per call chain.
  await ide.definition(projectId, 'src/main.ts', { line: 3, column: 22 })
}, 60_000)

afterAll(async () => {
  ide.onModuleDestroy()
  await prisma.$disconnect()
  db.cleanup()
})

describe('search helpers', () => {
  it('builds patterns and glob matchers', () => {
    expect(findMatches('a.b axb', searchPattern({ query: 'a.b' }), 10)).toEqual([{ line: 1, column: 1, length: 3, preview: 'a.b axb' }])
    expect(findMatches('a.b axb', searchPattern({ query: 'a.b', regex: true }), 10)).toHaveLength(2)
    expect(findMatches('Todo todo TODO', searchPattern({ query: 'todo', caseSensitive: true }), 10)).toHaveLength(1)
    expect(findMatches('add adder add', searchPattern({ query: 'add', wholeWord: true }), 10).map((match) => match.column)).toEqual([1, 11])
    const include = globMatcher('src/**, *.md')!
    expect(include('src/a/b.ts')).toBe(true)
    expect(include('docs/readme.md')).toBe(true)
    expect(include('lib/x.ts')).toBe(false)
    expect(() => searchPattern({ query: '(', regex: true })).toThrow(/Invalid regular expression/)
  })
})

describe('IdeService', () => {
  it('lists files for quick open (ignored files excluded)', async () => {
    const list = await ide.fileList(projectId)
    expect(list).toEqual(expect.arrayContaining(['src/math.ts', 'src/main.ts', 'tsconfig.json']))
    expect(list).not.toContain('ignored/out.txt')
  })

  it('searches with options and include/exclude filters', async () => {
    const result = await ide.search(projectId, { query: 'todo' })
    expect(result.files.map((file) => file.path)).toEqual(['src/notes.md'])
    expect(result.total).toBe(2)
    expect((await ide.search(projectId, { query: 'add', wholeWord: true, include: 'src/*.ts', exclude: 'main.ts' })).files.map((file) => file.path)).toEqual(['src/math.ts'])
    expect((await ide.search(projectId, { query: 'add\\((\\w+)', regex: true })).total).toBe(3) // add(a, add(1, add(total
  })

  it('replaces in files (regex groups) and keeps the previous version in the local history', async () => {
    const result = await ide.replace(projectId, { query: 'add\\((\\w+), (\\d)\\)', regex: true, replacement: 'add($2, $1)', files: ['src/main.ts'] })
    expect(result.total).toBe(2)
    expect(readFileSync(path.join(repo, 'src/main.ts'), 'utf8')).toContain('add(2, 1)')
    const entries = await ide.historyList(projectId, 'src/main.ts')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.reason).toBe('replace')
    expect((await ide.historyEntry(projectId, 'src/main.ts', entries[0]!.id)).content).toContain('add(1, 2)')
  })

  it('provides definitions, references, rename edits and hover across files', async () => {
    const definition = await ide.definition(projectId, 'src/main.ts', { line: 3, column: 22 })
    expect(definition[0]).toMatchObject({ path: 'src/math.ts', line: 1, column: 17 })
    const references = await ide.references(projectId, 'src/math.ts', { line: 1, column: 17 })
    expect(references.map((reference) => `${reference.path}:${reference.line}`).sort()).toEqual(['src/main.ts:1', 'src/main.ts:3', 'src/main.ts:4', 'src/math.ts:1'])
    const rename = await ide.rename(projectId, 'src/math.ts', { line: 1, column: 17 }, 'sum')
    expect(rename.canRename).toBe(true)
    if (rename.canRename) expect(rename.files.map((file) => `${file.path}:${file.edits.length}`).sort()).toEqual(['src/main.ts:3', 'src/math.ts:1'])
    const hover = await ide.hover(projectId, 'src/main.ts', { line: 3, column: 22 })
    expect(hover?.signature).toContain('add(a: number, b: number): number')
    await expect(ide.rename(projectId, 'src/math.ts', { line: 1, column: 17 }, 'not valid')).rejects.toThrow(/identifier/)
  })

  it('parses TSX as JSX (definition across .tsx files, no parser errors)', async () => {
    write('src/Badge.tsx', 'export function Badge(props: { label: string }) {\n  return <span>{props.label}</span>\n}\n')
    write('src/View.tsx', "import { Badge } from './Badge'\n\nexport const view = (\n  <main>\n    <Badge label=\"beta\" />\n  </main>\n)\n")
    const definition = await ide.definition(projectId, 'src/View.tsx', { line: 5, column: 6 })
    expect(definition[0]).toMatchObject({ path: 'src/Badge.tsx', line: 1 })
    const diagnostics = (await ide.fileDiagnostics(projectId, 'src/View.tsx')).diagnostics
    expect(diagnostics.filter((diagnostic) => [1005, 1109, 1110, 1128].includes(Number(diagnostic.code)))).toEqual([])
  })

  it('reports diagnostics for unsaved content and picks up changes on disk', async () => {
    const unsaved = "import { add } from './math'\nexport const broken: string = add(1, 2)\n"
    const result = await ide.fileDiagnostics(projectId, 'src/main.ts', unsaved)
    expect(result.semantic).toBe(true)
    expect(result.diagnostics.map((diagnostic) => `${diagnostic.line}:${diagnostic.code}`)).toEqual(['2:2322'])
    // back to the saved file: no errors
    expect((await ide.fileDiagnostics(projectId, 'src/main.ts')).diagnostics).toEqual([])
    // a change on disk in another file is seen after the watcher event
    write('src/math.ts', 'export function add(a: number, b: number): string {\n  return String(a + b)\n}\n')
    events.publish('project', 'files_changed', { projectId, files: ['src/math.ts'] }, projectId)
    const after = await ide.fileDiagnostics(projectId, 'src/main.ts')
    expect(after.diagnostics.some((diagnostic) => diagnostic.code === 2345)).toBe(true)
  })

  it.skipIf(!existsSync(workerScript))('runs the language service in a worker thread (compiled worker script)', async () => {
    const { LanguageClient } = await import('./language-client.js')
    const client = new LanguageClient(workerScript)
    expect(client.mode).toBe('worker')
    try {
      const definition = await client.call<Array<{ path: string; line: number }>>(repo, 'definition', ['src/main.ts', { line: 3, column: 22 }])
      expect(definition[0]).toMatchObject({ path: 'src/math.ts', line: 1 })
      await expect(client.call(repo, 'definition', ['src/missing.ts', { line: 1, column: 1 }])).rejects.toThrow(/not part of the TypeScript program/)
      // the worker keeps working after an error
      expect(await client.call(repo, 'info')).toMatchObject({ semantic: true })
    } finally {
      await client.dispose()
    }
  }, 60_000)

  it('reports missing tools instead of failing (format, project check)', async () => {
    expect(await ide.format(projectId, 'src/main.ts', 'x')).toMatchObject({ available: false })
    const check = await ide.check(projectId)
    expect(check).toMatchObject({ tools: [], problems: [], running: false })
    expect(ide.lastCheck(projectId)?.running).toBe(false)
  })
})
