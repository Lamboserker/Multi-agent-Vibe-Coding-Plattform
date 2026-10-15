import { useState } from 'react'
import type { ViewAction, ViewField, ViewNode } from '@multi-ai-coder/plugin-sdk'
import { Badge } from '../common'

/**
 * Renders a plugin's declarative view. Plugins never run code in the UI: they return a tree of
 * known node types, and every interaction is a command call back into the plugin's process.
 */
export function PluginView({ node, onAction, busy }: { node: ViewNode; onAction: (action: ViewAction) => void; busy?: boolean }) {
  switch (node.type) {
    case 'stack':
      return (
        <div className="stack" style={{ gap: 10 }}>
          {node.children.map((child, index) => (
            <PluginView key={index} node={child} onAction={onAction} busy={busy} />
          ))}
        </div>
      )
    case 'heading':
      return <div className="section-title">{node.text}</div>
    case 'text':
      return node.tone === 'error' || node.tone === 'warning' || node.tone === 'success' ? (
        <div className={`callout ${node.tone === 'error' ? 'error' : node.tone === 'warning' ? 'warn' : 'ok'}`}>{node.text}</div>
      ) : (
        <div className={node.tone === 'muted' ? 'muted' : ''}>{node.text}</div>
      )
    case 'markdown':
      // shown as preformatted text: plugin content is never interpreted as HTML
      return <pre className="pre plugin-markdown">{node.text}</pre>
    case 'code':
      return <pre className="pre">{node.content}</pre>
    case 'kv':
      return (
        <div className="kv">
          {node.items.map((item, index) => (
            <Pair key={index} label={item.label} value={item.value} />
          ))}
        </div>
      )
    case 'badge':
      return (
        <div>
          <Badge kind={node.tone}>{node.text}</Badge>
        </div>
      )
    case 'image':
      return /^data:image\/(png|jpeg|gif|webp);base64,/.test(node.dataUrl) ? <img className="plugin-image" src={node.dataUrl} alt={node.alt} /> : <div className="muted">Bild nicht darstellbar.</div>
    case 'table':
      return (
        <div className="plugin-table">
          <table className="table">
            <thead>
              <tr>
                {node.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
                {node.rows.some((row) => row.actions?.length) ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, index) => (
                <tr key={index}>
                  {row.cells.map((cell, cellIndex) => (
                    <td key={cellIndex}>{cell}</td>
                  ))}
                  {row.actions?.length ? (
                    <td className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                      {row.actions.map((action, actionIndex) => (
                        <button key={actionIndex} className="btn small" disabled={busy} onClick={() => onAction(action)}>
                          {action.label}
                        </button>
                      ))}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          {!node.rows.length ? <div className="muted">Keine Einträge.</div> : null}
        </div>
      )
    case 'actions':
      return (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {node.items.map((action, index) => (
            <button key={index} className="btn small" disabled={busy} onClick={() => onAction(action)}>
              {action.label}
            </button>
          ))}
        </div>
      )
    case 'form':
      // a re-rendered view with other values (e.g. a loaded request) resets the form
      return <PluginForm key={JSON.stringify(node.fields.map((field) => [field.name, field.value]))} fields={node.fields} submit={node.submit} onAction={onAction} busy={busy} />
    default:
      return <div className="muted">Unbekanntes Element ({(node as { type?: string }).type}).</div>
  }
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span>{label}</span>
      <span style={{ wordBreak: 'break-word' }}>{value}</span>
    </>
  )
}

function PluginForm({ fields, submit, onAction, busy }: { fields: ViewField[]; submit: ViewAction; onAction: (action: ViewAction) => void; busy?: boolean }) {
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() => Object.fromEntries(fields.map((field) => [field.name, field.value ?? (field.type === 'checkbox' ? false : field.type === 'select' ? (field.options?.[0] ?? '') : '')])))
  const set = (name: string, value: string | number | boolean) => setValues((current) => ({ ...current, [name]: value }))
  return (
    <form
      className="stack"
      style={{ gap: 6 }}
      onSubmit={(event) => {
        event.preventDefault()
        onAction({ ...submit, args: { ...(submit.args ?? {}), ...values } })
      }}
    >
      {fields.map((field) =>
        field.type === 'checkbox' ? (
          <label key={field.name} className="row">
            <input type="checkbox" checked={Boolean(values[field.name])} onChange={(event) => set(field.name, event.target.checked)} /> {field.label}
          </label>
        ) : (
          <label key={field.name} className="stack" style={{ gap: 3 }}>
            <span>{field.label}</span>
            {field.type === 'textarea' ? (
              <textarea className="textarea mono" rows={5} value={String(values[field.name] ?? '')} placeholder={field.placeholder} onChange={(event) => set(field.name, event.target.value)} />
            ) : field.type === 'select' ? (
              <select className="select" value={String(values[field.name] ?? '')} onChange={(event) => set(field.name, event.target.value)}>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input className="input" type={field.type === 'number' ? 'number' : 'text'} value={String(values[field.name] ?? '')} placeholder={field.placeholder} onChange={(event) => set(field.name, field.type === 'number' ? Number(event.target.value) : event.target.value)} />
            )}
          </label>
        ),
      )}
      <div>
        <button className="btn primary small" type="submit" disabled={busy}>
          {submit.label}
        </button>
      </div>
    </form>
  )
}
