import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { agentCards, decisions, stageInfo } from './leitstand'
import { isWorking } from './workflow'
import { shallowEqual } from './store/core'
import { useLiveState, useSessionState } from './store'
import type { ScheduleForecast, Subtask } from './types'
import { useAgentProfiles } from '../components/agents/AgentProfiles'

/** Ticks every `ms` while `active` (elapsed times, progress estimates). */
export function useNow(active: boolean, ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(timer)
  }, [active, ms])
  return now
}

/**
 * Execution forecast of the task's plan. Reloaded when the plan, an assignment or a status changes
 * (not on every log line), at most every 2 s.
 */
export function useForecast(taskId: string | undefined, subtasks: Subtask[]) {
  const [forecast, setForecast] = useState<ScheduleForecast>()
  const signature = taskId ? taskId + '|' + subtasks.map((entry) => `${entry.key}:${entry.status}:${entry.manualModel ?? ''}:${entry.selectedModelName ?? ''}`).join(',') : ''
  const last = useRef(0)
  useEffect(() => {
    if (!taskId || !subtasks.length) {
      setForecast(undefined)
      return
    }
    let cancelled = false
    const wait = Math.max(0, 2000 - (Date.now() - last.current))
    const timer = window.setTimeout(() => {
      last.current = Date.now()
      void api
        .get<ScheduleForecast>(`/tasks/${taskId}/forecast`)
        .then((result) => !cancelled && setForecast(result))
        .catch(() => undefined)
    }, wait)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])
  return subtasks.length ? forecast : undefined
}

/** Everything the Leitstand shows, derived from the active session's task and run. */
export function useLeitstand() {
  const { task, execution: selected, events, selectedSubtaskId } = useSessionState((state) => ({ task: state.task, execution: state.execution, events: state.events, selectedSubtaskId: state.selectedSubtaskId }), shallowEqual)
  const execution = selected && selected.taskId === task?.id ? selected : undefined
  const live = useLiveState((state) => (execution && state.executionId === execution.id ? state.lines : []), (a, b) => a.length === b.length && a.at(-1) === b.at(-1))
  const stage = stageInfo(task, execution)
  const running = isWorking(stage.state)
  const now = useNow(running)
  const plan = execution?.task?.plans?.[0] ?? task?.plans?.[0]
  const subtasks = useMemo(() => {
    // during a run the run reloads on every run event (newer states); before it the task is current
    const fromRun = execution && ['pending', 'running', 'paused', 'integrating'].includes(execution.status) ? execution.task?.subtasks : undefined
    return fromRun?.length ? fromRun : task?.subtasks ?? []
  }, [task, execution])
  const forecast = useForecast(task?.id, subtasks)
  const profiles = useAgentProfiles().data
  const agentNames = useMemo(() => Object.fromEntries((profiles ?? []).map((profile) => [profile.id, profile.name])), [profiles])
  const cards = useMemo(() => agentCards({ subtasks, plan, runs: execution?.agentRuns, events, live, forecast, now, agentNames }), [subtasks, plan, execution?.agentRuns, events, live, forecast, now, agentNames])
  const decisionList = useMemo(() => decisions({ task, plan, subtasks, events, forecast }), [task, plan, subtasks, events, forecast])
  // a run that ended (failed/cancelled) never starts its waiting tasks: they are "not started"
  const ended = stage.state === 'recoverable' || stage.state === 'cancelled'
  const shown = useMemo(() => (ended ? cards.map((card) => (card.status === 'planned' || card.status === 'queued' ? { ...card, statusLabel: 'nicht gestartet', statusTone: 'faint' as const, waitDetail: undefined, lastLog: card.logs.at(-1)?.text ?? 'nicht gestartet – der Lauf wurde vorher beendet' } : card)) : cards), [cards, ended])
  const selectedCard = shown.find((card) => card.id === selectedSubtaskId) ?? shown.find((card) => card.active) ?? shown[0]
  const elapsedMs = execution?.startedAt ? (execution.finishedAt ? Date.parse(execution.finishedAt) : now) - Date.parse(execution.startedAt) : 0
  return { task, execution, events, plan, subtasks, stage, cards: shown, decisions: decisionList, forecast, selected: selectedCard, now, elapsedMs }
}
