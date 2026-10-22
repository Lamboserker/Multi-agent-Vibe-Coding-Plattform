---
name: design-saas-app
description: Design recipe for SaaS web apps - sidebar with workspace switcher, command palette, settings sections, billing plans and onboarding checklist. Complements ui-design. Use when designing or building a SaaS app shell, settings, billing or onboarding.
triggers: [saas, web-app, webapp, web app, workspace, einstellungen, settings, onboarding, billing, abrechnung, abo, konto, account, team]
version: 1
test-task: "Baue eine SaaS-Web-App mit Sidebar, Einstellungen und Billing-Seite"
---
# SaaS app design recipe

Complements ui-design (tokens, type scale, base rules). Use the same token names.

## Layout
- Shell: sidebar 248px + main; top bar 56px (breadcrumb left, command trigger, user menu right). Content max-width 1100px.
- Settings: secondary nav 200px left, sections right, each section a card with title, hint and right-aligned save.

## Required components
- Sidebar: workspace switcher on top (avatar 24px, name, chevron, menu with workspaces + "Neuer Workspace"), nav items 32px high with 16px icons, active = --accent-soft + --text, section labels 12px --muted, user block at bottom.
- Command palette: Ctrl/Cmd+K, modal 560px, input 48px, grouped results, arrow keys, shortcut hints as kbd chips.
- Settings section: label-top fields, helper text, inline validation, toggle rows (title + description + switch).
- Billing plan cards: 3 cards, current plan marked with badge, price 32px tabular-nums, feature checklist, "Upgrade" primary only on the recommended one; invoice table below.
- Onboarding checklist: card with progress bar (--accent), 4-5 steps, done steps with check, dismiss action.
- Toast: bottom right, --shadow-lg, auto-dismiss 4s.

## States
- Loading: skeletons for nav counts and cards. Empty: guiding message + CTA ("Erstes Projekt anlegen"). Error: inline banner and toast.
- Disabled plan actions explain why. Unsaved changes: sticky bar "Ungespeicherte Änderungen".
- Sidebar off-canvas below 992px; settings nav becomes top tabs below 768px; forms one column.

## Modern look
- Do: quiet chrome, 14px text, keyboard-first, avatars with initials, subtle dividers, consistent 36px controls.
- Don't: colored sidebars, hero banners inside the app, gradient CTAs, emoji icons, modal-on-modal.

## Planning recipe
1. design/tokens.css imported in the global stylesheet; app shell with sidebar, top bar, router.
2. One task per component, each in its own file: WorkspaceSwitcher, CommandPalette, SettingsSection, PlanCard, OnboardingChecklist.
3. Screens: Übersicht stub, Einstellungen, Billing.
4. States and responsive rules.
Use only `var(--…)` tokens from design/tokens.css.
