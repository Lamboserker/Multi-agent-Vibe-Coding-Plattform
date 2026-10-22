import { DESIGN_TOKENS } from '../ui/design-normalize.js'
import { renderContext } from './prompts.js'
import type { DesignDraft, DesignInput } from './types.js'

export const DESIGN_SYSTEM_PROMPT = `You are a senior product designer inside Multi-AI Coder, a desktop coding IDE.
You produce a design draft that small local coding models implement component by component, so every component spec is precise and self-contained.
Do not write implementation code beyond the HTML mockup. Respond only with the requested structured output.`

export const MODERN_DESIGN_RULES = `- Modern 2025/26 product aesthetic in the spirit of Linear, Vercel, Stripe and Raycast: calm, dense, precise.
- Neutral zinc/slate base with exactly one accent colour; semantic colours (ok/warn/error) only for status.
- Font stack Inter/Geist/system-ui; display headings with letter-spacing -0.02em; 14px body text; tabular-nums for numbers.
- 8px spacing grid. Whitespace over borders; where borders are needed use 1px hairlines. Soft, low shadows; radius 10–12px.
- Apps: 240px sidebar, content with a max-width. Landing pages: hero with a product mock, bento grid, social proof, one clear primary CTA.
- Every data view has a loading skeleton, an empty state and an error state.
- Light and dark theme via prefers-color-scheme. Accessible contrast (WCAG AA) and visible focus rings.`

export const AVOID_DATED_RULES = `## Avoid dated output
- Bootstrap default blue #0d6efd, gradient buttons, heavy drop shadows.
- Centered card text everywhere, zebra-striped tables, ALL-CAPS headings.
- Emoji as icons, clip-art icons, Arial/Times fonts.
- 2px+ grey borders, jumbotron heroes, stock-photo placeholders, rainbow palettes.`

function clip(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1).trimEnd()}…` : flat
}

/** Compact previous draft so a revision builds on it instead of starting over; capped to keep the prompt small. */
function previousDraft(previous: NonNullable<DesignInput['previous']>): string {
  const lines = [
    previous.summary ? `Previous draft: ${clip(previous.summary, 300)}` : '',
    previous.direction ? `Direction: ${clip(previous.direction, 300)}` : '',
    previous.tokens.length ? `Tokens: ${previous.tokens.slice(0, 40).map((token) => `${token.name}=${clip(token.value, 40)}`).join(', ')}` : '',
    previous.components.length ? `Components: ${previous.components.slice(0, 16).map((component) => `${clip(component.name, 40)} (${component.file || '-'})`).join(', ')}` : '',
    previous.screens.length ? `Screens: ${previous.screens.slice(0, 8).map((screen) => `${clip(screen.name, 40)}: ${screen.components.slice(0, 10).join('+')}`).join('; ')}` : '',
  ].filter(Boolean)
  return `${lines.join('\n').slice(0, 2400)}\n`
}

export function designPrompt(input: DesignInput): string {
  const catalog = (input.skillCatalog ?? []).slice(0, 40).map((skill) => `- ${skill.name}: ${clip(skill.description, 200)}`).join('\n')
  const skills = [catalog, input.skills?.trim()].filter(Boolean).join('\n\n')
  const feedback = input.feedback
    ? `\n# Feedback on the previous draft\n${input.previous ? previousDraft(input.previous) : ''}${input.feedback}\n`
    : ''
  return `Create a design draft for the request below: design tokens, components, screens and a self-contained HTML mockup.

# Request
${input.goal}
${feedback}${skills ? `\n# Design skills\n${skills}\n` : ''}
# Design rules
${MODERN_DESIGN_RULES}${input.provider === 'codex' ? `\n\n${AVOID_DATED_RULES}` : ''}

# Output rules
- "tokens": CSS custom properties are the single source of truth for all visual values. Use the base token names (${Object.keys(DESIGN_TOKENS).join(', ')}) and add more as needed (name \`--kebab-case\`; "darkValue" = dark-mode value, "" = same as light; "group" one of color, typography, spacing, radius, shadow, motion).
- "components": one per reusable UI piece. "file" = suggested repository path matching the project's structure in the context, or "". "spec" (max 600 chars) is precise enough for a small model: markup structure, CSS classes, states, which tokens.
- "screens": name, route, layout, and the component names used.
- "mockupHtml": ONE self-contained HTML document with inline <style>, NO JavaScript, no external URLs, fonts or images (system font stack fallback; inline SVG icons are fine). Realistic German sample data. Light and dark via prefers-color-scheme. At most ~40 kB. Every component root carries data-component="<name>".
- "questions": only genuinely blocking ambiguities, otherwise [].

${renderContext(input.context, 40_000)}`
}

/**
 * Duo mode: the lead merges both designers' drafts into one (same output rules as a fresh draft). Lives here
 * and not in prompts.ts because this module already imports prompts.ts.
 */
export function reconcileDesignPrompt(input: DesignInput, proposals: Array<{ label: string; draft: DesignDraft }>, maxMockupChars = 24_000): string {
  const sections = proposals
    .map((proposal, index) => {
      const { mockupHtml, ...spec } = proposal.draft
      const mockup = mockupHtml.length > maxMockupChars ? `${mockupHtml.slice(0, maxMockupChars)}\n<!-- mockup truncated -->` : mockupHtml
      return `## Draft ${String.fromCharCode(65 + index)} (${proposal.label})\n\`\`\`json\n${JSON.stringify(spec, null, 1).slice(0, 30_000)}\n\`\`\`\nMockup:\n\`\`\`html\n${mockup || '(none)'}\n\`\`\``
    })
    .join('\n\n')
  return `${designPrompt(input)}

# Two independent drafts for this design
Two designers drafted this request independently. Merge them into ONE draft that follows every rule above.

${sections}

# Reconciliation rules
- Choose one coherent visual direction (the stronger draft's); take over the better components, screens and tokens of the other
  draft only where they fit that direction. No duplicate components: keep the more precise spec.
- "mockupHtml": one complete mockup of the merged draft (build on the chosen draft's mockup; same rules as above).
- "questions": only questions neither draft resolves.
- Do not read files: everything you need is above. Return only the structured output.`
}
