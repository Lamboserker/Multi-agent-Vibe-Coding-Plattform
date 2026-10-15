import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react'

/**
 * Windowed list for long, growing lists (run logs, explorer). Only the rows in (and near) the
 * viewport are in the DOM; row heights are measured, so wrapped lines work. With `followTail` the
 * list sticks to the end while the user is at the bottom (like a log), and stays put when they
 * scrolled up to read.
 */
export function VirtualList<T>({
  items,
  estimate,
  itemKey,
  render,
  followTail = false,
  overscanPx = 400,
  className,
  testId,
}: {
  items: readonly T[]
  estimate: number
  itemKey: (item: T, index: number) => string | number
  render: (item: T, index: number) => ReactNode
  followTail?: boolean
  overscanPx?: number
  className?: string
  testId?: string
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const heights = useRef(new Map<string | number, number>())
  const atBottom = useRef(true)
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const [, remeasured] = useReducer((value: number) => value + 1, 0)
  const observer = useRef<ResizeObserver | undefined>(undefined)
  const observed = useRef(new Map<string, HTMLElement>())

  // one observer for all rendered rows: a changed height re-lays out the list
  if (!observer.current && typeof ResizeObserver !== 'undefined') {
    observer.current = new ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.vkey
        if (key === undefined) continue
        const height = Math.ceil(entry.borderBoxSize?.[0]?.blockSize ?? (entry.target as HTMLElement).offsetHeight)
        if (height && heights.current.get(key) !== height) {
          heights.current.set(key, height)
          changed = true
        }
      }
      if (changed) remeasured()
    })
  }
  useEffect(() => () => observer.current?.disconnect(), [])

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const resize = new ResizeObserver(() => setViewport((current) => ({ ...current, height: element.clientHeight })))
    resize.observe(element)
    setViewport({ top: element.scrollTop, height: element.clientHeight })
    return () => resize.disconnect()
  }, [])

  const keys = items.map((item, index) => String(itemKey(item, index)))
  const offsets = new Float64Array(items.length + 1)
  for (let index = 0; index < items.length; index++) offsets[index + 1] = offsets[index]! + (heights.current.get(keys[index]!) ?? estimate)
  const total = offsets[items.length]!

  const find = (position: number) => {
    let low = 0
    let high = items.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (offsets[middle + 1]! <= position) low = middle + 1
      else high = middle
    }
    return low
  }
  const start = Math.max(0, find(viewport.top - overscanPx))
  const end = Math.min(items.length, find(viewport.top + viewport.height + overscanPx) + 1)

  // follow the end of a growing list while the user is there
  useLayoutEffect(() => {
    const element = scroller.current
    if (followTail && element && atBottom.current) element.scrollTop = element.scrollHeight
  }, [followTail, items.length, total])

  const rows: ReactNode[] = []
  for (let index = start; index < end; index++) {
    const key = keys[index]!
    rows.push(
      <div
        key={key}
        data-vkey={key}
        style={{ position: 'absolute', top: offsets[index], left: 0, right: 0 }}
        ref={(element) => {
          // rows leaving the window are unobserved, so long sessions do not accumulate observations
          if (element) {
            observed.current.set(key, element)
            observer.current?.observe(element)
          } else {
            const previous = observed.current.get(key)
            if (previous) observer.current?.unobserve(previous)
            observed.current.delete(key)
          }
        }}
      >
        {render(items[index]!, index)}
      </div>,
    )
  }

  return (
    <div
      ref={scroller}
      className={className}
      data-testid={testId}
      data-total={items.length}
      style={{ overflow: 'auto', flex: 1, minHeight: 0, position: 'relative' }}
      onScroll={(event) => {
        const element = event.currentTarget
        atBottom.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 4
        setViewport({ top: element.scrollTop, height: element.clientHeight })
      }}
    >
      <div style={{ position: 'relative', height: total }}>{rows}</div>
    </div>
  )
}
