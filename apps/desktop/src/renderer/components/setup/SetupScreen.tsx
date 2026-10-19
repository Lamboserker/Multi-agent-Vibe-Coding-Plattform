import { useEffect, useState, type ReactNode } from 'react'
import { Activity, Bot, Cable, ListChecks, Puzzle, Settings, Sparkles, type LucideIcon } from 'lucide-react'
import * as actions from '../../lib/actions'
import { VisibilityContext } from '../../lib/hooks'
import { useAppState } from '../../lib/store'
import type { SetupSection } from '../../lib/stores'
import { AgentProfilesView } from '../agents/AgentProfiles'
import { Onboarding } from '../onboarding/Onboarding'
import { DiagnosticsPanel } from '../panels/DiagnosticsPanel'
import { SettingsPanel } from '../panels/SettingsPanel'
import { McpPanel } from '../mcp/McpPanel'
import { PluginsPanel } from '../plugins/PluginsPanel'
import { SkillsPanel } from '../skills/SkillsPanel'
import { Eyebrow } from '../ui'

const SECTIONS: Array<{ id: SetupSection; label: string; hint: string; icon: LucideIcon; view: () => ReactNode }> = [
  { id: 'onboarding', label: 'Einrichtung', hint: 'Orchestrator, Hardware, lokale KI, Funktionstest', icon: ListChecks, view: () => <Onboarding /> },
  { id: 'settings', label: 'Einstellungen', hint: 'Freigabe, Parallelität, Sicherheit', icon: Settings, view: () => <SettingsPanel /> },
  { id: 'agents', label: 'Agenten', hint: 'Profile mit Modell, Skills und Rechten', icon: Bot, view: () => <AgentProfilesView /> },
  { id: 'plugins', label: 'Erweiterungen', hint: 'Plugins und Integrationen', icon: Puzzle, view: () => <PluginsPanel /> },
  { id: 'skills', label: 'Skills', hint: 'Wissen und Anleitungen für Agenten', icon: Sparkles, view: () => <SkillsPanel /> },
  { id: 'mcp', label: 'MCP-Server', hint: 'Werkzeuge für Orchestrator und Agenten', icon: Cable, view: () => <McpPanel /> },
  { id: 'diagnostics', label: 'Diagnose', hint: 'Laufzeit, Performance, Protokolle', icon: Activity, view: () => <DiagnosticsPanel /> },
]

export function SetupScreen() {
  const section = useAppState((state) => state.ui.setupSection)
  const steps = useAppState((state) => state.settings?.onboarding.steps ?? {})
  const done = Object.values(steps).filter((step) => step.ok).length
  // views stay mounted once opened (forms keep what was typed)
  const [mounted, setMounted] = useState<SetupSection[]>([section])
  useEffect(() => setMounted((current) => (current.includes(section) ? current : [...current, section])), [section])
  return (
    <div className="setup">
      <nav className="setup-nav" aria-label="Setup">
        <Eyebrow style={{ padding: '0 10px 8px' }}>Setup · Einrichtung {Math.min(7, done)}/7</Eyebrow>
        {SECTIONS.map((entry) => (
          <button key={entry.id} className={`setup-link ${section === entry.id ? 'on' : ''}`} aria-label={entry.label} aria-current={section === entry.id ? 'page' : undefined} onClick={() => actions.setSetupSection(entry.id)}>
            <entry.icon size={16} />
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span>{entry.label}</span>
              <span className="faint truncate" style={{ fontSize: 11 }}>{entry.hint}</span>
            </span>
          </button>
        ))}
      </nav>
      <div className="setup-body">
        {SECTIONS.filter((entry) => mounted.includes(entry.id)).map((entry) => (
          <div key={entry.id} className={`setup-view ${entry.id === 'onboarding' ? 'flush' : ''}`} data-view={entry.id} style={{ display: entry.id === section ? 'flex' : 'none' }}>
            <VisibilityContext.Provider value={entry.id === section}>{entry.view()}</VisibilityContext.Provider>
          </div>
        ))}
      </div>
    </div>
  )
}
