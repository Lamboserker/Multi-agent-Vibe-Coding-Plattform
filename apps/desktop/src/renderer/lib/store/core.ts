import { useCallback, useRef, useSyncExternalStore } from 'react'

/**
 * Minimal external store. State lives outside React, so mounting/unmounting a view never creates or
 * destroys it, and components subscribe to exactly the slice they render (selector + equality).
 */
export interface Store<S> {
  get(): S
  set(update: Partial<S> | ((state: S) => Partial<S>)): void
  subscribe(listener: () => void): () => void
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set(update) {
      const patch = typeof update === 'function' ? update(state) : update
      let changed = false
      for (const key of Object.keys(patch) as Array<keyof S>) {
        if (!Object.is(state[key], patch[key])) {
          changed = true
          break
        }
      }
      if (!changed) return
      state = { ...state, ...patch }
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
  return true
}

/** Subscribes to a derived slice; re-renders only when the slice changes (per `equal`). */
export function useStore<S, T>(store: Store<S>, selector: (state: S) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const cache = useRef<{ state: S; value: T } | undefined>(undefined)
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const getSnapshot = useCallback(() => {
    const state = store.get()
    const previous = cache.current
    const value = selectorRef.current(state)
    if (previous && equal(previous.value, value)) {
      cache.current = { state, value: previous.value }
      return previous.value
    }
    cache.current = { state, value }
    return value
    // equal is expected to be stable (module-level function)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])
  return useSyncExternalStore(store.subscribe, getSnapshot)
}
