/**
 * SKILL.md format: YAML front matter + Markdown instructions, compatible with the common agent-skill
 * layout (a folder per skill; optional `scripts/` and reference files next to SKILL.md).
 *
 *   ---
 *   name: react-testing
 *   description: How this team writes React tests. Use when adding or fixing component tests.
 *   triggers: [test, vitest, testing-library]
 *   ---
 *   # React tests
 *   …
 */
export interface SkillFrontMatter {
  name: string
  description: string
  /** Words that make the skill relevant for a goal (besides its name). */
  triggers: string[]
  version?: string
  tools?: string[]
  allowedActions?: string[]
  resources?: string[]
  testTask?: string
}

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

export class SkillFormatError extends Error {}

function parseValue(raw: string): string | string[] {
  const value = raw.trim()
  if (value.startsWith('[')) {
    try { const parsed = JSON.parse(value); if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed } catch { /* YAML inline list below */ }
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => unquote(item.trim()))
      .filter(Boolean)
  }
  return unquote(value)
}

function unquote(value: string) {
  if (value.startsWith('"')) { try { return JSON.parse(value) as string } catch { /* simple YAML below */ } }
  return (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")) ? value.slice(1, -1) : value
}

/** Parses SKILL.md (a small YAML subset: scalars, inline lists, "- item" lists, ">"/"|" blocks). */
export function parseSkill(text: string): { meta: SkillFrontMatter; body: string } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized)
  if (!match) throw new SkillFormatError('SKILL.md must start with a front matter block (--- … ---).')
  const fields: Record<string, string | string[]> = {}
  const lines = match[1]!.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!field) continue
    const [, key, rest] = field as unknown as [string, string, string]
    if (rest === '' || rest === '|' || rest === '>') {
      // block list or block scalar
      const items: string[] = []
      const text: string[] = []
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1]!)) {
        index += 1
        const inner = lines[index]!.trim()
        if (inner.startsWith('- ') && rest === '') items.push(unquote(inner.slice(2).trim()))
        else text.push(inner)
      }
      fields[key] = items.length ? items : text.join(rest === '|' ? '\n' : ' ')
    } else fields[key] = parseValue(rest)
  }
  const name = typeof fields.name === 'string' ? fields.name.trim() : ''
  const description = typeof fields.description === 'string' ? fields.description.trim() : ''
  if (!SKILL_NAME.test(name)) throw new SkillFormatError('"name" must be lower-case letters, digits and "-" (max. 64).')
  if (!description || description.length > 1024) throw new SkillFormatError('"description" is required (max. 1024 characters).')
  const triggers = fields.triggers ?? fields.keywords
  return {
    meta: {
      name,
      description,
      triggers: (Array.isArray(triggers) ? triggers : typeof triggers === 'string' && triggers ? triggers.split(',') : []).map((item) => item.trim().toLowerCase()).filter(Boolean).slice(0, 30),
      version: typeof fields.version === 'string' ? fields.version : undefined,
      tools: Array.isArray(fields.tools) ? fields.tools : [],
      allowedActions: Array.isArray(fields['allowed-actions']) ? fields['allowed-actions'] : [],
      resources: Array.isArray(fields.resources) ? fields.resources : [],
      testTask: typeof fields['test-task'] === 'string' ? fields['test-task'] : '',
    },
    body: match[2]!.trim(),
  }
}

export function renderSkill(meta: SkillFrontMatter, body: string): string {
  const quote = (value: string) => (/[:#[\]{},"']/.test(value) ? JSON.stringify(value) : value)
  const lines = ['---', `name: ${meta.name}`, `description: ${quote(meta.description.replace(/\s+/g, ' ').trim())}`]
  if (meta.triggers.length) lines.push(`triggers: [${meta.triggers.map(quote).join(', ')}]`)
  if (meta.version) lines.push(`version: ${meta.version}`)
  if (meta.tools?.length) lines.push(`tools: ${JSON.stringify(meta.tools)}`)
  if (meta.allowedActions?.length) lines.push(`allowed-actions: ${JSON.stringify(meta.allowedActions)}`)
  if (meta.resources?.length) lines.push(`resources: ${JSON.stringify(meta.resources)}`)
  if (meta.testTask) lines.push(`test-task: ${JSON.stringify(meta.testTask)}`)
  lines.push('---', '', body.trim(), '')
  return lines.join('\n')
}

/** How strongly a skill matches a goal: trigger words and name parts found in the text. */
export function skillRelevance(meta: SkillFrontMatter, goal: string): number {
  const text = goal.toLowerCase()
  const words = new Set(text.split(/[^\p{L}\p{N}-]+/u).filter(Boolean))
  let score = 0
  for (const trigger of meta.triggers) if (trigger.includes(' ') ? text.includes(trigger) : words.has(trigger)) score += 2
  for (const part of meta.name.split('-')) if (part.length > 3 && words.has(part)) score += 1
  return score
}
