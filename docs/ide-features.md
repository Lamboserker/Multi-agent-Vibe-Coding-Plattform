# IDE-Funktionen und Agent-Manager

Stand: Phase 0.3 (F).

## Navigation und Bedienung

| Funktion | Bedienung | Umsetzung |
|---|---|---|
| Befehlspalette | Strg+Umschalt+P (oder ⌘-Symbol in der Aktivitätsleiste) | Befehlsregister `lib/commands.ts` mit Fuzzy-Suche; dieselben Befehle sind global als Tastenkürzel gebunden |
| Quick Open | Strg+P | Dateiliste aus `git ls-files` (ignorierte Dateien ausgeschlossen), Fuzzy-Ranking mit Dateinamen-Bonus |
| Gehe zu Zeile | Strg+G bzw. `:Zeile:Spalte` in der Palette | |
| Tastenkürzel-Übersicht | Palette → „Tastenkürzel anzeigen“ | aus dem Befehlsregister erzeugt |
| Tabs | Strg+W schließen, Strg+Tab wechseln, Strg+Alt+S alle speichern | ungespeicherte Tabs werden nie ohne Bestätigung geschlossen |
| Split-Editor | Strg+\\ (deutsche Tastatur: Strg+AltGr+ß) | zweiter Monaco-Editor auf **demselben Modell**: Änderungen erscheinen sofort in beiden, ein gemeinsamer Rückgängig-Verlauf; Befehle wirken auf den fokussierten Editor |
| Statusleiste | ⊗ Fehler / ⚠ Warnungen (Klick öffnet Probleme), Laufzeit- und Aktivitätsanzeige | |

## Suchen und Ersetzen

Aktivitätsleiste → Suchen (Strg+Umschalt+F): Suche über das Projekt mit Groß-/Kleinschreibung, ganzen Wörtern,
regulären Ausdrücken, Einschluss-/Ausschluss-Globs (`src/**, *.ts`). ripgrep grenzt die Kandidaten ein (falls
installiert), die Treffer (Zeile/Spalte/Länge) berechnet die Laufzeit selbst. Ersetzen mit `$1`/`$&` bei regulären
Ausdrücken, je Datei oder für alle Treffer, immer mit Bestätigung. **Geöffnete Dateien** werden im Editor geändert
(ein Rückgängig-Schritt, ungespeicherte Änderungen bleiben erhalten), geschlossene Dateien auf der Festplatte; deren
vorherige Fassung landet in der lokalen Historie.

## Sprachfunktionen (TypeScript/JavaScript)

Ein TypeScript-LanguageService je Projekt in der Laufzeit (`apps/api/src/ide/ts-language.ts`). Er verwendet das
**TypeScript des Projekts** (richtige Version und Lib-Dateien), sonst das mitgelieferte; die `tsconfig.json` des
Projekts gilt. Ungespeicherter Editorinhalt wird als Overlay mitgeschickt; Dateiänderungen auf der Festplatte
kommen über den Datei-Watcher an, Änderungen an `tsconfig*.json`/`package.json` bauen den Dienst neu auf; nach
15 Minuten ohne Nutzung wird er freigegeben.

* **Gehe zu Definition** (F12, Strg+Klick) – auch in andere, nicht geöffnete Dateien (sie werden als Tab geöffnet).
* **Alle Referenzen** (Umschalt+F12) – Liste in der Suchansicht.
* **Umbenennen** (F2) – projektweit; geöffnete Dateien werden im Editor geändert, geschlossene auf der Festplatte
  (mit lokaler Historie), die aktuelle Datei über Monaco (rückgängig machbar).
* **Hover** mit Typsignatur und Dokumentation.
* **Live-Diagnosen** mit ungespeichertem Inhalt (rote/gelbe Unterstreichung, Probleme-Panel, Statusleiste).
  Monacos eigener TypeScript-Worker bleibt für Vervollständigung/Syntax zuständig; seine Einzeldatei-Hover,
  -Definitionen, -Referenzen und -Umbenennung sind abgeschaltet, damit nichts doppelt oder falsch erscheint.

## Probleme, Formatieren, Git, Historie

* **Probleme-Panel**: Live-Diagnosen geöffneter Dateien, „Projekt prüfen“ (TypeScript-Compiler und ESLint des
  Projekts, falls installiert; Ergebnisse je Datei, Klick springt zur Stelle) und Probleme der aktuellen Ausführung.
* **Formatieren** (Umschalt+Alt+F) und **Beim Speichern formatieren** (Einstellung): Prettier des Projekts über
  stdin; fehlt Prettier, kommt eine klare Meldung und nichts ändert sich.
* **Git im Editor**: Änderungsmarken im Gutter (hinzugefügt/geändert/gelöscht gegenüber HEAD, Zeilen-LCS) und
  „Änderungen gegenüber HEAD anzeigen“ (Diff-Tab).
* **Lokale Historie**: Vor jedem Überschreiben durch die App (Speichern, Ersetzen, Umbenennen, Formatieren,
  KI-Bearbeitung, Wiederherstellen) wird die vorherige Fassung gespeichert (50 Fassungen, 30 Tage, ≤ 2 MB); Dialog
  mit Diff gegenüber dem aktuellen Stand und „Wiederherstellen“ (als rückgängig machbare Änderung).

## KI-Funktionen im Editor

* **Auswahl bearbeiten (lokales Modell)** – Strg+I: Anweisung eingeben → das lokale Modell der Rolle „balanced“
  liefert nur den Ersatz der Auswahl (strukturierte Ausgabe) → Diff-Vorschau → „Übernehmen“ als ein
  Rückgängig-Schritt. Keine Premium-Kosten; der Aufruf wird als lokaler Modellaufruf erfasst.
* **Auswahl im Chat erklären lassen** – legt eine „Frage“ mit dem Code in den Chat-Entwurf; gesendet (und damit
  ggf. ein Premium-Aufruf) wird erst durch den Benutzer.

## Terminal

Tabs mit Status, Verlauf der letzten App-Sitzung, Neustart, sauberes Beenden (bereits Phase A) sowie neu:
Suche im Terminal (Strg+F im Terminal, Groß-/Kleinschreibung, vor/zurück), Umbenennen (Doppelklick auf den Tab),
geteilte Ansicht mit zwei Terminals (Teilen-Symbol; bleibt über Neustarts erhalten). Das Terminal nimmt anderen
Eingabefeldern nicht mehr den Fokus.

## Agent-Manager

Aktivitätsleiste → Agenten → „Agenten verwalten“. Ein Agentenprofil legt für Coder-Agenten fest:

| Feld | Wirkung in der Ausführung |
|---|---|
| Zuständig für | Kategorien/Stichwörter; beim Planen erhält jede Teilaufgabe automatisch das passendste Profil (Kategorie, Wörter in Titel/Beschreibung, Dateipfade; Projekt-Profile vor globalen, dann Priorität) |
| Gilt für | alle Projekte oder ein Projekt |
| Modell | festes lokales Modell (sonst entscheidet der Router); ein für die Teilaufgabe gewähltes Modell hat Vorrang |
| Skills | Teilmenge der Skills (leer = alle dem Coder zugewiesenen) |
| MCP-Server | Auswahl oder „alle zugewiesenen“; leer = keine |
| Plugin-Werkzeuge | an/aus |
| Eskalation | bis Premium / nur stärkere lokale Modelle / keine |
| Max. Schritte, Max. Reparaturen | Grenzen des Agentenlaufs |
| Rollenanweisung | wird dem System-Prompt des Agenten angehängt („## Your role: …“) |

Vorlagen: Frontend-, Backend-, Test-, Doku- und Refactoring-Agent. In der Planansicht kann der Agent je Teilaufgabe
geändert werden; das Laufprotokoll nennt ihn („task-001: Test-Agent mit qwen2.5-coder:7b …“).

**Strukturierte Kommunikation**: Nach der Integration einer Teilaufgabe entsteht eine kompakte Übergabe
(Schlüssel, Titel, geänderte Dateien, Zusammenfassung ≤ 600 Zeichen; Ereignis `task_handoff`). Abhängige
Teilaufgaben erhalten diese Übergaben als „## Results of prerequisite tasks“ statt vollständiger Protokolle.

## Tests

* `apps/api/src/ide/ide.test.ts` – Dateiliste, Suche (Optionen, Globs, Regex), Ersetzen mit Gruppen + Historie,
  Definition/Referenzen/Umbenennen/Hover über Dateien, Diagnosen mit ungespeichertem Inhalt und nach Änderungen auf
  der Festplatte, fehlende Werkzeuge.
* `apps/api/src/agents/agent-profiles.test.ts`, `packages/engine/src/engine/execution.test.ts` (Übergabe,
  Rollenanweisung, Eskalationsgrenze), `apps/desktop/src/renderer/lib/text-utils.test.ts` (Zeilen-Diff, Fuzzy, Edits).
* GUI: `e2e/ide-features.test.mjs` (Quick Open, Palette, Gehe zu Zeile, F12, F2 über offene und geschlossene
  Dateien, Live-Diagnose + Statusleiste, Git-Gutter, Speichern + Historie, Projektprüfung mit tsc, Formatieren ohne
  Prettier, Suchen/Ersetzen, Split-Editor, Tastenkürzel), `e2e/agents.test.mjs`, `e2e/terminal.test.mjs`,
  live: `e2e/ai-edit.live.test.mjs`.

## Offene Punkte

* Sprachfunktionen nur für TypeScript/JavaScript (kein generischer LSP-Client für weitere Sprachen).
* Vervollständigung kommt weiterhin aus Monacos Einzeldatei-Worker (keine projektweiten Auto-Importe).
* Agentenprofile gelten für Coder-Agenten; Planer und Chat verwenden weiterhin die Rollenzuweisung der Skills/MCP.
