import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react'

interface SplitterProps {
  /** 'x': vertical bar that changes a width; 'y': horizontal bar that changes a height. */
  axis: 'x' | 'y'
  /** +1 when dragging right/down makes the region bigger, -1 when dragging left/up does. */
  direction: 1 | -1
  size: number
  min: number
  max: () => number
  label: string
  className?: string
  /** Called on every pointer move; should only touch the DOM (CSS variable), not the store. */
  onPreview: (size: number) => void
  onCommit: (size: number) => void
  /** Dragged well below `min`: the region is hidden instead of resized. */
  onCollapse?: () => void
  /** Double click. */
  onReset?: () => void
}

const KEY_STEP = 24

/** Drag handle between two layout regions (pointer + keyboard). */
export function Splitter({ axis, direction, size, min, max, label, className, onPreview, onCommit, onCollapse, onReset }: SplitterProps) {
  const drag = useRef<{ pointerId: number; start: number; size: number; raw: number } | undefined>(undefined)
  const clamp = (value: number) => Math.round(Math.max(min, Math.min(Math.max(min, max()), value)))
  const clearCursor = () => document.body.classList.remove('is-resizing', 'resize-x', 'resize-y')
  useEffect(() => () => {
    if (drag.current) {
      drag.current = undefined
      clearCursor()
    }
  }, [])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, start: axis === 'x' ? event.clientX : event.clientY, size, raw: size }
    document.body.classList.add('is-resizing', axis === 'x' ? 'resize-x' : 'resize-y')
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    current.raw = current.size + direction * ((axis === 'x' ? event.clientX : event.clientY) - current.start)
    onPreview(clamp(current.raw))
  }
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    drag.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    clearCursor()
    if (onCollapse && current.raw < min * 0.5) {
      onPreview(size)
      onCollapse()
    } else onCommit(clamp(current.raw))
  }
  const cancel = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    drag.current = undefined
    clearCursor()
    onPreview(current.size)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
    const index = keys.indexOf(event.key)
    if (index < 0) return
    event.preventDefault()
    onCommit(clamp(size + (index === 1 ? 1 : -1) * direction * KEY_STEP))
  }

  return (
    <div
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={size}
      aria-valuemin={min}
      aria-valuemax={Math.max(min, max())}
      tabIndex={0}
      title={`${label} – ziehen zum Anpassen, Doppelklick setzt zurück`}
      className={`splitter splitter-${axis} ${className ?? ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  )
}
