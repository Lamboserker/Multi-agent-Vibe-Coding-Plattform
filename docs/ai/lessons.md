# Lessons
<!-- Kurze, handlungsleitende Regeln. Max. ~40. Veraltetes streichen statt anhängen. -->

1. **Planungsfehler zuerst in der DB diagnostizieren.** Read-only mit `node:sqlite` auf
   `%APPDATA%\Multi-AI Coder Dev\multi-ai-coder.db`: `ModelCall` (purpose `plan`), `TaskPlan` (source, summary, dag.warnings),
   `Subtask` + `AgentProfile`. Die Planner-Summary verrät oft die eigentliche Ursache.
2. **Der Planner kann nur nutzen, was im Prompt steht.** Vor jeder Planner-Änderung prüfen, ob Agenten, Skills und lokale
   Modelle als Katalog im Prompt landen – sonst „erfindet" oder „vermisst" er sie.
3. **Skill-Namen enthalten `-`.** Text-Matching muss den ganzen Namen prüfen, nicht nur Namensteile.
4. **Kategorie schlägt Stichwort.** In Scoring-Heuristiken muss ein exakter Kategorietreffer mehr wiegen als die Summe
   zufälliger Stichwörter – Stichwortsumme deckeln und Ränge lexikografisch vergleichen (Kategorie > Projekt > Score >
   Priorität), nie additiv: Boni wie Projekt +1000 oder freie Prioritäten kippen sonst den Kategorietreffer.
5. **Filter nicht exklusiv machen, wenn Nutzer oder Planner etwas explizit verlangen.** Explizite Wahl (gepinnt) geht vor
   Profil-Auswahl.
6. **Kleine Modelle brauchen kleine Tasks.** Präzise Einzeldatei-Aufgaben statt Premium-Eskalation; Latenz-Optimierungen
   dürfen das nicht aushebeln (ADR-003).
7. **Keine bezahlten Live-Aufrufe ohne Zustimmung.** Prompts per Unit-Test prüfen; Live-Test nur nach Freigabe.
8. **Scoring-Änderungen haben mehrere Abnehmer.** `skillRelevance` steuert Inline-Kontext für Planner *und* Agenten –
   vor einer Gewichtsänderung alle Aufrufer (`forRole`, `promptContext`, `catalog`) und ihre Prompt-Wirkung prüfen.
9. **api liest die engine-`dist`.** Nach Engine-Änderungen erst `pnpm --filter @multi-ai-coder/engine build`, sonst
   meldet der api-Typecheck fehlende Exporte.
10. **Was angeboten wird, muss ankommen können.** Filter auf Angebots- und Ausführungsseite angleichen (Katalog ↔
    `forRole`-Rollenfilter), und Pfade ohne Tools (`canLoad: false`, `externalTools: false`) dürfen nichts verlangen,
    das nur per Tool erreichbar ist (`load_skill`) – dort inline liefern.
11. **Prompt-Regeln als Ganzes lesen.** Nach jeder Prompt-Änderung den vollständigen Prompt auf Widersprüche prüfen (neue
    Regel ↔ bestehende Einschränkungen wie „at most ONE existing file") und vorgegebene Wortlaute gegen gültige ADRs
    gegenlesen – bei Konflikt gilt die ADR, Abweichung im Task-Log begründen.
12. **Neue Zustände Ende-zu-Ende denken.** Ein neuer `currentStep`/Status braucht alle Abnehmer (grep auf einen
    Geschwisterwert wie `plan_failed`: Renderer-Stage, Sitzungsstatus, Self-Test, Start-Guards) *und* den Rückweg: was der
    zustandslose Planner beim nächsten Aufruf sieht (Fragen + Antworten zusammen, dauerhaft im Auftrag).
13. **Doku-Text nie über `node -e "…"`/Shell-Strings schreiben.** Backticks und `\`` in Markdown zerbrechen das Quoting
    (Bash-Kommandosubstitution, Node-Escape-Fehler). Für `docs/ai/` immer Edit/Write oder ein Heredoc mit `<<'EOF'`.
14. **Vor einem Live-Test prüfen, welcher Code läuft.** `pnpm dev` bündelt das Backend nur beim Start
    (`dist/backend/boot.cjs`). Startzeit des Electron-Prozesses mit `LastWriteTime` der geänderten Quellen vergleichen,
    sonst testet man den alten Stand. Angewendete Migrationen stehen in `_mac_migrations`, nicht in `_prisma_migrations`.
15. **Belegen, was die Daten unterscheiden können.** Ein korrektes Ergebnis (Subtask hat Doku-Agent) beweist nicht seine
    Herkunft (Planner-Wahl vs. Kategorie-Heuristik), wenn mehrere Pfade dasselbe liefern und die Rohdaten nicht
    gespeichert sind. Ein Akzeptanzkriterium, das nur teilweise belegt ist, bleibt offen oder wird als Restrisiko
    getrennt, nicht mit Vermerk abgehakt.
