import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { git, isGitRepository, listFiles } from '../git/git.js'
import { isIgnoredPath, isSensitivePath, redactSecrets } from '../security/paths.js'
import { resolveExecutable, runProcess } from '../util/process.js'
import type { RepoContextDigest } from '../orchestrator/types.js'

export interface SymbolInfo {
  name: string
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'method' | 'component' | 'other'
  exported: boolean
  line: number
}

export interface FileEntry {
  path: string
  size: number
  mtimeMs: number
  hash: string
  language: string
  lines: number
  symbols: SymbolInfo[]
  imports: string[]
  /** Repo-relative files this file imports (resolved where possible). */
  dependsOn: string[]
}

export interface RepoIndex {
  version: number
  root: string
  builtAt: string
  files: FileEntry[]
  packageJsons: Array<{ path: string; name?: string; scripts: Record<string, string>; dependencies: string[]; type?: string }>
  languages: Record<string, number>
  frameworks: string[]
  packageManager?: string
  isGit: boolean
  stats: { indexedFiles: number; reusedFromCache: number; skippedLarge: number; skippedBinary: number }
}

const INDEX_VERSION = 2
const MAX_INDEXED_FILE_BYTES = 400 * 1024
const MAX_FILES = 20_000

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.cs': 'csharp',
  '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp',
  '.css': 'css', '.scss': 'css', '.sass': 'css', '.less': 'css', '.html': 'html', '.vue': 'vue', '.svelte': 'svelte',
  '.json': 'json', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.md': 'markdown', '.mdx': 'markdown',
  '.prisma': 'prisma', '.sql': 'sql', '.sh': 'shell', '.ps1': 'powershell',
}

const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov', '.wasm', '.exe', '.dll', '.so', '.dylib', '.node', '.jar', '.class', '.lockb', '.db', '.sqlite'])

export function languageOf(file: string): string {
  return LANGUAGE_BY_EXTENSION[path.extname(file).toLowerCase()] ?? 'other'
}

async function candidateFiles(root: string): Promise<{ files: string[]; isGit: boolean }> {
  if (await isGitRepository(root)) {
    try {
      return { files: await listFiles(root), isGit: true }
    } catch {
      // fall back to walking
    }
  }
  const files: string[] = []
  const walk = async (relative: string) => {
    if (files.length >= MAX_FILES) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(path.join(root, relative), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (isIgnoredPath(child)) continue
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile()) files.push(child)
    }
  }
  await walk('')
  return { files, isGit: false }
}

/** Builds (or incrementally refreshes) the deterministic repository index. */
export async function buildRepoIndex(root: string, previous?: RepoIndex): Promise<RepoIndex> {
  const resolvedRoot = path.resolve(root)
  const { files: candidates, isGit } = await candidateFiles(resolvedRoot)
  const previousByPath = new Map((previous?.version === INDEX_VERSION && previous.root === resolvedRoot ? previous.files : []).map((file) => [file.path, file]))
  const entries: FileEntry[] = []
  const stats = { indexedFiles: 0, reusedFromCache: 0, skippedLarge: 0, skippedBinary: 0 }

  for (const relative of candidates.slice(0, MAX_FILES)) {
    if (isIgnoredPath(relative) || isSensitivePath(relative)) continue
    if (BINARY_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
      stats.skippedBinary += 1
      continue
    }
    const absolute = path.join(resolvedRoot, relative)
    let stat: import('node:fs').Stats
    try {
      stat = await fs.stat(absolute)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    if (stat.size > MAX_INDEXED_FILE_BYTES) {
      stats.skippedLarge += 1
      continue
    }
    const cached = previousByPath.get(relative)
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      entries.push(cached)
      stats.reusedFromCache += 1
      continue
    }
    let content: string
    try {
      content = await fs.readFile(absolute, 'utf8')
    } catch {
      continue
    }
    if (content.includes('\0')) {
      stats.skippedBinary += 1
      continue
    }
    const hash = createHash('sha1').update(content).digest('hex')
    if (cached && cached.hash === hash) {
      entries.push({ ...cached, mtimeMs: stat.mtimeMs })
      stats.reusedFromCache += 1
      continue
    }
    const language = languageOf(relative)
    const { symbols, imports } = extractSymbols(relative, content, language)
    entries.push({ path: relative, size: stat.size, mtimeMs: stat.mtimeMs, hash, language, lines: content.split('\n').length, symbols, imports, dependsOn: [] })
    stats.indexedFiles += 1
  }

  const known = new Set(entries.map((entry) => entry.path))
  for (const entry of entries) entry.dependsOn = resolveImports(entry.path, entry.imports, known)

  const packageJsons: RepoIndex['packageJsons'] = []
  for (const entry of entries.filter((file) => path.posix.basename(file.path) === 'package.json').slice(0, 60)) {
    try {
      const json = JSON.parse(await fs.readFile(path.join(resolvedRoot, entry.path), 'utf8')) as {
        name?: string
        type?: string
        scripts?: Record<string, string>
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      packageJsons.push({
        path: entry.path,
        name: json.name,
        type: json.type,
        scripts: json.scripts ?? {},
        dependencies: Object.keys({ ...(json.dependencies ?? {}), ...(json.devDependencies ?? {}) }).sort(),
      })
    } catch {
      // invalid package.json
    }
  }

  const languages: Record<string, number> = {}
  for (const entry of entries) if (entry.language !== 'other') languages[entry.language] = (languages[entry.language] ?? 0) + entry.lines

  return {
    version: INDEX_VERSION,
    root: resolvedRoot,
    builtAt: new Date().toISOString(),
    files: entries,
    packageJsons,
    languages,
    frameworks: detectFrameworks(packageJsons, known),
    packageManager: detectPackageManager(resolvedRoot),
    isGit,
    stats,
  }
}

/** Indexes one file (or reuses the cached entry); undefined = not indexable. */
async function indexFile(root: string, relative: string, cached: FileEntry | undefined, stats: RepoIndex['stats']): Promise<FileEntry | undefined> {
  if (isIgnoredPath(relative) || isSensitivePath(relative)) return undefined
  if (BINARY_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
    stats.skippedBinary += 1
    return undefined
  }
  let stat: import('node:fs').Stats
  try {
    stat = await fs.stat(path.join(root, relative))
  } catch {
    return undefined
  }
  if (!stat.isFile()) return undefined
  if (stat.size > MAX_INDEXED_FILE_BYTES) {
    stats.skippedLarge += 1
    return undefined
  }
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    stats.reusedFromCache += 1
    return cached
  }
  let content: string
  try {
    content = await fs.readFile(path.join(root, relative), 'utf8')
  } catch {
    return undefined
  }
  if (content.includes('\0')) {
    stats.skippedBinary += 1
    return undefined
  }
  const hash = createHash('sha1').update(content).digest('hex')
  if (cached && cached.hash === hash) {
    stats.reusedFromCache += 1
    return { ...cached, mtimeMs: stat.mtimeMs }
  }
  const language = languageOf(relative)
  const { symbols, imports } = extractSymbols(relative, content, language)
  stats.indexedFiles += 1
  return { path: relative, size: stat.size, mtimeMs: stat.mtimeMs, hash, language, lines: content.split('\n').length, symbols, imports, dependsOn: [] }
}

/** Paths among `candidates` that git ignores (one process for the whole batch). */
async function gitIgnored(root: string, candidates: string[]): Promise<Set<string>> {
  if (!candidates.length) return new Set()
  const result = await git(root, ['check-ignore', '--stdin'], { input: candidates.join('\n'), allowFailure: true })
  return new Set(result.stdout.split('\n').map((line) => line.trim().replaceAll('\\', '/')).filter(Boolean))
}

/**
 * Updates an index for a set of changed paths (from a file watcher) without scanning the repository.
 * Directories are expanded (new) or dropped (deleted). Returns the index unchanged when nothing
 * relevant changed. Callers must fall back to buildRepoIndex when the change list is incomplete.
 */
export async function refreshRepoIndex(root: string, previous: RepoIndex, changedPaths: string[]): Promise<RepoIndex> {
  const resolvedRoot = path.resolve(root)
  const byPath = new Map(previous.files.map((file) => [file.path, file]))
  const stats = { indexedFiles: 0, reusedFromCache: 0, skippedLarge: 0, skippedBinary: 0 }
  const queue = [...new Set(changedPaths.map((entry) => entry.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '')))].filter((entry) => entry && !entry.startsWith('.git/') && entry !== '.git' && !isIgnoredPath(entry))
  const files: string[] = []
  let changed = false
  for (const relative of queue) {
    const stat = await fs.stat(path.join(resolvedRoot, relative)).catch(() => undefined)
    if (!stat) {
      // deleted file or directory
      for (const known of [...byPath.keys()]) {
        if (known === relative || known.startsWith(`${relative}/`)) {
          byPath.delete(known)
          changed = true
        }
      }
      continue
    }
    if (stat.isDirectory()) {
      // Existing directories are reported when a child changes (the child is reported too); a new or
      // renamed directory has no indexed children yet and is walked.
      if ([...byPath.keys()].some((known) => known.startsWith(`${relative}/`))) continue
      const walk = async (dir: string) => {
        for (const entry of await fs.readdir(path.join(resolvedRoot, dir), { withFileTypes: true }).catch(() => [])) {
          const child = `${dir}/${entry.name}`
          if (isIgnoredPath(child)) continue
          if (entry.isDirectory()) await walk(child)
          else if (entry.isFile()) files.push(child)
        }
      }
      await walk(relative)
    } else if (stat.isFile()) files.push(relative)
  }
  const ignored = previous.isGit ? await gitIgnored(resolvedRoot, files.filter((file) => !byPath.has(file))) : new Set<string>()
  for (const relative of files) {
    if (ignored.has(relative)) continue
    const cached = byPath.get(relative)
    const entry = await indexFile(resolvedRoot, relative, cached, stats)
    if (entry === cached) continue
    changed = true
    if (entry) byPath.set(relative, entry)
    else byPath.delete(relative)
  }
  if (!changed) return previous
  const entries = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
  const known = new Set(entries.map((entry) => entry.path))
  for (const entry of entries) entry.dependsOn = resolveImports(entry.path, entry.imports, known)
  const packageJsonChanged = files.some((file) => path.posix.basename(file) === 'package.json') || queue.some((entry) => !known.has(entry) && previous.packageJsons.some((pkg) => pkg.path === entry))
  const packageJsons = packageJsonChanged ? await readPackageJsons(resolvedRoot, entries) : previous.packageJsons
  const languages: Record<string, number> = {}
  for (const entry of entries) if (entry.language !== 'other') languages[entry.language] = (languages[entry.language] ?? 0) + entry.lines
  return {
    ...previous,
    builtAt: new Date().toISOString(),
    files: entries,
    packageJsons,
    languages,
    frameworks: detectFrameworks(packageJsons, known),
    stats: { ...stats, reusedFromCache: entries.length - stats.indexedFiles },
  }
}

async function readPackageJsons(root: string, entries: FileEntry[]): Promise<RepoIndex['packageJsons']> {
  const packageJsons: RepoIndex['packageJsons'] = []
  for (const entry of entries.filter((file) => path.posix.basename(file.path) === 'package.json').slice(0, 60)) {
    try {
      const json = JSON.parse(await fs.readFile(path.join(root, entry.path), 'utf8')) as { name?: string; type?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
      packageJsons.push({ path: entry.path, name: json.name, type: json.type, scripts: json.scripts ?? {}, dependencies: Object.keys({ ...(json.dependencies ?? {}), ...(json.devDependencies ?? {}) }).sort() })
    } catch {
      // invalid package.json
    }
  }
  return packageJsons
}

function detectPackageManager(root: string): string | undefined {
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(path.join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(path.join(root, 'bun.lockb')) || existsSync(path.join(root, 'bun.lock'))) return 'bun'
  if (existsSync(path.join(root, 'package-lock.json'))) return 'npm'
  if (existsSync(path.join(root, 'package.json'))) return 'npm'
  return undefined
}

function detectFrameworks(packageJsons: RepoIndex['packageJsons'], files: Set<string>): string[] {
  const deps = new Set(packageJsons.flatMap((pkg) => pkg.dependencies))
  const frameworks: Array<[boolean, string]> = [
    [deps.has('next'), 'Next.js'],
    [deps.has('react'), 'React'],
    [deps.has('vue'), 'Vue'],
    [deps.has('svelte'), 'Svelte'],
    [deps.has('@angular/core'), 'Angular'],
    [deps.has('@nestjs/core'), 'NestJS'],
    [deps.has('express'), 'Express'],
    [deps.has('fastify'), 'Fastify'],
    [deps.has('@prisma/client') || [...files].some((file) => file.endsWith('schema.prisma')), 'Prisma'],
    [deps.has('typeorm'), 'TypeORM'],
    [deps.has('drizzle-orm'), 'Drizzle'],
    [deps.has('electron'), 'Electron'],
    [deps.has('vite'), 'Vite'],
    [deps.has('tailwindcss'), 'Tailwind CSS'],
    [deps.has('vitest'), 'Vitest'],
    [deps.has('jest'), 'Jest'],
    [deps.has('@playwright/test'), 'Playwright'],
    [files.has('requirements.txt') || files.has('pyproject.toml'), 'Python'],
    [files.has('go.mod'), 'Go modules'],
    [files.has('Cargo.toml'), 'Cargo'],
  ]
  return frameworks.filter(([present]) => present).map(([, name]) => name)
}

const SCRIPT_KIND: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS, '.mts': ts.ScriptKind.TS, '.cts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS, '.mjs': ts.ScriptKind.JS, '.cjs': ts.ScriptKind.JS, '.jsx': ts.ScriptKind.JSX,
}

/** Deterministic symbol + import extraction (TypeScript compiler API for JS/TS, regex for others). */
export function extractSymbols(file: string, content: string, language = languageOf(file)): { symbols: SymbolInfo[]; imports: string[] } {
  const extension = path.extname(file).toLowerCase()
  if (extension in SCRIPT_KIND) return extractTsSymbols(file, content, SCRIPT_KIND[extension]!)
  const symbols: SymbolInfo[] = []
  const imports: string[] = []
  const lines = content.split('\n')
  const patterns: Array<[RegExp, SymbolInfo['kind']]> =
    language === 'python'
      ? [[/^(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'function'], [/^class\s+([A-Za-z_]\w*)/, 'class']]
      : language === 'go'
        ? [[/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 'function'], [/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, 'type']]
        : language === 'rust'
          ? [[/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, 'function'], [/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/, 'type']]
          : language === 'prisma'
            ? [[/^model\s+(\w+)/, 'class'], [/^enum\s+(\w+)/, 'enum']]
            : language === 'java' || language === 'csharp' || language === 'kotlin'
              ? [[/^\s*(?:public|internal|private|protected)?\s*(?:abstract\s+|sealed\s+|data\s+)?(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/, 'class']]
              : []
  lines.forEach((line, index) => {
    for (const [pattern, kind] of patterns) {
      const match = line.match(pattern)
      if (match?.[1]) symbols.push({ name: match[1], kind, exported: !match[1].startsWith('_'), line: index + 1 })
    }
    if (language === 'python') {
      const imported = line.match(/^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/)
      if (imported) imports.push(imported[1] ?? imported[2]!)
    }
  })
  return { symbols: symbols.slice(0, 200), imports }
}

function extractTsSymbols(file: string, content: string, kind: ts.ScriptKind): { symbols: SymbolInfo[]; imports: string[] } {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, false, kind)
  const symbols: SymbolInfo[] = []
  const imports: string[] = []
  const isJsx = kind === ts.ScriptKind.TSX || kind === ts.ScriptKind.JSX
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const exported = (node: ts.Node) =>
    Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
  const componentOrFunction = (name: string): SymbolInfo['kind'] => (isJsx && /^[A-Z]/.test(name) ? 'component' : 'function')

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push(statement.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push(statement.moduleSpecifier.text)
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      symbols.push({ name: statement.name.text, kind: componentOrFunction(statement.name.text), exported: exported(statement), line: lineOf(statement) })
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      symbols.push({ name: statement.name.text, kind: 'class', exported: exported(statement), line: lineOf(statement) })
      for (const member of statement.members) {
        if ((ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) && member.name && ts.isIdentifier(member.name)) {
          const isPrivate = ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)
          if (!isPrivate && ts.isMethodDeclaration(member)) symbols.push({ name: `${statement.name.text}.${member.name.text}`, kind: 'method', exported: exported(statement), line: lineOf(member) })
        }
      }
    } else if (ts.isInterfaceDeclaration(statement)) {
      symbols.push({ name: statement.name.text, kind: 'interface', exported: exported(statement), line: lineOf(statement) })
    } else if (ts.isTypeAliasDeclaration(statement)) {
      symbols.push({ name: statement.name.text, kind: 'type', exported: exported(statement), line: lineOf(statement) })
    } else if (ts.isEnumDeclaration(statement)) {
      symbols.push({ name: statement.name.text, kind: 'enum', exported: exported(statement), line: lineOf(statement) })
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue
        const initializer = declaration.initializer
        const isFunction = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        symbols.push({
          name: declaration.name.text,
          kind: isFunction ? componentOrFunction(declaration.name.text) : 'const',
          exported: exported(statement),
          line: lineOf(declaration),
        })
      }
    } else if (ts.isExportAssignment(statement)) {
      symbols.push({ name: 'default', kind: 'other', exported: true, line: lineOf(statement) })
    }
  }
  // dynamic imports / require calls
  const requirePattern = /(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of content.matchAll(requirePattern)) imports.push(match[1]!)
  return { symbols: symbols.slice(0, 200), imports: [...new Set(imports)] }
}

const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '/index.ts', '/index.tsx', '/index.js', '/index.jsx']

export function resolveImports(fromFile: string, imports: string[], known: Set<string>): string[] {
  const resolved = new Set<string>()
  const directory = path.posix.dirname(fromFile)
  for (const specifier of imports) {
    if (!specifier.startsWith('.')) continue
    const base = path.posix.normalize(path.posix.join(directory, specifier))
    const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, '')
    for (const candidate of [base, stripped]) {
      const hit = RESOLVE_EXTENSIONS.map((extension) => candidate + extension).find((option) => known.has(option))
      if (hit) {
        resolved.add(hit)
        break
      }
    }
  }
  return [...resolved]
}

export async function loadIndexCache(cacheFile: string): Promise<RepoIndex | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as RepoIndex
    return parsed.version === INDEX_VERSION ? parsed : undefined
  } catch {
    return undefined
  }
}

export async function saveIndexCache(cacheFile: string, index: RepoIndex): Promise<void> {
  await fs.mkdir(path.dirname(cacheFile), { recursive: true })
  await fs.writeFile(cacheFile, JSON.stringify(index), 'utf8')
}

export interface SearchHit {
  path: string
  line: number
  text: string
}

/** Literal/regex code search (ripgrep when available, JS fallback). Sensitive files never match. */
export async function searchCode(root: string, query: string, options: { maxResults?: number; regex?: boolean; glob?: string } = {}): Promise<SearchHit[]> {
  const maxResults = Math.min(options.maxResults ?? 50, 500)
  if (!query.trim()) return []
  const rg = resolveExecutable('rg')
  if (rg) {
    const args = ['--json', '--max-count', '20', '--max-filesize', '400K', '-S']
    if (!options.regex) args.push('-F')
    for (const exclude of ['!.git', '!node_modules', '!**/node_modules/**', '!dist', '!build', '!.next', '!**/.env*', '!**/*.pem', '!**/*.key']) args.push('-g', exclude)
    if (options.glob) args.push('-g', options.glob)
    args.push('--', query, '.')
    const result = await runProcess(rg, args, { cwd: root, timeoutMs: 20_000, maxOutputBytes: 8 * 1024 * 1024 })
    const hits: SearchHit[] = []
    for (const line of result.stdout.split('\n')) {
      if (hits.length >= maxResults) break
      if (!line.startsWith('{"type":"match"')) continue
      try {
        const event = JSON.parse(line) as { data: { path: { text: string }; line_number: number; lines: { text: string } } }
        const file = event.data.path.text.replace(/^\.[\\/]/, '').replaceAll('\\', '/')
        if (isSensitivePath(file)) continue
        hits.push({ path: file, line: event.data.line_number, text: redactSecrets(event.data.lines.text.trimEnd()).slice(0, 300) })
      } catch {
        // ignore malformed line
      }
    }
    if (result.exitCode === 0 || result.exitCode === 1) return hits
  }
  // Fallback: scan indexed text files
  const index = await buildRepoIndex(root)
  const needle = options.regex ? new RegExp(query, 'i') : undefined
  const hits: SearchHit[] = []
  for (const entry of index.files) {
    if (hits.length >= maxResults) break
    const content = await fs.readFile(path.join(root, entry.path), 'utf8').catch(() => '')
    content.split('\n').forEach((text, lineIndex) => {
      if (hits.length >= maxResults) return
      const matched = needle ? needle.test(text) : text.toLowerCase().includes(query.toLowerCase())
      if (matched) hits.push({ path: entry.path, line: lineIndex + 1, text: redactSecrets(text.trimEnd()).slice(0, 300) })
    })
  }
  return hits
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'add', 'create', 'make', 'implement', 'new', 'use', 'eine', 'einen', 'einer', 'und', 'mit', 'der', 'die', 'das', 'für', 'erstelle', 'implementiere', 'füge', 'hinzu', 'soll', 'neue', 'neuen'])

export function keywords(text: string): string[] {
  return [...new Set(
    text
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9äöüß_-]+/)
      .flatMap((token) => token.split(/[-_]/))
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  )].slice(0, 60)
}

/** Scores files for a goal using path tokens, symbol names and import-graph proximity. */
export function rankFiles(index: RepoIndex, goal: string, explicitFiles: string[] = []): Array<{ path: string; score: number }> {
  const words = keywords(goal)
  const scores = new Map<string, number>()
  for (const entry of index.files) {
    if (['json', 'markdown', 'yaml', 'toml'].includes(entry.language) && !/package\.json$|tsconfig/.test(entry.path)) continue
    const pathTokens = keywords(entry.path)
    let score = 0
    for (const word of words) {
      if (pathTokens.includes(word)) score += 4
      else if (entry.path.toLowerCase().includes(word)) score += 2
      for (const symbol of entry.symbols) {
        const symbolTokens = keywords(symbol.name)
        if (symbolTokens.includes(word)) score += symbol.exported ? 2 : 1
      }
    }
    if (explicitFiles.includes(entry.path)) score += 50
    if (score > 0) scores.set(entry.path, score)
  }
  // Propagate a fraction of the score along the import graph (callers and callees).
  const byPath = new Map(index.files.map((entry) => [entry.path, entry]))
  for (const [file, score] of [...scores.entries()]) {
    for (const dependency of byPath.get(file)?.dependsOn ?? []) scores.set(dependency, (scores.get(dependency) ?? 0) + score * 0.25)
  }
  for (const entry of index.files) {
    const boost = entry.dependsOn.reduce((sum, dependency) => sum + (scores.get(dependency) ?? 0) * 0.15, 0)
    if (boost > 0) scores.set(entry.path, (scores.get(entry.path) ?? 0) + boost)
  }
  return [...scores.entries()].map(([file, score]) => ({ path: file, score })).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
}

export function outlineOf(entry: FileEntry, maxSymbols = 25): string {
  const symbols = entry.symbols.slice(0, maxSymbols).map((symbol) => `${symbol.exported ? 'export ' : ''}${symbol.kind} ${symbol.name} (L${symbol.line})`)
  const deps = entry.dependsOn.length ? `imports: ${entry.dependsOn.slice(0, 8).join(', ')}` : ''
  return [`${entry.language}, ${entry.lines} lines`, ...symbols, deps].filter(Boolean).join('\n')
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function summarizeIndex(index: RepoIndex, validationCommands: string[] = []): string {
  const languageTotal = Object.values(index.languages).reduce((sum, lines) => sum + lines, 0) || 1
  const languages = Object.entries(index.languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([language, lines]) => `${language} ${Math.round((lines / languageTotal) * 100)}%`)
  const directories = new Map<string, number>()
  for (const entry of index.files) {
    const parts = entry.path.split('/')
    const key = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts.length === 2 ? parts[0]! : '.'
    directories.set(key, (directories.get(key) ?? 0) + 1)
  }
  const structure = [...directories.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([dir, count]) => `${dir}/ (${count})`)
  const workspaces = index.packageJsons.filter((pkg) => pkg.path !== 'package.json').map((pkg) => `${pkg.name ?? pkg.path} (${path.posix.dirname(pkg.path)})`)
  const root = index.packageJsons.find((pkg) => pkg.path === 'package.json')
  const tests = index.files.filter((entry) => /\.(test|spec)\.[jt]sx?$|__tests__\//.test(entry.path)).length
  return [
    `Root: ${path.basename(index.root)} (${index.files.length} indexed files${index.isGit ? ', git' : ''})`,
    `Languages: ${languages.join(', ') || 'unknown'}`,
    `Frameworks: ${index.frameworks.join(', ') || 'none detected'}`,
    `Package manager: ${index.packageManager ?? 'none'}${root?.type ? `; module type: ${root.type}` : ''}`,
    workspaces.length ? `Workspace packages: ${workspaces.slice(0, 15).join(', ')}` : '',
    root && Object.keys(root.scripts).length ? `Root scripts: ${Object.keys(root.scripts).join(', ')}` : '',
    `Test files: ${tests}`,
    validationCommands.length ? `Validation: ${validationCommands.join(' | ')}` : '',
    `Structure: ${structure.join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Builds a token-budgeted context digest for a goal: repository summary, outlines of the most
 * relevant files and (budget permitting) short excerpts of the top hits.
 */
export async function buildContextDigest(
  index: RepoIndex,
  goal: string,
  options: {
    budgetTokens?: number
    explicitFiles?: string[]
    validationCommands?: string[]
    maxFiles?: number
    excerptFiles?: number
    excerptChars?: number
    excerptMaxLines?: number
    /** After the ranked files, add files no keyword matched (manifests and configs first) while the budget lasts. */
    fillUnranked?: boolean
  } = {},
): Promise<RepoContextDigest & { tokenEstimate: number; consideredFiles: number }> {
  const budget = options.budgetTokens ?? 6000
  const summary = summarizeIndex(index, options.validationCommands)
  let used = estimateTokens(summary)
  const ranked = rankFiles(index, goal, options.explicitFiles)
  const byPath = new Map(index.files.map((entry) => [entry.path, entry]))
  const relevantFiles: RepoContextDigest['relevantFiles'] = []
  const excerptBudget = options.excerptFiles ?? 3

  const candidates = ranked.map((entry) => entry.path)
  if (options.fillUnranked) {
    const listed = new Set(candidates)
    const manifest = (file: string) => (/(^|\/)(package\.json|[^/]*\.config\.[cm]?[jt]s|tsconfig[^/]*\.json)$/.test(file) ? 0 : 1)
    const rest = index.files
      .filter((entry) => !listed.has(entry.path) && entry.language !== 'other' && (!['json', 'markdown', 'yaml', 'toml'].includes(entry.language) || /(^|\/)(package\.json|tsconfig[^/]*\.json)$/.test(entry.path)))
      .map((entry) => entry.path)
      .sort((a, b) => manifest(a) - manifest(b) || a.localeCompare(b))
    candidates.push(...rest)
  }

  for (const file of candidates.slice(0, options.maxFiles ?? 14)) {
    const entry = byPath.get(file)
    if (!entry) continue
    const outline = outlineOf(entry)
    let excerpt: string | undefined
    let complete = false
    if (relevantFiles.length < excerptBudget && entry.lines <= (options.excerptMaxLines ?? 220)) {
      const content = redactSecrets(await fs.readFile(path.join(index.root, file), 'utf8').catch(() => ''))
      const candidate = content.slice(0, options.excerptChars ?? 3500)
      if (used + estimateTokens(outline + candidate) <= budget) {
        excerpt = candidate
        complete = candidate.length === content.length
      }
    }
    const cost = estimateTokens(outline + (excerpt ?? '')) + 10
    if (used + cost > budget) break
    used += cost
    relevantFiles.push({ path: file, outline, excerpt, ...(complete ? { complete } : {}) })
  }

  return { summary, relevantFiles, validationCommands: options.validationCommands ?? [], tokenEstimate: used, consideredFiles: ranked.length }
}
