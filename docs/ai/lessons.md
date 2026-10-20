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
