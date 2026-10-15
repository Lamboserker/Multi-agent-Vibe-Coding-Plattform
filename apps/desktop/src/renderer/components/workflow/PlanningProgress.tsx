import { useEffect, useState } from 'react'
import { useStore } from '../../lib/store/core'
import { planProgressStore } from '../../lib/stores'
import type { Task } from '../../lib/types'
import { Spinner } from '../common'

const PLANNING_PHASES = {
  queued: 'Wartet auf einen freien Planer …',
  preparing: 'Repository, Modelle und Verbindung werden vorbereitet …',
  context: 'Erweiterungen und Skills werden geladen …',
  planning: 'Plan wird erstellt …',
  saving: 'Plan wird gespeichert und Aufgaben werden zugeordnet …',
}

/** Planning status with elapsed time and what the planner is doing right now (live run events). */
export function PlanningProgress({ task }: { task: Task }) {
  const progress = useStore(planProgressStore, (state) => state.tasks[task.id])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const startedAt = progress?.startedAt ?? Date.parse(task.planning?.startedAt ?? task.createdAt)
  const seconds = Number.isFinite(startedAt) ? Math.max(0, Math.floor((now - startedAt) / 1000)) : undefined
  const phase = progress?.phase ?? task.planning?.phase ?? 'preparing'
  return (
    <div className="msg system stack" data-testid="planning-progress" style={{ gap: 2 }}>
      <div className="row">
        <Spinner /> Planung{seconds !== undefined ? ` · ${seconds} s` : ''}
        {progress?.model ? <span className="muted">· {progress.model}</span> : null}
      </div>
      <div className="muted">{PLANNING_PHASES[phase]}</div>
      {progress?.last ? (
        <div className="muted" style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={progress.last}>
          {progress.steps} Schritt{progress.steps === 1 ? '' : 'e'} · {progress.last}
        </div>
      ) : null}
    </div>
  )
}
