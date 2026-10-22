import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { SKILL_CATALOG } from '../packages/shared/dist/integration-catalog.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills')
const check = process.argv.includes('--check')
for (const skill of SKILL_CATALOG) {
  const content = [
    '---', `name: ${skill.id}`, `description: ${JSON.stringify(skill.description)}`,
    `triggers: ${JSON.stringify(skill.triggers)}`, 'version: 1.0.0', `tools: ${JSON.stringify(skill.tools)}`,
    `test-task: ${JSON.stringify(skill.testTask)}`, '---', `# ${skill.title}`, '',
    ...skill.steps.map((step, index) => `${index + 1}. ${step}`), '',
    '## Ergebnis', '', skill.output, '',
    '## Werkzeuge', '',
    'Nutze nur die für diese Aufgabe zugewiesenen und freigegebenen Werkzeuge. Fehlt ein benötigtes Werkzeug, benenne die fehlende Integration und den Einrichtungsweg im Integrationskatalog. Erfinde keine Werkzeugergebnisse.', '',
    'Screenshots und Renderbilder können die Premium-Orchestratoren visuell prüfen. Lokale Textmodelle verwenden DOM-, UI-Automation- oder Szeneninformationen und behaupten keine visuelle Prüfung.', '',
  ].join('\n')
  const folder = path.join(root, skill.id)
  const file = path.join(folder, 'SKILL.md')
  if (check) {
    if (readFileSync(file, 'utf8') !== content) throw new Error(`Skill differs from catalog: ${skill.id}`)
  } else {
    mkdirSync(folder, { recursive: true })
    writeFileSync(file, content)
  }
}
console.log(`${SKILL_CATALOG.length} integration skills ${check ? 'verified' : 'written'}.`)
