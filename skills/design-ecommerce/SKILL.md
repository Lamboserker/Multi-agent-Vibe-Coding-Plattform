---
name: design-ecommerce
description: Design recipe for online shops - product grid cards, filter sidebar, product detail gallery, cart drawer and checkout stepper. Complements ui-design. Use when designing or building an online shop, product catalog, cart or checkout.
triggers: [shop, onlineshop, e-commerce, ecommerce, produkt, produkte, warenkorb, checkout, katalog, bestellung, kasse, store, product, cart]
version: 1
test-task: "Baue einen Onlineshop mit Produktkatalog, Warenkorb und Checkout"
---
# E-commerce design recipe

Complements ui-design (tokens, type scale, base rules). Use the same token names.

## Layout
- Header 64px: logo, search 480px, account, cart button with count badge. Content max-width 1280px.
- Catalog: filter sidebar 260px + grid `repeat(auto-fill,minmax(220px,1fr))`, gap 24px. Product page: gallery 55% + sticky buy box 45%. Checkout: form 60% + order summary 40%.

## Required components
- Product card: image 4:5 with radius, hover swaps second image, name 14px/500, --muted subtitle, price tabular-nums (sale price --err + struck old price), "Neu" badge, quick-add button on hover.
- Filter sidebar: collapsible groups (Kategorie, Preis range slider, Größe chips, Farbe swatches 24px), removable active-filter chips, "Zurücksetzen".
- Product gallery: large image plus 64px thumbnails, zoom on hover, arrow-key navigation.
- Buy box: title, rating stars, price 24px, variant chips, quantity stepper, primary "In den Warenkorb", availability dot, shipping hint.
- Cart drawer: right 420px, line items (thumb, name, variant, stepper, price), subtotal, free-shipping progress bar, primary "Zur Kasse".
- Checkout stepper: Adresse, Versand, Zahlung, Prüfen; current step --accent, done steps check; order summary with totals.

## States
- Loading: product card skeletons with fixed image ratio. Empty cart: message + "Weiter einkaufen". No results: hint + reset filters.
- Out of stock: dimmed image, disabled button, "Benachrichtigen". Payment error: inline message at the field.
- Filters become a bottom sheet below 992px; grid 2 columns below 640px; cart drawer full width.

## Modern look
- Do: product imagery first, restrained UI chrome, clear price hierarchy, trust cues (Versand, Rückgabe) in --muted.
- Don't: countdown banners, gradient buy buttons, cluttered badges, emoji icons, Bootstrap blue, auto-playing carousels.

## Planning recipe
1. design/tokens.css imported in the global stylesheet; header and footer shell.
2. One task per component, each in its own file: ProductCard, FilterSidebar, ProductGallery, BuyBox, CartDrawer, CheckoutStepper.
3. Screens: Katalog, Produktseite, Kasse with realistic German products and EUR prices.
4. States and responsive rules.
Use only `var(--…)` tokens from design/tokens.css.
