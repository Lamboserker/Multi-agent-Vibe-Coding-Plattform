---
name: ui-tailwind
description: Recipes for a modern Tailwind CSS interface - theme mapping, app shell, sidebar, top bar, cards, buttons, tables, forms - built on the ui-design tokens. Use whenever a project uses Tailwind CSS.
triggers: [tailwind, tailwindcss]
---
# Modern Tailwind CSS

**Theme.** Map the ui-design tokens once instead of using raw palette colors everywhere. Tailwind v4
(`@import "tailwindcss";`): `@theme { --color-bg: var(--bg); --color-surface: var(--surface);
--color-surface-2: var(--surface-2); --color-line: var(--border); --color-ink: var(--text);
--color-muted: var(--muted); --color-accent: var(--accent); --color-accent-soft: var(--accent-soft);
--font-sans: var(--font); }`. Tailwind v3: the same names under `theme.extend.colors` /
`fontFamily.sans` in tailwind.config. Then use `bg-surface`, `text-muted`, `border-line`, `bg-accent`.

**App shell.** `<div class="flex min-h-screen bg-bg text-ink">`; sidebar `<aside class="hidden lg:flex
w-62 flex-col gap-1 border-r border-line bg-surface p-3">`; main `<main class="flex-1 p-6 lg:p-8">`.
Nav item: `flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-2
hover:text-ink`; active: `bg-accent-soft text-accent font-medium`. Mobile: a menu button (`lg:hidden`)
toggles a fixed sidebar with a backdrop.

**Top bar.** `mb-6 flex flex-wrap items-center justify-between gap-3`; title `text-2xl font-semibold
tracking-tight`, subtitle `text-sm text-muted`.

**Buttons.** Primary `inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-3.5 text-sm font-medium
text-white shadow-sm hover:opacity-90 focus-visible:outline-none focus-visible:ring-4
focus-visible:ring-accent/20 disabled:opacity-50`; secondary the same with `border border-line bg-surface
text-ink hover:bg-surface-2`.

**Cards and stats.** `rounded-xl border border-line bg-surface p-5 shadow-sm`; stat grid `grid gap-4
sm:grid-cols-2 xl:grid-cols-4`; value `text-3xl font-semibold tabular-nums`; trend pill `rounded-full
bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600`.

**Tables.** Inside a card: `w-full text-sm`; head `text-xs uppercase tracking-wide text-muted`; rows
`border-t border-line hover:bg-surface-2`; cells `px-4 py-3`; numbers `text-right tabular-nums`.

**Forms.** Label `text-sm font-medium`; input `h-9 w-full rounded-lg border border-line bg-surface px-3
text-sm focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent/20`.

**Avoid:** raw `bg-blue-500` style colors outside the theme, `shadow-2xl` everywhere, many different
radii, gradient backgrounds on whole pages.
