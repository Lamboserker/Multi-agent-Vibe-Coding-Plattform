import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTempRepo } from '../test-utils.js'
import { fixCssLineComments, fixJsxTokenStrings, normalizeDesign } from './design-normalize.js'

describe('design normalization', () => {
  it('turns // comments in CSS into block comments, leaves urls alone', () => {
    expect(fixCssLineComments('// src/components/StatCard.css\n.a { background: url(//cdn.example.com/x.png); }\n  // note */\n')).toBe('/* src/components/StatCard.css */\n.a { background: url(//cdn.example.com/x.png); }\n  /* note * / */\n')
  })

  it('makes token names in JSX styles real var() references, nothing outside styles', () => {
    const source = "const id = '--accent'\n<span style={{ color: trend > 0 ? '--accent' : \"--warn\", width: '50%' }}>{trend}%</span>"
    expect(fixJsxTokenStrings(source)).toBe("const id = '--accent'\n<span style={{ color: trend > 0 ? 'var(--accent)' : \"var(--warn)\", width: '50%' }}>{trend}%</span>")
  })

  it('adds the missing standard tokens to the stylesheet the entry imports (the live model output)', async () => {
    const repo = await createTempRepo({
      'src/main.tsx': "import './index.css'\nimport { App } from './App'\n",
      'src/index.css': "@import url('https://fonts.example.com/inter.css');\nbody { margin: 0 }\n",
      'src/App.tsx': 'export const App = () => null\n',
    })
    await fs.mkdir(path.join(repo, 'src', 'components'), { recursive: true })
    // what qwen2.5-coder:7b wrote: own tokens, but --muted and --accent used without a definition
    await fs.writeFile(path.join(repo, 'src', 'components', 'StatCard.css'), '// src/components/StatCard.css\n:root { --stat-card-bg: #fff; }\n.stat-card { background: var(--stat-card-bg); border-radius: var(--radius); }\n.label { color: var(--muted); }\n')
    await fs.writeFile(path.join(repo, 'src', 'components', 'StatCard.tsx'), "import './StatCard.css'\nexport const StatCard = ({ trend }: { trend: number }) => <span style={{ color: trend > 0 ? '--accent' : '--warn' }}>{trend}%</span>\n")

    const notes = await normalizeDesign(repo)
    expect(notes.join('\n')).toMatch(/fehlende Design-Tokens ergänzt \(--radius, --muted, --accent, --warn\)/)
    const global = await fs.readFile(path.join(repo, 'src', 'index.css'), 'utf8')
    expect(global.startsWith("@import url('https://fonts.example.com/inter.css');\n")).toBe(true)
    expect(global).toMatch(/--muted: #71717a;/)
    expect(global).toMatch(/prefers-color-scheme: dark[\s\S]*--muted: #9a9aa6;/)
    expect(global).not.toMatch(/--stat-card-bg|--surface:/)
    expect(await fs.readFile(path.join(repo, 'src', 'components', 'StatCard.css'), 'utf8')).toMatch(/^\/\* src\/components\/StatCard\.css \*\//)
    expect(await fs.readFile(path.join(repo, 'src', 'components', 'StatCard.tsx'), 'utf8')).toContain("'var(--accent)' : 'var(--warn)'")
    // a second run changes nothing
    expect(await normalizeDesign(repo)).toEqual([])
  })

  it('leaves projects alone that define their tokens or use their own names', async () => {
    const repo = await createTempRepo({ 'src/main.tsx': "import './index.css'\n", 'src/index.css': ':root { --muted: gray; }\n' })
    await fs.writeFile(path.join(repo, 'src', 'Card.css'), '.c { color: var(--muted); border-color: var(--brand-line); }\n')
    expect(await normalizeDesign(repo)).toEqual([])
  })
})
