import { useMemo, useState } from 'react'
import { Check, CheckCircle2, GitCommitHorizontal, CircleDashed, Code, FileCode2, FlaskConical, GitPullRequestArrow, Lightbulb, ShieldCheck, XCircle } from 'lucide-react'
import * as actions from '../../lib/actions'
import { openChangedFile } from '../../lib/agent-files'
import { parseUnifiedDiff, splitPath } from '../../lib/diff'
import { explainApplyRejection, localizeEngineText } from '../../lib/engine-text'
import { agentCards } from '../../lib/leitstand'
import { shallowEqual } from '../../lib/store/core'
import { useAppState, useSessionState } from '../../lib/store'
import type { ReviewSummary, ValidationReport } from '../../lib/types'
import { approveRun, discardRun, startTask, undoRun, useWorkflowBusy } from '../../lib/workflow-actions'
import { AsyncButton, Confirm } from '../common'
import { Bar, Chip, Eyebrow } from '../ui'

const CHECK_LABEL: Record<string, string> = { typecheck: 'Typecheck', test: 'Tests', lint: 'Lint', build: 'Build', syntax: 'Syntax' }

export function ReviewScreen() {
  const { task, execution: selected } = useSessionState((state) => ({ task: state.task, execution: state.execution }), shallowEqual)
  const execution = selected && selected.taskId === task?.id && ['awaiting_approval', 'applied', 'completed'].includes(selected.status) && selected.finalDiff ? selected : undefined
  const files = useMemo(() => parseUnifiedDiff(execution?.finalDiff), [execution?.finalDiff])
  const cards = useMemo(() => agentCards({ subtasks: execution?.task?.subtasks ?? task?.subtasks ?? [], plan: execution?.task?.plans?.[0] ?? task?.plans?.[0] }), [execution, task])
  const [index, setIndex] = useState(0)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const busy = useWorkflowBusy(`execution:${execution?.id}`)
  const { approvalMode, defaultBranch } = useAppState((state) => ({ approvalMode: state.settings?.approvalMode, defaultBranch: state.project?.defaultBranch }), shallowEqual)
  const branch = defaultBranch || 'main'
  const commitFirst = approvalMode === 'auto_commit'

  if (!execution) {
    return (
      <div className="screen-empty">
        <GitPullRequestArrow size={28} className="faint" />
        <div style={{ fontSize: 18, fontWeight: 600 }}>Noch nichts zur Freigabe</div>
        <div className="muted">Sobald die Agenten fertig sind und Integration und Review bestanden haben, erscheinen die Änderungen hier.</div>
        <button className="btn" style={{ marginTop: 4 }} onClick={() => actions.setScreen('leitstand')}>Zum Leitstand</button>
      </div>
    )
  }

  const ownerOf = (path: string) => cards.find((card) => card.files.some((file) => file.path === path))
  const file = files[Math.min(index, files.length - 1)]
  const owner = file ? ownerOf(file.path) : undefined
  const added = files.reduce((sum, entry) => sum + entry.added, 0)
  const deleted = files.reduce((sum, entry) => sum + entry.deleted, 0)
  const validation = execution.finalValidation as ValidationReport
  const review = execution.review as ReviewSummary
  const applied = execution.applyRecords?.find((record) => record.status === 'applied')
  const done = Boolean(applied)
  const commitButton = (className: string) => (
    <AsyncButton className={className} disabled={busy} title={`Committet das Ergebnis auf ${branch} – als Fast-Forward oder, wenn ${branch} inzwischen neuere Commits hat, als Merge-Commit darauf. Eigene ungespeicherte Änderungen werden nie überschrieben.`} onClick={() => approveRun(execution, 'commit')}>
      <GitCommitHorizontal size={15} /> Auf {branch} committen
    </AsyncButton>
  )
  const workingTreeButton = (className: string) => (
    <AsyncButton className={className} disabled={busy} title="Wendet den Patch auf deine Arbeitskopie an (ohne Commit). Dateien mit eigenen ungespeicherten Änderungen werden nicht überschrieben." onClick={() => approveRun(execution, 'working_tree')}>
      <Check size={15} strokeWidth={2.4} /> In Arbeitskopie übernehmen
    </AsyncButton>
  )
  // the latest apply attempt, if it was refused (and nothing was applied after it)
  const lastRecord = [...(execution.applyRecords ?? [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
  const rejection = lastRecord?.status === 'rejected' ? explainApplyRejection(lastRecord.message) : undefined
  const blockers = review?.result?.issues.filter((issue) => issue.severity === 'blocker') ?? []
  const hints = review?.result?.issues.filter((issue) => issue.severity !== 'blocker') ?? []

  return (
    <div className="review" data-testid="workflow-approval">
      <div className="review-files">
        <div style={{ padding: '14px 16px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <strong style={{ fontSize: 14 }}>Gesamt-Diff</strong>
          <span className="faint" style={{ fontSize: 12 }}>
            {files.length} Datei{files.length === 1 ? '' : 'en'} · <span style={{ color: 'var(--ok)' }}>+{added}</span> <span style={{ color: 'var(--err)' }}>−{deleted}</span>
            {execution.integrationBranch ? ` · ${execution.integrationBranch}` : ''}
          </span>
        </div>
        <div className="review-file-list">
          {files.map((entry, position) => {
            const { dir, name } = splitPath(entry.path)
            const card = ownerOf(entry.path)
            return (
              <button key={entry.path} className={`review-file ${entry === file ? 'on' : ''}`} onClick={() => setIndex(position)}>
                <div className="row" style={{ gap: 6, width: '100%' }}>
                  {/\.(test|spec)\./.test(name) ? <FlaskConical size={13} className="faint" /> : <FileCode2 size={13} className="faint" />}
                  <span className="truncate" style={{ flex: 1, fontWeight: 500 }}>{name}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--ok)' }}>+{entry.added}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--err)' }}>−{entry.deleted}</span>
                </div>
                <div className="row" style={{ gap: 6, paddingLeft: 19, width: '100%' }}>
                  <span className="mono faint truncate" style={{ fontSize: 10.5, flex: 1 }}>{dir || '/'}{entry.status === 'added' ? ' · neu' : entry.status === 'deleted' ? ' · gelöscht' : entry.status === 'renamed' ? ' · umbenannt' : ''}</span>
                  {card ? <Chip tone={card.tone}>{card.key}</Chip> : null}
                </div>
              </button>
            )
          })}
        </div>
      </div>
      <div className="review-diff">
        {file ? (
          <>
            <div className="review-diff-head">
              <span className="mono truncate" style={{ fontSize: 12.5 }}>{file.path}</span>
              {owner ? <Chip tone={owner.tone}>{owner.key} · {owner.model}</Chip> : null}
              <span className="spacer" />
              <button className="btn small" onClick={() => void openChangedFile(execution, file.path)}>
                <Code size={12} /> Im Code öffnen
              </button>
            </div>
            <div className="diff-body mono">
              {file.lines.map((line, position) => (
                <div key={position} className={`diff-row ${line.kind}`}>
                  <span className="ln">{line.oldLine ?? ''}</span>
                  <span className="ln">{line.newLine ?? ''}</span>
                  <span className="mark">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span>
                  <span className="code">{line.text || ' '}</span>
                </div>
              ))}
            </div>
          </>
        ) : <div className="screen-empty"><div className="muted">Der Diff ist leer.</div></div>}
      </div>
      <div className="review-side">
        {done ? (
          <div className="done-box">
            <div className="row" style={{ gap: 8, color: 'var(--ok)', fontWeight: 600 }}>
              <CheckCircle2 size={17} /> {applied?.mode === 'branch' ? 'Als Branch behalten' : applied?.mode === 'fast_forward' || applied?.mode === 'commit' ? `Auf ${applied.targetBranch ?? branch} committet` : 'In Arbeitskopie übernommen'}
            </div>
            <div className="muted" style={{ fontSize: 12.5 }}>{applied?.message ?? `${files.length} Datei(en) geändert.`}</div>
            <div className="row" style={{ gap: 6 }}>
              {applied ? <AsyncButton className="btn small" disabled={busy} onClick={() => undoRun(execution, applied.id)}>Rückgängig machen</AsyncButton> : null}
              <button className="btn small primary" onClick={() => actions.newSession()}>Neue Aufgabe</button>
            </div>
          </div>
        ) : null}
        {execution.applyRecords?.some((record) => record.status === 'reverted') && !applied ? <div className="callout warn">Die Übernahme wurde rückgängig gemacht.</div> : null}
        {rejection && !done && execution.status === 'awaiting_approval' ? (
          <div className="apply-rejected" role="alert" data-testid="apply-rejected">
            <div className="row" style={{ gap: 8, fontWeight: 600 }}>
              <XCircle size={15} /> Übernahme nicht möglich
            </div>
            <div style={{ fontSize: 12.5, textWrap: 'pretty' }}>{rejection.text}</div>
            <div className="row wrap" style={{ gap: 6 }}>
              <AsyncButton className="btn small" disabled={busy} title={`Das Ergebnis bleibt auf dem Branch ${execution.integrationBranch} – du kannst ihn später selbst mergen.`} onClick={() => approveRun(execution, 'branch')}>Als Branch behalten</AsyncButton>
              {rejection.kind !== 'dirty' && task ? (
                <AsyncButton className="btn small" disabled={busy} title="Startet die Aufgabe neu auf dem aktuellen Stand deiner Arbeitskopie" onClick={async () => { await startTask(task.id); actions.setScreen('leitstand') }}>Auf aktuellem Stand neu ausführen</AsyncButton>
              ) : null}
              {rejection.kind === 'dirty' ? <button className="btn small" onClick={() => actions.setSideView('git')}>Git-Änderungen ansehen</button> : null}
            </div>
          </div>
        ) : null}
        <div className="stack" style={{ gap: 4 }}>
          <strong style={{ fontSize: 15 }}>{done ? 'Übernommene Änderungen' : execution.status === 'awaiting_approval' ? 'Änderungen bereit zur Freigabe' : 'Ergebnis (nicht übernommen)'}</strong>
          <span className="muted" style={{ fontSize: 12.5, textWrap: 'pretty' }}>{localizeEngineText(execution.summary) || task?.userPrompt}</span>
        </div>
        <div className="side-card">
          <Eyebrow>Validierung</Eyebrow>
          {validation?.results?.length ? validation.results.map((result) => {
            const Icon = result.status === 'passed' ? CheckCircle2 : result.status === 'skipped' ? CircleDashed : XCircle
            return (
              <div key={result.id} className="row" style={{ gap: 8 }} title={result.command}>
                <Icon size={14} style={{ color: result.status === 'passed' ? 'var(--ok)' : result.status === 'skipped' ? 'var(--faint)' : 'var(--err)' }} />
                <span style={{ flex: 1 }}>{CHECK_LABEL[result.kind] ?? result.kind}{result.blocking ? '' : ' (nicht blockierend)'}</span>
                <span className="mono faint" style={{ fontSize: 11 }}>{result.kind === 'test' && result.testsPassed !== undefined ? `${result.testsPassed}/${result.testsPassed + (result.testsFailed ?? 0)}` : result.status === 'passed' ? 'ok' : result.status}</span>
              </div>
            )
          }) : <div className="faint" style={{ fontSize: 12.5 }}>Keine Projekt-Checks erkannt (kein typecheck/test/lint-Skript).</div>}
        </div>
        <div className="side-card">
          <div className="row" style={{ gap: 8 }}>
            <ShieldCheck size={15} style={{ color: 'var(--accent)' }} />
            <strong style={{ whiteSpace: 'nowrap' }}>{review?.kind === 'premium' ? 'Premium-Review' : review?.kind === 'human_required' ? 'Manuelle Prüfung nötig' : 'Automatischer Review'}</strong>
            <span className="spacer" />
            {review?.result ? <span className="mono" style={{ fontSize: 12, color: review.result.verdict === 'approve' ? 'var(--ok)' : 'var(--tool)' }}>{review.result.verdict} · {review.result.score}/100</span> : null}
          </div>
          {review?.result ? <Bar value={review.result.score} tone={review.result.score >= 80 ? 'ok' : review.result.score >= 60 ? 'tool' : 'err'} height={5} /> : null}
          <div className="muted" style={{ fontSize: 12.5, textWrap: 'pretty' }}>{review?.result?.summary ?? localizeEngineText(review?.reason)}</div>
          {[...blockers, ...hints].map((issue, position) => (
            <div key={position} className="issue" style={{ background: issue.severity === 'blocker' ? 'var(--err-soft)' : 'var(--tool-soft)' }}>
              <Lightbulb size={13} style={{ color: issue.severity === 'blocker' ? 'var(--err)' : 'var(--tool)', marginTop: 2, flex: 'none' }} />
              <span><span className="mono" style={{ fontSize: 11 }}>{splitPath(issue.file).name}</span> – {issue.message}</span>
            </div>
          ))}
          {review?.deterministicIssues?.length ? (
            <details>
              <summary className="muted" style={{ fontSize: 12 }}>{review.deterministicIssues.length} Hinweis(e) der automatischen Prüfung</summary>
              <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 12 }}>{review.deterministicIssues.map((issue, position) => <li key={position}>{issue}</li>)}</ul>
            </details>
          ) : null}
        </div>
        {!done && execution.status === 'awaiting_approval' ? (
          <div className="stack" style={{ gap: 8, marginTop: 'auto' }}>
            {commitFirst ? commitButton('btn primary big') : workingTreeButton('btn primary big')}
            <div className="two-col">
              {commitFirst ? workingTreeButton('btn') : commitButton('btn')}
              <AsyncButton className="btn" disabled={busy} title={`Behält das Ergebnis auf dem Branch ${execution.integrationBranch}`} onClick={() => approveRun(execution, 'branch')}>Als Branch behalten</AsyncButton>
            </div>
            <button className="link-btn danger" disabled={busy} onClick={() => setConfirmDiscard(true)}>Ergebnis verwerfen</button>
          </div>
        ) : null}
      </div>
      {confirmDiscard ? (
        <Confirm
          title="Ergebnis verwerfen?"
          danger
          confirmLabel="Verwerfen"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setConfirmDiscard(false)
            void discardRun(execution).then(() => actions.setScreen('leitstand')).catch((error: unknown) => actions.notify(error instanceof Error ? error.message : String(error), 'error'))
          }}
        >
          Der Integrations-Branch <code>{execution.integrationBranch}</code> und alle Agentenergebnisse dieses Laufs werden gelöscht. Deine Arbeitskopie bleibt unverändert.
        </Confirm>
      ) : null}
    </div>
  )
}

