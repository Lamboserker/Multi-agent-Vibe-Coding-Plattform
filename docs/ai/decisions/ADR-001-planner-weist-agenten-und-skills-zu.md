---
id: ADR-001
titel: Der Planner weist Agent und Skills pro Task zu
status: accepted   # proposed | accepted | superseded
datum: 2026-10-20
---

# ADR-001: Der Planner weist Agent und Skills pro Task zu

## Kontext
Die Agenten-Zuweisung lief rein heuristisch über Stichwörter (`profileMatches`), und der Premium-Planner kannte weder
Agentenprofile noch Skills. Folge: fast alles ging an den Frontend-Agent; ein vom Nutzer verlangter Skill galt als
„nicht gefunden" und führte zu leeren Plänen.

## Entscheidung
- Der Planner bekommt einen Katalog der aktiven Coder-Agenten (Name, Beschreibung, Kategorien, Skills) und der aktiven
  Skills (Name, gekürzte Beschreibung, „requested by the user").
- Jeder Plan-Task enthält `agent` (exakter Profilname oder `""`) und `skills` (Skill-Namen).
- Zuweisung: Planner-Agent → vom Nutzer genannter Agent (nur bei 1-Task-Plan) → Heuristik. In der Heuristik dominiert
  die Kategorie (10 Punkte, inkl. Aliasse der Planner-Kategorien) über Stichwörter.
- Plan-Skills und im Task-Text genannte Skills sind „gepinnt": sie erreichen den Agenten auch außerhalb seiner
  Profil-Skills. Profil-Skills bleiben die Auswahl für die automatische Relevanz-Suche.

## Konsequenzen
- `PLAN_SCHEMA` wächst um zwei Pflichtfelder; Plugin-Orchestratoren müssen sie nicht liefern (Normalisierung setzt Defaults).
- `Subtask` speichert `skills` (neue Spalte).
- Der Nutzer kann Agent und Skills weiterhin pro Subtask manuell ändern; die manuelle Wahl gewinnt.

## Nachtrag 2026-10-20 (TASK-001, Abschluss-Review)
- „Requested" heißt ausdrücklich genannt (`namesSkill()` in `apps/api/src/skills/skill-format.ts`): Namen mit `-` als
  ganzes Wort (auch `<name>-Skill`), Einwort-Namen nur markiert (Anführungszeichen, Backticks, `/`, „Skill x"). Grund:
  ein bloßes „changelog" im Text darf den Planner nicht zwingen, den Skill an einen Task zu hängen.
- Angeforderte Skills erreichen den Planner nur als Katalogzeile, nie als inline „follow these instructions"
  (`promptContext` mit `exclude`). Grund: Skills sind Anweisungen für die ausführenden Agenten; inline würde der
  Planner sie selbst anwenden oder darauf warten (ursprüngliches Fehlerbild „leerer Plan").

## Nachtrag 2026-10-20 (TASK-002, Abschluss-Review)
- Heuristik-Rang wird lexikografisch verglichen: Kategorie-/Alias-Treffer > Projektprofil vor globalem > Trefferstärke >
  Priorität (`bestProfile` in `apps/api/src/agents/agent-profiles.service.ts`); Stichwortsumme auf 9 gedeckelt.
  Grund: der frühere additive Rang (`score*100 + priority + 1000·Projekt`) ließ eine Projektkopie des Frontend-Agent mit
  einem einzigen UI-Stichwort den globalen Doku-Agent mit Kategorietreffer schlagen; freie Prioritäten (−100..100)
  konnten den Kategorietreffer ebenfalls kippen. Bei reinen Stichwort-Treffern bleibt „Projekt vor global" erhalten.
- Auch beim Planner-Agenten gilt bei Namensgleichheit: Projektprofil vor globalem; unbekannter Name → Heuristik.
