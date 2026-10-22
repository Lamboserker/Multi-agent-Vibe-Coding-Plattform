---
name: design-dashboard
description: Design recipe for analytics and KPI dashboards - layout, KPI cards, chart cards, date range, top lists, activity feed and states. Complements ui-design. Use when designing or building a dashboard, analytics or metrics overview screen.
triggers: [dashboard, kpi, kennzahlen, analytics, statistiken, statistik, metriken, übersicht, charts, diagramm, reporting, metrics, overview]
version: 1
test-task: "Erstelle ein Analytics-Dashboard mit KPI-Karten und Umsatz-Diagramm"
---
# Dashboard design recipe

Complements ui-design (tokens, type scale, base rules). Use the same token names.

## Layout
- App shell: sidebar 240px (collapsed 64px) + main; top bar 56px with page title left, date range + export right.
- Main: max-width 1400px, padding 24-32px. 12-column grid, gap 16-24px.
- Row 1: 4 KPI cards (`repeat(auto-fit,minmax(240px,1fr))`). Row 2: main chart (span 8) + top list (span 4). Row 3: table or activity feed.

## Required components
- KPI card: label 12px --muted, value 28px/600 tabular-nums, delta badge (pill, --ok or --err soft background, arrow icon), 40px sparkline in --accent.
- Chart card: header (title 14px/600, legend, range toggle), 240-320px plot. Palette: --accent first, then neutral grays; max 4 series; 2px lines, light gridlines, tooltip with --shadow-lg.
- Date range picker: button group (7d / 30d / 90d / Custom), active = --accent-soft.
- Top-list table: rank, name, value right-aligned, inline bar (--accent-soft fill); 5 rows + "Alle anzeigen" ghost link.
- Activity feed: avatar/initials 28px, one-line text, --muted relative time, 1px dividers.

## States
- Loading: skeleton blocks of the same size as the content (shimmer 1.2s), never a lone spinner.
- Empty: icon, one sentence, primary CTA ("Datenquelle verbinden"). Error: inline message + "Erneut versuchen".
- Long names truncate with ellipsis and title attribute. Below 992px sidebar off-canvas; below 640px KPI cards 1 column, charts full width, tables scroll inside their card.

## Modern look
- Do: one accent + grays, big numbers, generous whitespace, hairline card borders, same chart colors across cards.
- Don't: rainbow charts, pie with 8 slices, gradient cards, heavy shadows, emoji icons, zebra tables, Bootstrap blue.

## Planning recipe
1. design/tokens.css imported in the global stylesheet; app shell (sidebar, top bar).
2. One task per component, each in its own file: KpiCard, ChartCard, DateRangePicker, TopList, ActivityFeed.
3. One task for the screen composition (grid, realistic sample data with currency and percentages).
4. One task for loading/empty/error states and responsive rules.
Use only `var(--…)` tokens from design/tokens.css.
