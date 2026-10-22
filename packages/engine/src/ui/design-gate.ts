import type { DesignMode } from '../orchestrator/types.js'

// Word-bounded so "ui" does not match "build"/"guide", "app" not "apply"/"happen", "form" not "format"/"platform".
const UI_SUBJECT = /(?<![\p{L}\d])(dashboards?|landing[- ]?pages?|startseite|homepage|websites?|webseite|oberfläche|benutzeroberfläche|ui|frontend|screens?|crm|shop|onlineshop|e-commerce|admin|backoffice|formulare?|portal)(?![\p{L}\d])/iu
// Generic subjects ("app", "seite") only count when the request is not about backend work.
const WEAK_UI_SUBJECT = /(?<![\p{L}\d])(web[- ]?app|apps?|seiten?|ansichten?|forms?|[\p{L}-]+-app)(?![\p{L}\d])/iu
const BACKEND = /(?<![\p{L}\d])(api|rest|graphql|endpoints?|routen?|routes?|backend|server|datenbank|database|migrations?|schema|cli|skript|script|tests?|unit|services?|worker|cron|webhooks?)(?![\p{L}\d])/iu
// Backend requests stay out of the design phase unless they also name something visual.
const VISUAL_WORD = /(?<![\p{L}\d])(design|layout|oberfläche|benutzeroberfläche|ui|frontend|seiten?|ansichten?|screens?|landing[- ]?pages?|startseite|website|webseite)(?![\p{L}\d])/iu
const CREATE_VERB = /(?<![\p{L}\d])(erstelle|erstell|baue|bau|entwirf|entwerfe|gestalte|designe|modernisiere|überarbeite das design|neu gestalten|redesign|create|build|design|make|new|neue|neues|neuen)(?![\p{L}\d])/iu
const SMALL_EDIT = /(?<![\p{L}\d])(fix|bug|fehler|behebe|typo|tippfehler|rename|umbenennen)(?![\p{L}\d])|farbe\s+ändern|change the colou?r/iu
const FILE_PATH = /[\w./-]+\.(?:tsx?|jsx?|css|scss|html|vue|svelte)\b/gi

/** Whether a request should go through the design phase first. `auto` = new/redesigned UI, not a small edit. */
export function shouldDesign(prompt: string, mode: DesignMode = 'auto'): boolean {
  if (mode === 'force') return true
  if (mode === 'skip') return false
  if (SMALL_EDIT.test(prompt)) return false
  if (prompt.length <= 280 && new Set(prompt.match(FILE_PATH)).size === 1) return false
  if (!CREATE_VERB.test(prompt)) return false
  if (BACKEND.test(prompt) && !VISUAL_WORD.test(prompt)) return false
  return UI_SUBJECT.test(prompt) || (WEAK_UI_SUBJECT.test(prompt) && !BACKEND.test(prompt))
}
