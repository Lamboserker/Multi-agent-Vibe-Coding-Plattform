import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { AppEvent, RuntimeStatus } from '../../shared/bridge'
import { bridge, errorMessage } from './api'
import { useStore } from './store/core'
import { appStore } from './stores'

/** Subscribes to runtime events (run/model/orchestrator/project …). */
export function useAppEvents(handler: (event: AppEvent) => void, deps: unknown[] = []) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    if (!window.mac) return
    return bridge().onEvent((event) => ref.current(event))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

export function useRuntimeStatus(): RuntimeStatus | undefined {
  return useStore(appStore, (state) => state.runtime)
}

/** True while the view is shown. Views stay mounted when hidden (keep-alive), so they can refresh on return. */
export const VisibilityContext = createContext(true)

export function useIsVisible() {
  return useContext(VisibilityContext)
}

/** Loads data and exposes reload/error state. */
export function useLoader<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setData(await loader())
      setError(undefined)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => {
    void reload()
  }, [reload])
  return { data, error, loading, reload, setData }
}

/**
 * Like useLoader, for keep-alive views: loads on first show and reloads when the view becomes visible
 * again after `staleMs` (cached data is shown immediately meanwhile).
 */
export function useVisibleLoader<T>(loader: () => Promise<T>, deps: unknown[] = [], staleMs = 15_000) {
  const visible = useIsVisible()
  const result = useLoader(loader, deps)
  const loadedAt = useRef(Date.now())
  useEffect(() => {
    if (!result.loading) loadedAt.current = Date.now()
  }, [result.loading])
  useEffect(() => {
    if (visible && Date.now() - loadedAt.current > staleMs) void result.reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])
  return result
}

/** Calls fn at most once per `ms` (trailing). */
export function useThrottled(fn: () => void, ms: number) {
  const timer = useRef<number | undefined>(undefined)
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return useCallback(() => {
    if (timer.current !== undefined) return
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      ref.current()
    }, ms)
  }, [ms])
}

export function formatBytes(bytes?: number | null): string {
  if (bytes === undefined || bytes === null) return '–'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

export function formatDuration(ms?: number | null): string {
  if (ms === undefined || ms === null) return '–'
  if (ms < 1000) return `${ms} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`
}

export function formatTokens(value?: number | null): string {
  if (value === undefined || value === null) return '–'
  return value >= 10_000 ? `${(value / 1000).toFixed(1)}k` : String(value)
}

export function since(start?: string | null, end?: string | null): number | undefined {
  if (!start) return undefined
  return (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()
}
