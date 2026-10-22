---
name: ui-design
description: Quality bar for any user interface (dashboards, landing pages, app screens) - design tokens, typography, spacing, hierarchy, interaction states, realistic content. Use for UI, styling, layout or component work with any CSS framework.
triggers: [ui, design, styling, layout, dashboard, landing page, frontend, css, theme, sidebar, navbar, navigation, card, cards, button, buttons, modal, responsive, dark mode, modern, modernes, gestaltung, oberfläche, komponente, component, components]
---
# UI design quality bar

Goal: a calm, precise, product-grade interface (Linear / Vercel / Stripe level), never the framework's default look.

**Checklist for every UI change (follow it literally):**
1. Tokens must exist before you use `var(--…)`: search the stylesheets for `--accent:`. If missing, add the
   `:root` block below to the global stylesheet (the CSS file the entry imports); without one, put it at
   the top of the stylesheet you create.
2. Components use only these tokens, no ad-hoc hex colors.
3. Numbers (values, prices, percentages): `font-variant-numeric: tabular-nums`.
4. Clickable elements get `:hover`, `:focus-visible` and `:disabled` styles.
5. CSS comments only as `/* … */`. Inline styles in JSX: `'var(--accent)'`, never `'--accent'`.
6. Cards and panels align content left, not centered.

**Tokens:** if `design/tokens.css` exists in the project, import it and use its tokens instead of defining new ones; otherwise:
```css
:root{--bg:#f7f7f8;--surface:#fff;--surface-2:#f1f1f3;--border:#e4e4e7;--text:#18181b;--muted:#71717a;
--accent:#4f46e5;--accent-hover:#4338ca;--accent-soft:#eef2ff;--ok:#16a34a;--warn:#d97706;--err:#dc2626;
--radius:12px;--radius-sm:8px;--shadow:0 1px 2px rgb(0 0 0/.05),0 1px 3px rgb(0 0 0/.06);
--shadow-lg:0 12px 32px -12px rgb(0 0 0/.2);--font:Inter,ui-sans-serif,system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0e;--surface:#131317;--surface-2:#1b1b21;--border:#26262d;
--text:#ececf1;--muted:#9a9aa6;--accent-soft:#1e1b4b}}
```
One accent color; status colors only for status. No large gradients, no neon, no emoji as icons.

**Typography.** Inter or system UI. Scale 12/13/14/16/20/24/32 px; body 14px, line-height 1.5; headings
weight 600, letter-spacing -0.01em. Secondary text uses --muted (not a lighter weight).

**Spacing and layout.** 4px grid (4 8 12 16 24 32 48). Page padding 24-32px, card padding 16-24px, gaps
16-24px, content max-width 1200-1400px. Dashboards: CSS grid `repeat(auto-fit,minmax(240px,1fr))`.

**Surfaces.** Page --bg, cards --surface with 1px --border, --radius and a subtle --shadow. At most two
elevation levels; overlays (menus, modals) use --shadow-lg.

**Hierarchy.** One primary (filled accent) action per view; the rest secondary (outline) or ghost. Page
header = title + one-line --muted subtitle on the left, actions on the right.

**Components.** One icon set (bootstrap-icons or lucide), 16-18px, vertically centered with text. Buttons
32-36px high, radius-sm, weight 500, icon + label gap 8px. Inputs 36px, 1px border, focus ring
`box-shadow:0 0 0 3px rgb(79 70 229/.2)`. Data tables: no zebra stripes, 1px row dividers, 12px uppercase
--muted header, numbers right-aligned. Badges: pill, soft status background with strong status text.

**States.** Transitions 150ms ease. Data views have empty, loading (skeleton) and error states.

**Content.** Realistic sample data (names, amounts with currency, dates, percentages), never "Lorem
ipsum" or "Item 1". Charts: one accent series plus gray, thin lines, light gridlines, no 3D.

**Responsive.** Sidebar collapses below 992px (off-canvas with a menu button); grids reflow to one column
below 640px; no horizontal page scroll.

**When planning UI work:** first one task for tokens, global styles and the app shell (sidebar, top bar),
then one task per component or page that names the exact classes and tokens it must use.
