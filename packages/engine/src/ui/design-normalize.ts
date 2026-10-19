import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { git } from '../git/git.js'

/**
 * Deterministic design fixes on what an agent wrote, before validation. Small local models follow the
 * ui-design skill only partly; the mistakes that break the look are mechanical and fixed here exactly:
 * - design tokens used (`var(--accent)`) but defined nowhere: the missing standard tokens are added to
 *   the project's global stylesheet (or the stylesheet that uses them),
 * - a token written as a plain string in a JSX style (`color: '--accent'`): becomes `'var(--accent)'`,
 * - `//` comments in CSS (invalid there, they swallow the next rule): become `/* … *\/`.
 */

/** The ui-design skill's tokens (light values, plus dark values where they differ). */
export const DESIGN_TOKENS: Record<string, { light: string; dark?: string }> = {
  '--bg': { light: '#f7f7f8', dark: '#0b0b0e' },
  '--surface': { light: '#fff', dark: '#131317' },
  '--surface-2': { light: '#f1f1f3', dark: '#1b1b21' },
  '--border': { light: '#e4e4e7', dark: '#26262d' },
  '--text': { light: '#18181b', dark: '#ececf1' },
  '--muted': { light: '#71717a', dark: '#9a9aa6' },
  '--accent': { light: '#4f46e5' },
  '--accent-hover': { light: '#4338ca' },
  '--accent-soft': { light: '#eef2ff', dark: '#1e1b4b' },
  '--ok': { light: '#16a34a' },
  '--warn': { light: '#d97706' },
  '--err': { light: '#dc2626' },
  '--radius': { light: '12px' },
  '--radius-sm': { light: '8px' },
  '--shadow': { light: '0 1px 2px rgb(0 0 0 / .05), 0 1px 3px rgb(0 0 0 / .06)' },
  '--shadow-lg': { light: '0 12px 32px -12px rgb(0 0 0 / .2)' },
  '--font': { light: 'Inter, ui-sans-serif, system-ui, sans-serif' },
}

const STYLE_FILE = /\.(css|scss|sass|less)$/i
const MARKUP_FILE = /\.(tsx|jsx|vue|svelte|html)$/i

/** `//` line comments in a stylesheet become block comments (plain CSS has no line comments). */
export function fixCssLineComments(css: string): string {
  return css.replace(/^([ \t]*)\/\/[ \t]?(.*?)[ \t]*$/gm, (_match, indent: string, text: string) => `${indent}/* ${text.replace(/\*\//g, '* /')} */`)
}

/** Inside `style={{ … }}`: a value that is only a token name (`'--accent'`) becomes `'var(--accent)'`. */
export function fixJsxTokenStrings(source: string): string {
  let result = ''
  let index = 0
  for (;;) {
    const start = source.indexOf('style={{', index)
    if (start < 0) return result + source.slice(index)
    let depth = 0
    let end = start + 'style='.length
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1
      else if (source[end] === '}' && --depth === 0) break
    }
    const block = source.slice(start, end + 1).replace(/(['"`])--([a-zA-Z][\w-]*)\1/g, (_match, quote: string, name: string) => `${quote}var(--${name})${quote}`)
    result += source.slice(index, start) + block
    index = end + 1
  }
}

const usedTokens = (text: string) => new Set([...text.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]!))
const definedTokens = (text: string) => new Set([...text.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/g)].map((match) => match[1]!))

/** A :root block (plus its dark variant) for the given standard tokens. */
export function tokenBlock(names: string[]): string {
  const known = names.filter((name) => DESIGN_TOKENS[name])
  const light = known.map((name) => `  ${name}: ${DESIGN_TOKENS[name]!.light};`).join('\n')
  const darkNames = known.filter((name) => DESIGN_TOKENS[name]!.dark)
  const dark = darkNames.length ? `\n@media (prefers-color-scheme: dark) {\n  :root {\n${darkNames.map((name) => `    ${name}: ${DESIGN_TOKENS[name]!.dark};`).join('\n')}\n  }\n}\n` : ''
  return `/* design tokens (ui-design) */\n:root {\n${light}\n}\n${dark}`
}

/** The stylesheet the app's entry file imports (src/main.tsx → ./index.css), if any. */
async function globalStylesheet(root: string): Promise<string | undefined> {
  for (const entry of ['src/main.tsx', 'src/main.jsx', 'src/main.ts', 'src/main.js', 'src/index.tsx', 'src/index.jsx', 'src/index.ts', 'src/index.js']) {
    const text = await fs.readFile(path.join(root, entry), 'utf8').catch(() => undefined)
    if (text === undefined) continue
    for (const match of text.matchAll(/import\s+(?:[\w{}\s,*]+from\s+)?['"](\.{1,2}\/[^'"]+\.(?:css|scss))['"]/g)) {
      const file = path.posix.normalize(path.posix.join(path.posix.dirname(entry), match[1]!))
      if (existsSync(path.join(root, file))) return file
    }
  }
  return undefined
}

/** Applies the fixes to the uncommitted changes in `root`; returns a description per fixed file. */
export async function normalizeDesign(root: string): Promise<string[]> {
  const status = (await git(root, ['status', '--porcelain', '-uall', '-z'], { allowFailure: true })).stdout.split('\0').filter(Boolean)
  const changed = status.map((entry) => entry.slice(3)).filter((file) => existsSync(path.join(root, file)))
  const notes: string[] = []
  const contents = new Map<string, string>()
  for (const file of changed.filter((entry) => STYLE_FILE.test(entry) || MARKUP_FILE.test(entry))) {
    const text = await fs.readFile(path.join(root, file), 'utf8').catch(() => undefined)
    if (text === undefined || text.length > 512 * 1024) continue
    const fixed = STYLE_FILE.test(file) && !/\.(scss|sass|less)$/i.test(file) ? fixCssLineComments(text) : MARKUP_FILE.test(file) ? fixJsxTokenStrings(text) : text
    if (fixed !== text) {
      await fs.writeFile(path.join(root, file), fixed)
      notes.push(STYLE_FILE.test(file) ? `${file}: CSS-Kommentare korrigiert` : `${file}: Token-Werte als var(--…)`)
    }
    contents.set(file, fixed)
  }
  // tokens the changed files use but the project defines nowhere
  const used = new Set([...contents.values()].flatMap((text) => [...usedTokens(text)]))
  if (!used.size) return notes
  const tracked = (await git(root, ['ls-files', '-co', '--exclude-standard', '-z'], { allowFailure: true })).stdout.split('\0').filter((file) => STYLE_FILE.test(file) || MARKUP_FILE.test(file))
  const defined = new Set<string>()
  for (const file of tracked.slice(0, 2000)) {
    const text = contents.get(file) ?? (await fs.readFile(path.join(root, file), 'utf8').catch(() => ''))
    for (const name of definedTokens(text)) defined.add(name)
  }
  const missing = [...used].filter((name) => !defined.has(name) && DESIGN_TOKENS[name])
  if (!missing.length) return notes
  const target = (await globalStylesheet(root)) ?? changed.find((file) => /\.css$/i.test(file))
  if (!target) return notes
  const current = await fs.readFile(path.join(root, target), 'utf8')
  // after @import/@charset/@tailwind lines, which must stay first
  const lines = current.split('\n')
  let insertAt = 0
  while (insertAt < lines.length && /^\s*(@import|@charset|@tailwind|@use|@forward)\b/.test(lines[insertAt]!)) insertAt += 1
  lines.splice(insertAt, 0, ...(insertAt ? [''] : []), tokenBlock(missing))
  await fs.writeFile(path.join(root, target), lines.join('\n'))
  notes.push(`${target}: fehlende Design-Tokens ergänzt (${missing.join(', ')})`)
  return notes
}
