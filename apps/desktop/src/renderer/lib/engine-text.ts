/**
 * The engine writes its run summaries and review reasons in English (they also go into logs and
 * model prompts). The UI shows them in German; unknown text passes through unchanged.
 */
const PHRASES: Array<[RegExp, string | ((...groups: string[]) => string)]> = [
  [/(\d+)\/(\d+) task\(s\) integrated; (\d+) file\(s\), \+(\d+)\/-(\d+)\. Validation: /g, (_, done, total, files, added, deleted) => `${done}/${total} Teilaufgabe(n) integriert; ${files} Datei(en), +${added}/−${deleted}. Prüfung: `],
  [/Cancelled\. (\d+) task\(s\) had been integrated\./g, (_, count) => `Abgebrochen. ${count} Teilaufgabe(n) waren bereits integriert.`],
  [/Low-risk change with passing validation: automated review only\./g, 'Geringes Risiko und Prüfungen bestanden: automatisches Review genügt.'],
  [/Premium review disabled in settings\./g, 'Premium-Review ist in den Einstellungen deaktiviert.'],
  [/Premium review because: /g, 'Premium-Review, weil: '],
  [/Premium review required \(/g, 'Premium-Review nötig ('],
  [/\) but no orchestrator is available/g, '), aber kein Orchestrator verfügbar'],
  [/\. Review the diff carefully\./g, '. Bitte den Diff sorgfältig prüfen.'],
  [/Premium review failed \(/g, 'Premium-Review fehlgeschlagen ('],
  [/security-critical files: /g, 'sicherheitskritische Dateien: '],
  [/a task has risk ≥ 4/g, 'eine Teilaufgabe hat Risiko ≥ 4'],
  [/large change \((\d+) lines\)/g, (_, lines) => `große Änderung (${lines} Zeilen)`],
  [/final validation failed/g, 'abschließende Prüfung fehlgeschlagen'],
  [/no passing test run/g, 'kein erfolgreicher Testlauf'],
  [/quality mode/g, 'Quality-Modus'],
  [/\((\d+) passed, (\d+) failed\)/g, (_, passed, failed) => `(${passed} bestanden, ${failed} fehlgeschlagen)`],
  [/: passed\b/g, ': bestanden'],
  [/: failed\b/g, ': fehlgeschlagen'],
  [/: skipped\b/g, ': übersprungen'],
]

export function localizeEngineText(text: string | null | undefined): string {
  if (!text) return ''
  let result = text
  for (const [pattern, replacement] of PHRASES) result = result.replace(pattern, replacement as never)
  return result
}

const RUN_STATUS: Record<string, string> = {
  pending: 'wartet',
  planning: 'Planung',
  awaiting_plan_approval: 'Plan wartet auf Bestätigung',
  running: 'läuft',
  paused: 'pausiert',
  integrating: 'wird integriert',
  awaiting_approval: 'wartet auf Freigabe',
  applied: 'übernommen',
  completed: 'abgeschlossen',
  failed: 'fehlgeschlagen',
  cancelled: 'abgebrochen',
  interrupted: 'unterbrochen',
}

export function runStatusLabel(status: string | null | undefined): string {
  return status ? RUN_STATUS[status] ?? status : '–'
}
