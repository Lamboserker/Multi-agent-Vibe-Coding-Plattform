import { useState, type ReactNode } from 'react'
import { notify } from '../lib/actions'
import { useToasts } from '../lib/store'

export function StatusDot({ status }: { status: string }) {
  const kind = ['completed', 'applied', 'passed', 'ok', 'ready', 'success'].includes(status)
    ? 'ok'
    : ['running', 'validating', 'repairing', 'integrating', 'planning', 'pending', 'queued', 'starting', 'restarting'].includes(status)
      ? 'running'
      : ['failed', 'error', 'blocked', 'timeout'].includes(status)
        ? 'error'
        : ['awaiting_approval', 'paused', 'interrupted', 'skipped', 'warn'].includes(status)
          ? 'warn'
          : ''
  return <span className={`dot ${kind}`} title={status} />
}

export function Badge({ children, kind }: { children: ReactNode; kind?: 'ok' | 'warn' | 'error' | 'premium' | 'local' | 'accent' }) {
  return <span className={`badge ${kind ?? ''}`}>{children}</span>
}

export function Spinner() {
  return <span className="spinner" />
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

export function PanelHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="panel-header">
      <h2>{title}</h2>
      <span className="spacer" />
      {children}
    </div>
  )
}

/** Button that shows a spinner while its async action runs and reports errors as toasts. */
export function AsyncButton({ onClick, children, className = 'btn', disabled, title }: { onClick: () => Promise<unknown>; children: ReactNode; className?: string; disabled?: boolean; title?: string }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      className={className}
      disabled={disabled || busy}
      title={title}
      onClick={async () => {
        setBusy(true)
        try {
          await onClick()
        } catch (error) {
          notify(error instanceof Error ? error.message : String(error), 'error')
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  )
}

export function Confirm({ title, children, confirmLabel = 'Bestätigen', danger, onConfirm, onCancel }: { title: string; children: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h3>{title}</h3>
        <div>{children}</div>
        <div className="row">
          <span className="spacer" />
          <button className="btn" onClick={onCancel}>
            Abbrechen
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Asks for one value. `multiline`: a textarea where Enter adds a line and Ctrl+Enter (or the button) submits. */
export function PromptDialog({ title, initial = '', placeholder, multiline, children, onSubmit, onCancel }: { title: string; initial?: string; placeholder?: string; multiline?: boolean; children?: ReactNode; onSubmit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial)
  const submit = () => {
    if (value.trim()) onSubmit(value.trim())
  }
  return (
    <div className="modal-backdrop" onClick={multiline && value.trim() ? undefined : onCancel}>
      <form
        className="modal"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <h3>{title}</h3>
        {children}
        {multiline ? (
          <textarea
            className="textarea"
            autoFocus
            rows={6}
            value={value}
            placeholder={placeholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                submit()
              }
            }}
          />
        ) : (
          <input className="input" autoFocus value={value} placeholder={placeholder} onChange={(event) => setValue(event.target.value)} />
        )}
        <div className="row">
          {multiline ? <span className="faint" style={{ fontSize: 11.5 }}>Strg+Enter sendet</span> : null}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onCancel}>
            Abbrechen
          </button>
          <button type="submit" className="btn primary" disabled={!value.trim()}>
            OK
          </button>
        </div>
      </form>
    </div>
  )
}

export function Toasts() {
  const toasts = useToasts()
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`}>
          {toast.message}
        </div>
      ))}
    </div>
  )
}

/** Renders a unified diff with colored lines. */
export function DiffText({ diff, maxLines = 4000 }: { diff: string; maxLines?: number }) {
  const lines = diff.split('\n')
  return (
    <pre className="pre" style={{ maxHeight: 'none' }}>
      {lines.slice(0, maxLines).map((line, index) => (
        <div key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-line-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-line-del' : line.startsWith('@@') ? 'diff-line-hunk' : undefined}>
          {line || ' '}
        </div>
      ))}
      {lines.length > maxLines ? <div className="faint">… {lines.length - maxLines} weitere Zeilen</div> : null}
    </pre>
  )
}

/** Very small markdown renderer (bold, inline code, code blocks, lists) – no HTML injection. */
export function Markdown({ text }: { text: string }) {
  const blocks = text.split(/```/)
  return (
    <div>
      {blocks.map((block, index) =>
        index % 2 === 1 ? (
          <pre key={index} className="pre">
            {block.replace(/^[\w-]*\n/, '')}
          </pre>
        ) : (
          <div key={index} style={{ whiteSpace: 'pre-wrap' }}>
            {block.split('\n').map((line, lineIndex) => (
              <div key={lineIndex}>{inline(line)}</div>
            ))}
          </div>
        ),
      )}
    </div>
  )
}

function inline(line: string): ReactNode[] {
  const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/)
  return parts.map((part, index) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={index}>{part.slice(2, -2)}</strong>
    ) : part.startsWith('`') && part.endsWith('`') ? (
      <code key={index}>{part.slice(1, -1)}</code>
    ) : (
      <span key={index}>{part || (index === 0 ? ' ' : '')}</span>
    ),
  )
}
