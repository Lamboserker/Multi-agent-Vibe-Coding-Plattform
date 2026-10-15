import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import type { RepoIndex } from '../index/repo-index.js'
import { runProcess, sanitizedEnv } from '../util/process.js'

/*
 * Fast path (Phase 0.3, 2.8): requests that are unambiguous and small are handled without premium
 * planning – by a deterministic tool when one exists, otherwise by a single local agent. The
 * orchestrator remains responsible for everything else. Decision rules (all must hold):
 *
 *  Deterministic tool
 *   - "format"            : formatieren / format / prettier + ≥1 named file that exists
 *   - "lint-fix"          : lint/eslint + fix/beheben/korrigieren + ≥1 named file
 *   - "organize-imports"  : importe organisieren/aufräumen/unbenutzte importe + ≥1 named TS/JS file
 *   - "rename"            : "benenne X in Y um" / "rename X to Y" (identifiers) + ≥1 named TS/JS file
 *  Single local agent ("local-single")
 *   - exactly one named, existing file, request ≤ 280 characters, a local model is available
 *     (checked by the planner) and the cost mode is not "quality"
 *   - no security/auth/migration/architecture/multi-step wording
 *  Never fast path: prompts mentioning several files beyond the limits, risky areas, or ≥ 2 sentences
 *  that describe separate goals ("und dann", "außerdem", "and then", "also").
 *
 * Every fast-path result still goes through patch validation, typecheck/tests and user approval.
 */

export type FastPathTool =
  | { kind: 'format'; files: string[] }
  | { kind: 'lint-fix'; files: string[] }
  | { kind: 'organize-imports'; files: string[] }
  | { kind: 'rename'; files: string[]; from: string; to: string }

export type FastPathDecision =
  | { mode: 'tool'; tool: FastPathTool; reason: string; title: string }
  | { mode: 'local-single'; file: string; reason: string }
  | { mode: 'none'; reason: string }

const RISKY = /\b(auth\w*|login|passwor\w*|token|secret|security|sicherheit\w*|encrypt\w*|migration\w*|migrat\w*|schema|architektur\w*|architecture|refactor(?:ing)? (?:the )?(?:whole|entire)|gesamte?n?|alle dateien|all files|database|datenbank)\b/i
const MULTI_GOAL = /\b(und dann|außerdem|zusätzlich|and then|additionally|as well as)\b/i
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const SCRIPT = /\.(m|c)?(t|j)sx?$/i

/** Paths of the repository index named in the prompt (with or without backticks, also by file name). */
export function namedFiles(prompt: string, index: RepoIndex): string[] {
  const known = new Set(index.files.map((file) => file.path))
  const found = new Set<string>()
  for (const match of prompt.matchAll(/[`'"]?([\w@./-]+\.[A-Za-z0-9]{1,8})[`'"]?/g)) {
    const candidate = match[1]!.replace(/^\.\//, '')
    if (known.has(candidate)) found.add(candidate)
    else {
      const byName = index.files.filter((file) => file.path.endsWith(`/${candidate}`) || file.path === candidate)
      if (byName.length === 1) found.add(byName[0]!.path)
    }
  }
  return [...found]
}

export function classifyFastPath(prompt: string, index: RepoIndex): FastPathDecision {
  const text = prompt.trim()
  const files = namedFiles(text, index)
  if (!files.length) return { mode: 'none', reason: 'no existing file is named' }
  if (RISKY.test(text)) return { mode: 'none', reason: 'touches a security, data or architecture area' }
  if (MULTI_GOAL.test(text)) return { mode: 'none', reason: 'describes several goals' }
  if (files.length > 5) return { mode: 'none', reason: 'too many files for the fast path' }

  const rename = text.match(/(?:benenne|rename)\s+(?:die\s+|der\s+|das\s+|the\s+)?(?:variable|funktion|function|konstante|constant|klasse|class|symbol|methode|method|komponente|component|interface|typ|type)?\s*[`'"]?([A-Za-z_$][\w$]*)[`'"]?\s+(?:in|to|zu|nach|into)\s+[`'"]?([A-Za-z_$][\w$]*)[`'"]?/i)
  const scripts = files.filter((file) => SCRIPT.test(file))
  if (rename && IDENTIFIER.test(rename[1]!) && IDENTIFIER.test(rename[2]!) && rename[1] !== rename[2] && scripts.length) {
    return { mode: 'tool', tool: { kind: 'rename', files: scripts, from: rename[1]!, to: rename[2]! }, reason: 'symbol rename via the TypeScript language service', title: `${rename[1]} in ${rename[2]} umbenennen` }
  }
  if (/\b(import\w*)\b/i.test(text) && /\b(organi[sz]\w*|aufräum\w*|sortier\w*|unbenutzt\w*|unused|clean ?up|bereinig\w*)\b/i.test(text) && scripts.length) {
    return { mode: 'tool', tool: { kind: 'organize-imports', files: scripts }, reason: 'organize imports via the TypeScript language service', title: 'Importe organisieren' }
  }
  if (/\b(e?s?lint\w*|linter)\b/i.test(text) && /\b(fix\w*|beheb\w*|korrigier\w*|repar\w*)\b/i.test(text)) {
    return { mode: 'tool', tool: { kind: 'lint-fix', files }, reason: 'eslint --fix of the project', title: 'Lint-Fehler automatisch beheben' }
  }
  if (/\b(formatier\w*|format|prettier)\b/i.test(text) && !/\b(datumsformat|date format|format(?:e|ierung)? (?:des|der|of the) (?:datums|date|output|ausgabe))\b/i.test(text)) {
    return { mode: 'tool', tool: { kind: 'format', files }, reason: 'prettier of the project', title: 'Dateien formatieren' }
  }
  if (files.length === 1 && text.length <= 280) return { mode: 'local-single', file: files[0]!, reason: 'one named file, short and low-risk request' }
  return { mode: 'none', reason: 'not small or not unambiguous enough' }
}

export interface ToolResult {
  ok: boolean
  /** Files the tool changed (relative). */
  changed: string[]
  message: string
}

/** Executable of a project dependency (node_modules/.bin). */
export function localBin(root: string, tool: string): string | undefined {
  const candidate = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${tool}.cmd` : tool)
  return existsSync(candidate) ? candidate : undefined
}

async function snapshot(root: string, files: string[]) {
  return new Map(await Promise.all(files.map(async (file) => [file, await fs.readFile(path.join(root, file), 'utf8').catch(() => '')] as const)))
}

/** Runs a fast-path tool inside a worktree. Never touches files outside `root`. */
export async function runFastPathTool(root: string, tool: FastPathTool, options: { signal?: AbortSignal } = {}): Promise<ToolResult> {
  if (tool.kind === 'format' || tool.kind === 'lint-fix') {
    const binary = localBin(root, tool.kind === 'format' ? 'prettier' : 'eslint')
    if (!binary) return { ok: false, changed: [], message: `${tool.kind === 'format' ? 'prettier' : 'eslint'} is not installed in the project` }
    const before = await snapshot(root, tool.files)
    const args = tool.kind === 'format' ? ['--write', ...tool.files] : ['--fix', ...tool.files]
    const result = await runProcess(binary, args, { cwd: root, env: sanitizedEnv(), timeoutMs: 120_000, signal: options.signal })
    const after = await snapshot(root, tool.files)
    const changed = tool.files.filter((file) => before.get(file) !== after.get(file))
    // eslint exits 1 when unfixable problems remain; the changes it made are still valid
    const ok = !result.spawnError && (result.exitCode === 0 || (tool.kind === 'lint-fix' && result.exitCode === 1))
    return { ok, changed, message: ok ? `${changed.length} file(s) changed` : (result.stderr || result.stdout || String(result.spawnError)).slice(0, 1500) }
  }
  return runLanguageServiceTool(root, tool)
}

/** Language service over the project's TypeScript/JavaScript files (tsconfig when present). */
function createService(root: string) {
  const configPath = ts.findConfigFile(root, (file) => ts.sys.fileExists(file), 'tsconfig.json')
  let fileNames: string[] = []
  let options: ts.CompilerOptions = { allowJs: true, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }
  if (configPath && path.resolve(path.dirname(configPath)) === path.resolve(root)) {
    const config = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file))
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
    fileNames = parsed.fileNames
    options = { ...parsed.options, noEmit: true }
  } else {
    fileNames = ts.sys.readDirectory(root, ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'], ['**/node_modules/**', '**/dist/**', '**/build/**'], undefined, 6)
  }
  const versions = new Map<string, number>()
  const contents = new Map<string, string>()
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => fileNames,
    getScriptVersion: (file) => String(versions.get(file) ?? 0),
    getScriptSnapshot: (file) => {
      const text = contents.get(file) ?? ts.sys.readFile(file)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
    fileExists: (file) => ts.sys.fileExists(file),
    readFile: (file) => contents.get(file) ?? ts.sys.readFile(file),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  }
  return { service: ts.createLanguageService(host, ts.createDocumentRegistry()), fileNames }
}

function applyTextChanges(text: string, changes: readonly ts.TextChange[]): string {
  let result = text
  for (const change of [...changes].sort((a, b) => b.span.start - a.span.start)) result = result.slice(0, change.span.start) + change.newText + result.slice(change.span.start + change.span.length)
  return result
}

async function runLanguageServiceTool(root: string, tool: Extract<FastPathTool, { kind: 'organize-imports' | 'rename' }>): Promise<ToolResult> {
  const { service } = createService(root)
  const edits = new Map<string, ts.TextChange[]>()
  const absolute = (file: string) => path.resolve(root, file).replaceAll('\\', '/')
  if (tool.kind === 'organize-imports') {
    for (const file of tool.files) {
      for (const change of service.organizeImports({ type: 'file', fileName: absolute(file) }, {}, undefined)) edits.set(change.fileName, [...(edits.get(change.fileName) ?? []), ...change.textChanges])
    }
  } else {
    // the declaration of the symbol in one of the named files
    let location: { file: string; position: number } | undefined
    for (const file of tool.files) {
      const program = service.getProgram()
      const source = program?.getSourceFile(absolute(file))
      if (!source) continue
      const visit = (node: ts.Node): void => {
        if (location) return
        if (ts.isIdentifier(node) && node.text === tool.from) {
          const parent = node.parent
          const declaration = (ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isEnumDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isParameter(parent)) && parent.name === node
          if (declaration) location = { file: absolute(file), position: node.getStart(source) }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      if (location) break
    }
    if (!location) return { ok: false, changed: [], message: `no declaration of "${tool.from}" found in ${tool.files.join(', ')}` }
    const info = service.getRenameInfo(location.file, location.position, { allowRenameOfImportPath: false })
    if (!info.canRename) return { ok: false, changed: [], message: info.localizedErrorMessage }
    for (const spot of service.findRenameLocations(location.file, location.position, false, false, { providePrefixAndSuffixTextForRename: false }) ?? []) {
      const newText = `${spot.prefixText ?? ''}${tool.to}${spot.suffixText ?? ''}`
      edits.set(spot.fileName, [...(edits.get(spot.fileName) ?? []), { span: spot.textSpan, newText }])
    }
  }
  const changed: string[] = []
  const rootPrefix = `${path.resolve(root).replaceAll('\\', '/').toLowerCase()}/`
  for (const [fileName, changes] of edits) {
    const normalized = path.resolve(fileName).replaceAll('\\', '/')
    // edits only inside the worktree (never in node_modules or outside)
    if (!normalized.toLowerCase().startsWith(rootPrefix) || normalized.includes('/node_modules/')) continue
    const before = await fs.readFile(normalized, 'utf8')
    const after = applyTextChanges(before, changes)
    if (after === before) continue
    await fs.writeFile(normalized, after, 'utf8')
    changed.push(path.relative(root, normalized).replaceAll('\\', '/'))
  }
  return { ok: true, changed, message: changed.length ? `${changed.length} file(s) changed` : 'nothing to change' }
}

/** The TypeScript compiler bundled with the engine (fallback when a project has none installed). */
export const bundledTypeScript: typeof ts = ts
