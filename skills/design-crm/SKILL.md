---
name: design-crm
description: Design recipe for CRM and sales apps - contact list, deal pipeline kanban, activity timeline, detail drawer and states. Complements ui-design. Use when designing or building a CRM, contacts, leads or sales pipeline UI.
triggers: [crm, kunden, kunde, kontakte, kontakt, leads, deals, deal, pipeline, vertrieb, sales, customers, contacts, kontaktliste]
version: 1
test-task: "Erstelle ein CRM mit Kontaktliste und Deal-Pipeline"
---
# CRM design recipe

Complements ui-design (tokens, type scale, base rules). Use the same token names.

## Layout
- Shell: sidebar 240px (Kontakte, Deals, Aufgaben, Berichte) + main. Page header: title, count, search 320px, primary "Neuer Kontakt".
- Views switch by tabs (Liste / Pipeline). Detail opens as right drawer 480px over the list, not a new page.
- Pipeline: horizontally scrolling columns, each 300px wide, gap 16px.

## Required components
- Contact row: avatar 32px (initials on --accent-soft), name 14px/500, company --muted, email, status badge, last activity date; hover row --surface-2.
- Pipeline column: header with stage name, deal count and total amount (tabular-nums, currency); sticky; drop highlight with dashed --accent border.
- Deal card: title, company, amount, owner avatar, due date (--err if overdue); radius-sm, --shadow while dragging.
- Activity timeline: vertical 1px line, 8px dots, icon per type (call, mail, meeting), text + --muted timestamp.
- Detail drawer: header (avatar, name, badges), tabs Übersicht / Aktivität / Notizen, sticky footer actions.

## States
- Loading: 6 row skeletons and column skeleton cards. Empty list: icon, "Noch keine Kontakte", CTA "Kontakt anlegen" + import.
- Empty pipeline column: dashed placeholder "Deal hierher ziehen". Error: banner with retry.
- Long company names truncate; amounts never wrap. Below 992px drawer becomes full-screen; pipeline snaps per column.

## Modern look
- Do: dense but airy rows (48px), subtle row dividers, stage colour only as small dot, quiet badges.
- Don't: colored column backgrounds, zebra rows, emoji avatars, gradient buttons, Bootstrap blue.

## Planning recipe
1. design/tokens.css imported in the global stylesheet; app shell and sidebar.
2. One task per component, each in its own file: ContactRow/ContactList, DealCard, PipelineColumn, ActivityTimeline, DetailDrawer.
3. Screen composition: list view and pipeline view with realistic German sample data.
4. States: skeletons, empty, error, responsive.
Use only `var(--…)` tokens from design/tokens.css.
