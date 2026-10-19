---
name: ui-bootstrap
description: Recipes for a modern, non-default Bootstrap 5 interface - app shell, sidebar, top bar, stat cards, tables, buttons, forms - built on the ui-design tokens. Use whenever a project uses Bootstrap or React-Bootstrap.
triggers: [bootstrap, react-bootstrap, bootstrap-icons]
---
# Modern Bootstrap 5

**Setup.** Dependencies `bootstrap` and `bootstrap-icons`. Import order in the entry file:
`bootstrap/dist/css/bootstrap.min.css`, `bootstrap-icons/font/bootstrap-icons.css`, then the own
`styles.css` (overrides last). No jQuery. React: plain JSX with Bootstrap classes (react-bootstrap only
if it is already installed).

**Override variables instead of fighting classes** (in styles.css, after the ui-design tokens):
```css
:root{--bs-body-font-family:var(--font);--bs-body-bg:var(--bg);--bs-body-color:var(--text);
--bs-border-color:var(--border);--bs-secondary-color:var(--muted);--bs-primary:#4f46e5;--bs-primary-rgb:79,70,229;
--bs-border-radius:var(--radius-sm);--bs-border-radius-lg:var(--radius);--bs-link-color-rgb:79,70,229}
.btn{font-weight:500}.btn-primary{--bs-btn-bg:var(--accent);--bs-btn-border-color:var(--accent);
--bs-btn-hover-bg:var(--accent-hover);--bs-btn-hover-border-color:var(--accent-hover)}
.card{--bs-card-bg:var(--surface);--bs-card-border-color:var(--border);border-radius:var(--radius);box-shadow:var(--shadow)}
.table{--bs-table-bg:transparent}.table thead th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;
color:var(--muted);font-weight:600}
.sidebar .nav-link{color:var(--muted)}.sidebar .nav-link:hover{background:var(--surface-2);color:var(--text)}
.sidebar .nav-link.active{background:var(--accent-soft);color:var(--accent)}
```

**App shell.** `<div class="d-flex min-vh-100">` with `<aside class="sidebar border-end d-none d-lg-flex
flex-column p-3" style="width:248px">` and `<main class="flex-grow-1 p-4">`. Sidebar: brand row (28px
logo + name `fw-semibold`), `<nav class="nav nav-pills flex-column gap-1">` with links `nav-link d-flex
align-items-center gap-2` + `<i class="bi bi-…">`, the current one `active`, user block at the bottom
(`mt-auto`). Below lg: the same nav in an `offcanvas offcanvas-start`, opened by a `btn btn-light` with
`bi-list` in the top bar.

**Top bar.** `d-flex flex-wrap align-items-center justify-content-between gap-3 mb-4`: title `h4 mb-0
fw-semibold` + subtitle `small text-body-secondary`; right side: search `form-control` (240px) and
`btn btn-primary d-inline-flex align-items-center gap-2`.

**Stat cards.** `row g-3` > `col-12 col-sm-6 col-xl-3` > `card h-100 p-3`: label `small
text-body-secondary`, value `fs-3 fw-semibold`, trend `badge rounded-pill bg-success-subtle
text-success-emphasis` with `bi-arrow-up-right`.

**Tables.** `card` > `div.table-responsive` > `table table-hover align-middle mb-0`; avatar 32px
`rounded-circle`; status `badge rounded-pill bg-*-subtle text-*-emphasis`; numbers `text-end`.

**Forms.** `form-label small fw-medium`, controls in `mb-3`, actions right-aligned in `card-footer
bg-transparent`.

**Avoid:** `navbar-dark bg-dark` or `bg-primary` header bars, default blue, `btn-lg` everywhere,
`shadow-lg` on every card, jumbotrons, centered page text.
