---
name: design-admin-forms
description: Design recipe for admin and back-office UIs - data tables with sort, filter, bulk actions and pagination, form layouts with validation, confirm dialogs. Complements ui-design. Use when designing or building an admin area, CRUD screens, forms or data tables.
triggers: [admin, backoffice, back-office, verwaltung, formular, form, forms, tabelle, table, crud, eingabemaske, benutzerverwaltung, datagrid]
version: 1
test-task: "Erstelle eine Admin-Verwaltung für Benutzer mit Tabelle und Formular"
---
# Admin and forms design recipe

Complements ui-design (tokens, type scale, base rules). Use the same token names.

## Layout
- Shell: sidebar 240px + main. Page header: title, count, primary "Neu anlegen" right. Below: toolbar, then table card full width.
- Form pages: single column 640px; on wide screens section title left (200px), fields right, sections split by 1px --border.

## Required components
- Data table: sticky header 40px (12px uppercase --muted), rows 48px, 1px dividers, numbers right-aligned tabular-nums, sortable headers with arrow icon, row checkbox, kebab row menu at right.
- Toolbar: search 280px, removable filter chips with count badge, column menu; with a selection it becomes a bulk bar ("3 ausgewählt", Löschen, Exportieren).
- Pagination: rows-per-page select, "1-25 von 312", prev/next buttons.
- Form field: label above (13px/500), input 36px, helper 12px --muted, error 12px --err plus --err border; validate on blur, summary on submit.
- Sticky save bar: bottom of the form, Abbrechen (ghost) + Speichern (primary), saving and disabled state.
- Confirm dialog: 440px, title, consequence text, destructive button in --err only here; focus on the safe action.
- Status badge: pill with soft background.

## States
- Loading: 8 skeleton rows. Empty: "Keine Einträge" + CTA; empty filter result: "Filter zurücksetzen".
- Error: banner above the table with retry. Long cells truncate with title; table scrolls horizontally inside its card, first column sticky.
- Below 768px rows become stacked cards; forms stay one column.

## Modern look
- Do: dense calm tables, hairline dividers, left-aligned text, inline validation, visible focus rings.
- Don't: zebra stripes, borders on every cell, red everywhere, placeholder-as-label, Bootstrap blue, modal for long forms.

## Planning recipe
1. design/tokens.css imported in the global stylesheet; app shell.
2. One task per component, each in its own file: DataTable, TableToolbar, Pagination, FormField, StickySaveBar, ConfirmDialog.
3. Screen composition: list screen and edit form with realistic German data.
4. States and responsive rules.
Use only `var(--…)` tokens from design/tokens.css.
