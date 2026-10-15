import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type * as TS from 'typescript'
import { bundledTypeScript } from '@multi-ai-coder/engine'

type TypeScript = typeof TS

export interface Position {
  line: number
  column: number
}

export interface Span {
  path: string
  line: number
  column: number
  endLine: number
  endColumn: number
}

export interface Diagnostic extends Span {
  severity: 'error' | 'warning' | 'info'
  code: number
  message: string
  source: 'ts'
}

const SOURCE = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/i
const slash = (value: string) => value.replaceAll('\\', '/')

/** The project's own TypeScript (right version and lib files); the bundled one otherwise. */
export function loadTypeScript(root: string): { ts: TypeScript; source: 'project' | 'bundled' } {
  try {
    const projectRequire = createRequire(path.join(root, 'package.json'))
    const resolved = projectRequire.resolve('typescript')
    if (resolved.startsWith(path.resolve(root))) return { ts: projectRequire(resolved) as TypeScript, source: 'project' }
  } catch {
    // not installed in the project
  }
  return { ts: bundledTypeScript as unknown as TypeScript, source: 'bundled' }
}

/**
 * A TypeScript language service over one project: definitions, references, rename, hover and
 * diagnostics across files. Unsaved editor content is applied as an overlay for the file in question.
 */
export class ProjectLanguageService {
  readonly ts: TypeScript
  readonly tsSource: 'project' | 'bundled'
  /** Semantic diagnostics need the lib files; without them only syntax errors are reported. */
  readonly semantic: boolean
  private readonly service: TS.LanguageService
  private readonly fileNames = new Set<string>()
  private readonly versions = new Map<string, number>()
  private readonly overlays = new Map<string, string>()
  private readonly options: TS.CompilerOptions
  lastUsed = Date.now()

  constructor(readonly root: string) {
    const loaded = loadTypeScript(root)
    this.ts = loaded.ts
    this.tsSource = loaded.source
    const ts = this.ts
    const configPath = ts.findConfigFile(root, (file) => ts.sys.fileExists(file), 'tsconfig.json')
    let options: TS.CompilerOptions = { allowJs: true, checkJs: false, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true }
    let files: string[]
    if (configPath && path.resolve(path.dirname(configPath)) === path.resolve(root)) {
      const config = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file))
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
      options = { ...parsed.options, noEmit: true }
      files = parsed.fileNames
    } else {
      files = ts.sys.readDirectory(root, ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'], ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**'], undefined, 8)
    }
    this.options = options
    for (const file of files.slice(0, 5000)) this.fileNames.add(slash(file))
    this.semantic = existsSync(ts.getDefaultLibFilePath(options))
    const host: TS.LanguageServiceHost = {
      getScriptFileNames: () => [...this.fileNames],
      getScriptVersion: (file) => String(this.versions.get(slash(file)) ?? 0),
      getScriptSnapshot: (file) => {
        const text = this.overlays.get(slash(file)) ?? ts.sys.readFile(file)
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
      },
      getCurrentDirectory: () => root,
      getCompilationSettings: () => this.options,
      getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
      fileExists: (file) => this.overlays.has(slash(file)) || ts.sys.fileExists(file),
      readFile: (file) => this.overlays.get(slash(file)) ?? ts.sys.readFile(file),
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    }
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry())
  }

  static supports(file: string) {
    return SOURCE.test(file)
  }

  private absolute(relative: string) {
    return slash(path.resolve(this.root, relative))
  }

  private relative(absolute: string) {
    const rel = slash(path.relative(this.root, absolute))
    return rel.startsWith('..') ? slash(absolute) : rel
  }

  /** Files changed on disk: their next read comes from disk. */
  invalidate(relativeFiles: string[]) {
    for (const file of relativeFiles) {
      const absolute = this.absolute(file)
      if (this.overlays.has(absolute)) continue
      this.versions.set(absolute, (this.versions.get(absolute) ?? 0) + 1)
      if (SOURCE.test(file) && existsSync(absolute) && !absolute.includes('/node_modules/')) this.fileNames.add(absolute)
    }
  }

  /** Unsaved editor content for a file (undefined: use the file on disk again). */
  sync(relative: string, content?: string) {
    this.lastUsed = Date.now()
    const absolute = this.absolute(relative)
    const current = this.overlays.get(absolute)
    if (content === undefined) {
      if (current === undefined) return absolute
      this.overlays.delete(absolute)
    } else {
      if (current === content) return absolute
      this.overlays.set(absolute, content)
    }
    this.versions.set(absolute, (this.versions.get(absolute) ?? 0) + 1)
    this.fileNames.add(absolute)
    return absolute
  }

  private sourceFile(absolute: string) {
    const file = this.service.getProgram()?.getSourceFile(absolute)
    if (!file) throw new Error('The file is not part of the TypeScript program.')
    return file
  }

  private offset(absolute: string, position: Position) {
    const file = this.sourceFile(absolute)
    return this.ts.getPositionOfLineAndCharacter(file, Math.max(0, position.line - 1), Math.max(0, position.column - 1))
  }

  private span(fileName: string, start: number, length: number): Span {
    const file = this.service.getProgram()?.getSourceFile(fileName)
    if (!file) return { path: this.relative(fileName), line: 1, column: 1, endLine: 1, endColumn: 1 }
    const from = file.getLineAndCharacterOfPosition(start)
    const to = file.getLineAndCharacterOfPosition(start + length)
    return { path: this.relative(fileName), line: from.line + 1, column: from.character + 1, endLine: to.line + 1, endColumn: to.character + 1 }
  }

  private lineText(fileName: string, line: number) {
    const file = this.service.getProgram()?.getSourceFile(fileName)
    return file ? (file.text.split(/\r?\n/)[line - 1] ?? '').trim().slice(0, 200) : ''
  }

  definition(relative: string, position: Position, content?: string): Span[] {
    const absolute = this.sync(relative, content)
    const definitions = this.service.getDefinitionAtPosition(absolute, this.offset(absolute, position)) ?? []
    return definitions.map((entry) => this.span(entry.fileName, entry.textSpan.start, entry.textSpan.length))
  }

  references(relative: string, position: Position, content?: string): Array<Span & { preview: string; isDefinition: boolean }> {
    const absolute = this.sync(relative, content)
    const symbols = this.service.findReferences(absolute, this.offset(absolute, position)) ?? []
    const result: Array<Span & { preview: string; isDefinition: boolean }> = []
    for (const symbol of symbols) {
      for (const reference of symbol.references) {
        const span = this.span(reference.fileName, reference.textSpan.start, reference.textSpan.length)
        result.push({ ...span, preview: this.lineText(reference.fileName, span.line), isDefinition: Boolean((reference as { isDefinition?: boolean }).isDefinition) })
      }
    }
    return result.slice(0, 2000)
  }

  /** Edits for renaming the symbol at a position, grouped by file (only files inside the project). */
  rename(relative: string, position: Position, newName: string, content?: string) {
    const absolute = this.sync(relative, content)
    const offset = this.offset(absolute, position)
    const info = this.service.getRenameInfo(absolute, offset, { allowRenameOfImportPath: false })
    if (!info.canRename) return { canRename: false as const, reason: info.localizedErrorMessage }
    const locations = this.service.findRenameLocations(absolute, offset, false, false, { providePrefixAndSuffixTextForRename: false }) ?? []
    const files = new Map<string, Array<Span & { text: string }>>()
    for (const location of locations) {
      const span = this.span(location.fileName, location.textSpan.start, location.textSpan.length)
      if (span.path.startsWith('/') || /^[A-Za-z]:/.test(span.path) || span.path.includes('node_modules/')) continue
      files.set(span.path, [...(files.get(span.path) ?? []), { ...span, text: `${location.prefixText ?? ''}${newName}${location.suffixText ?? ''}` }])
    }
    return { canRename: true as const, displayName: info.displayName, files: [...files].map(([file, edits]) => ({ path: file, edits })) }
  }

  hover(relative: string, position: Position, content?: string) {
    const absolute = this.sync(relative, content)
    const info = this.service.getQuickInfoAtPosition(absolute, this.offset(absolute, position))
    if (!info) return null
    return {
      ...this.span(absolute, info.textSpan.start, info.textSpan.length),
      signature: this.ts.displayPartsToString(info.displayParts),
      documentation: this.ts.displayPartsToString(info.documentation),
    }
  }

  diagnostics(relative: string, content?: string): Diagnostic[] {
    const absolute = this.sync(relative, content)
    const list = [...this.service.getSyntacticDiagnostics(absolute), ...(this.semantic ? this.service.getSemanticDiagnostics(absolute) : [])]
    return list.slice(0, 500).map((diagnostic) => ({
      ...this.span(diagnostic.file?.fileName ?? absolute, diagnostic.start ?? 0, diagnostic.length ?? 0),
      severity: diagnostic.category === this.ts.DiagnosticCategory.Error ? 'error' : diagnostic.category === this.ts.DiagnosticCategory.Warning ? 'warning' : 'info',
      code: diagnostic.code,
      message: this.ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      source: 'ts',
    }))
  }

  dispose() {
    this.service.dispose()
  }
}
