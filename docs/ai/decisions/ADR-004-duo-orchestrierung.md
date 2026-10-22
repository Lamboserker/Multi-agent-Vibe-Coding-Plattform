---
id: ADR-004
titel: Duo-Orchestrierung – Claude und Codex parallel mit Abgleich
status: proposed   # proposed | accepted | superseded
datum: 2026-10-21
---

# ADR-004: Duo-Orchestrierung – Claude und Codex parallel mit Abgleich

## Kontext
Bisher bedient genau ein Premium-Orchestrator (`settings.orchestrator`) alle Phasen. Der Nutzer will, dass Claude Code
und Codex auf Wunsch zusammenarbeiten: Sie sollen Ergebnisse gegenseitig prüfen und verbessern, und zwar in allen
Phasen.

## Entscheidung
- Neuer Modus `orchestratorMode: 'single' | 'duo'` mit `duoLead`. Er lässt sich pro Auftrag im Composer
  überschreiben: „Claude | Codex | Beide".
- Der Duo-Modus ist ein zusammengesetzter Adapter `DuoOrchestrator(lead, partner)`, der `OrchestratorAdapter`
  implementiert. Die Engine sieht weiter genau einen Orchestrator.
- Das Muster ist **parallel + Abgleich**. Beide Orchestratoren arbeiten gleichzeitig, dann gilt je Phase:
  - Plan und Design: Der Lead führt beide Vorschläge in einem dritten Aufruf zusammen.
  - Review: Die Ergebnisse werden deterministisch vereint; das strengere Urteil gilt.
  - Premium-Ausführung: Beide arbeiten in getrennten Worktrees. Gewinner ist, wessen Checks grün sind. Bei
    Gleichstand entscheidet der Lead.
  - Chat: Beide Antworten werden angezeigt.
- Scheitert einer der beiden, gilt das Ergebnis des anderen, und der Chat zeigt einen Hinweis.
- Jeder Teilaufruf wird einzeln als ModelCall mit seinem `provider` gebucht.
- **Ersetzt teilweise ADR-002:** „Kein automatischer zweiter Premium-Aufruf" gilt weiter im Einzelmodus. Im
  Duo-Modus, den der Nutzer ausdrücklich wählt, sind der zweite Aufruf und der Abgleich gewollt.

## Konsequenzen
- Das Premium-Kontingent wird je Phase etwa 2–3-mal belastet. Die Einstellungen weisen darauf hin.
- Der Duo-Modus braucht beide CLIs, installiert und angemeldet. Fehlt einer, läuft der Auftrag im Einzelmodus, und
  der Chat zeigt einen Hinweis.
