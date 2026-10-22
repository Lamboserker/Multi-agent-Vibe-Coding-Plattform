import { TASK_CATEGORIES } from '../orchestrator/schemas.js'
import type { DesignBrief, DesignComponent, DesignToken } from '../orchestrator/types.js'

const GROUP_ORDER: DesignToken['group'][] = ['color', 'typography', 'spacing', 'radius', 'shadow', 'motion']
const UI_CATEGORIES: readonly string[] = (['react-ui', 'styling', 'frontend-logic'] as const).filter((category) => TASK_CATEGORIES.includes(category))
const UI_FILE = /\.(tsx|jsx|vue|svelte|html|css|scss)$/i

/** Tokens as `:root` CSS (plus a dark-mode block for tokens with a dark value), grouped and in a deterministic order. */
export function tokensCss(tokens: DesignToken[]): string {
  const ordered = GROUP_ORDER.flatMap((group) => tokens.filter((token) => token.group === group).sort((a, b) => a.name.localeCompare(b.name)))
  const light: string[] = []
  let current = ''
  for (const token of ordered) {
    if (token.group !== current) {
      current = token.group
      light.push(`  /* ${current} */`)
    }
    light.push(`  ${token.name}: ${token.value};`)
  }
  const dark = ordered.filter((token) => token.darkValue && token.darkValue !== token.value)
  const darkBlock = dark.length ? `\n@media (prefers-color-scheme: dark) {\n  :root {\n${dark.map((token) => `    ${token.name}: ${token.darkValue};`).join('\n')}\n  }\n}` : ''
  return `:root {\n${light.join('\n')}\n}${darkBlock}\n`
}

const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_-]+/).filter(Boolean).map((part) => part.toLowerCase())
/** Whether `text` names `name` in any of PascalCase, kebab-case or spaced form. */
function mentions(text: string, name: string): boolean {
  const parts = words(name)
  if (!parts.length) return false
  const flat = text.toLowerCase()
  return flat.includes(parts.join('-')) || flat.includes(parts.join('')) || flat.includes(parts.join(' '))
}

/** Compact, budgeted design instructions for a UI task; '' for non-UI tasks. */
export function designGuidance(design: DesignBrief, task: { title: string; description?: string; files?: string[]; category?: string }, budget = 3000): string {
  const files = task.files ?? []
  const isUi = (task.category !== undefined && UI_CATEGORIES.includes(task.category)) || files.some((file) => UI_FILE.test(file))
  if (!isUi) return ''
  const text = `${task.title}\n${task.description ?? ''}`
  const normalizedFiles = new Set(files.map((file) => file.replace(/\\/g, '/')))
  const relevant: DesignComponent[] = design.components
    .filter((component) => mentions(text, component.name) || (component.file !== '' && normalizedFiles.has(component.file)))
    .slice(0, 3)
  const screen = design.screens.find((candidate) => mentions(text, candidate.name) || (candidate.route.length > 1 && text.includes(candidate.route)))

  const head = [
    '## Design draft (approved)',
    ...(design.direction ? [`Direction: ${design.direction}`] : []),
    'Use only CSS custom properties from design/tokens.css (var(--…)); design/mockup.html is the visual reference; keep component names.',
  ]
  // optional parts, most relevant first; the first part that does not fit is cut at a line boundary and everything after it dropped
  const parts: string[][] = [
    ...relevant.map((component) => [`### ${component.name}${component.file ? ` (${component.file})` : ''}`, ...(component.purpose ? [component.purpose] : []), component.spec]),
    ...(screen ? [[`### Screen ${screen.name}${screen.route ? ` (${screen.route})` : ''}`, screen.layout, `Components: ${screen.components.join(', ')}`]] : []),
    ['### Tokens', ...design.tokens.map((token) => `- ${token.name}: ${token.value}`)],
  ]
  const lines = [...head]
  let size = lines.join('\n').length
  for (const part of parts) {
    const kept: string[] = []
    for (const line of part) {
      if (size + line.length + 1 > budget) break
      kept.push(line)
      size += line.length + 1
    }
    lines.push(...kept)
    if (kept.length < part.length) break
  }
  return lines.join('\n')
}
