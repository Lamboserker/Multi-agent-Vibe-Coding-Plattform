import { useState } from 'react'
import { errorMessage } from '../../lib/api'
import { approveRun, discardRun, undoRun, useWorkflowBusy } from '../../lib/workflow-actions'
import { useApp } from '../../lib/store'
import type { ExecutionRun, ReviewSummary, ValidationReport } from '../../lib/types'
import { AsyncButton, Badge, Confirm } from '../common'
import { localizeEngineText } from '../../lib/engine-text'

function changedFiles(diff: string | null | undefined): string[] {
  return [...(diff ?? '').matchAll(/^diff --git a\/(\S+) b\//gm)].map((match) => match[1]!)
}

/** Final approval of an integrated change set (patch preview, validation, review, apply modes). */
export function ApprovalBox({ execution }: { execution: ExecutionRun }) {
  const { openDiff, notify, setBottomTab, setBottomOpen } = useApp()
  const busy = useWorkflowBusy(`execution:${execution.id}`)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const validation = execution.finalValidation as ValidationReport
  const review = execution.review as ReviewSummary
  const files = changedFiles(execution.finalDiff)
  const blockers = review?.result?.issues.filter((issue) => issue.severity === 'blocker') ?? []

  return (
    <div className="card stack" data-testid="workflow-approval" style={{ borderColor: 'var(--accent)' }}>
      <div className="row">
        <strong>Änderungen bereit zur Freigabe</strong>
        <span className="spacer" />
        <Badge kind={validation?.ok ? 'ok' : 'error'}>{validation?.ok ? 'Validierung ok' : 'Validierung fehlgeschlagen'}</Badge>
      </div>
      {execution.summary ? <div className="muted">{localizeEngineText(execution.summary)}</div> : null}
      <div className="stack" style={{ gap: 2, maxHeight: 140, overflow: 'auto' }}>
        {files.map((file) => (
          <span key={file} className="mono" style={{ fontSize: 11.5 }}>
            {file}
          </span>
        ))}
      </div>
      {review?.result ? (
        <div className={`callout ${review.result.verdict === 'approve' ? 'ok' : 'warn'}`}>
          <strong>Premium-Review: {review.result.verdict} ({review.result.score}/100)</strong>
          <div>{review.result.summary}</div>
          {blockers.length ? (
            <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
              {blockers.map((issue, index) => (
                <li key={index}>
                  <code>{issue.file}</code> {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : review?.reason ? (
        <div className={`callout ${review.kind === 'human_required' ? 'warn' : ''}`}>{localizeEngineText(review.reason)}</div>
      ) : null}
      {review?.deterministicIssues?.length ? (
        <details>
          <summary className="muted">{review.deterministicIssues.length} Hinweis(e) der automatischen Prüfung</summary>
          <ul style={{ margin: '4px 0', paddingLeft: 18 }}>{review.deterministicIssues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>
        </details>
      ) : null}
      <div className="row wrap">
        <button className="btn small" onClick={() => openDiff({ title: 'Gesamt-Diff', path: 'changes.diff', original: '', modified: execution.finalDiff ?? '', source: { type: 'execution', executionId: execution.id } })}>
          Diff im Editor
        </button>
        <button className="btn small" onClick={() => { setBottomTab('tests'); setBottomOpen(true) }}>
          Testergebnisse
        </button>
      </div>
      <div className="row wrap">
        <AsyncButton className="btn primary" disabled={busy} onClick={() => approveRun(execution, 'working_tree')} title="Wendet den Patch auf deine Arbeitskopie an (ohne Commit). Dateien mit eigenen ungespeicherten Änderungen werden nicht überschrieben.">
          In Arbeitskopie übernehmen
        </AsyncButton>
      </div>
      <details>
        <summary>Weitere Freigabeoptionen</summary>
        <div className="row wrap" style={{ marginTop: 8 }}>
        <AsyncButton className="btn" disabled={busy} onClick={() => approveRun(execution, 'branch')} title={`Behält das Ergebnis auf dem Branch ${execution.integrationBranch}`}>
          Als Branch behalten
        </AsyncButton>
        <AsyncButton className="btn" disabled={busy} onClick={() => approveRun(execution, 'fast_forward')} title="Fast-Forward des aktuellen Branches auf das integrierte Ergebnis (nur wenn der Branch unverändert ist).">
          Committen (Fast-Forward)
        </AsyncButton>
        <button className="btn danger" disabled={busy} onClick={() => setConfirmDiscard(true)}>
          Verwerfen
        </button>
        </div>
      </details>
      {confirmDiscard ? (
        <Confirm
          title="Ergebnis verwerfen?"
          danger
          confirmLabel="Verwerfen"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={async () => {
            setConfirmDiscard(false)
            try {
              await discardRun(execution)
            } catch (error) {
              notify(errorMessage(error), 'error')
            }
          }}
        >
          Der Integrations-Branch <code>{execution.integrationBranch}</code> und alle Agentenergebnisse dieses Laufs werden gelöscht. Deine Arbeitskopie bleibt unverändert.
        </Confirm>
      ) : null}
    </div>
  )
}

export function AppliedBox({ execution }: { execution: ExecutionRun }) {
  const busy = useWorkflowBusy(`execution:${execution.id}`)
  const record = execution.applyRecords?.find((entry) => entry.status === 'applied')
  if (!record) return execution.applyRecords?.some((entry) => entry.status === 'reverted') ? <div className="callout warn">Die Übernahme wurde rückgängig gemacht.</div> : null
  return (
    <div className="callout ok stack">
      <div>
        ✓ {record.message}
      </div>
      <div className="row">
        <AsyncButton
          className="btn small"
          disabled={busy}
          onClick={() => undoRun(execution, record.id)}
        >
          Rückgängig machen
        </AsyncButton>
      </div>
    </div>
  )
}
