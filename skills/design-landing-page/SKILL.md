---
name: design-landing-page
description: Design recipe for marketing landing pages - hero with product mock, logo strip, bento features, testimonials, pricing, FAQ and footer. Complements ui-design. Use when designing or building a landing page, homepage or product marketing site.
triggers: [landingpage, landing page, landing-page, startseite, homepage, hero, produktseite, marketing-seite, marketing, website, webseite, pricing, preise, faq]
version: 1
test-task: "Baue eine Landingpage für mein Café mit Hero, Preisen und FAQ"
---
# Landing page design recipe

Complements ui-design (tokens, type scale, base rules). Use the same token names.

## Layout
- Single column of full-width sections, content max-width 1120px, section padding 96px vertical (64px mobile).
- Sticky nav 64px (logo, 3-4 links, ghost "Anmelden", primary CTA). Order: hero, logo strip, features, testimonial, pricing, FAQ, final CTA, footer.

## Required components
- Hero: H1 48-60px/600 (letter-spacing -0.02em, max 12 words), 18px --muted subline, primary + ghost button, product mock (browser frame, hairline border, --shadow-lg) below or right.
- Logo strip: 5-6 grayscale logos/wordmarks, 24px high, --muted, label "Vertraut von ...".
- Bento feature grid: 6 cards in a 3-column grid with mixed spans, each icon 20px, title, 2 lines of text; one card with a mini visual.
- Testimonial: large quote 20-24px, avatar, name, role.
- Pricing table: 3 tiers, middle highlighted (accent border, "Beliebt" badge), price 40px tabular-nums, check-icon feature list, one CTA each.
- FAQ accordion: 5-6 items, chevron rotates, keyboard accessible.
- Footer: 4 link columns, legal row, --muted.

## States
- Buttons: hover, focus-visible, disabled. Accordion open/close animation 150ms.
- Responsive: nav collapses to a menu button below 768px; bento and pricing one column below 640px; hero mock stacks below the text.
- Long headlines use `text-wrap:balance`. Images get a fixed aspect ratio, no layout shift.

## Modern look
- Do: big type, one clear CTA per section, lots of whitespace, subtle radial glow in --accent-soft only, real copy.
- Don't: stock-photo collages, gradient buttons, paragraphs over 70 characters, emoji icons, Lorem ipsum, carousel hero.

## Planning recipe
1. design/tokens.css imported in the global stylesheet; page shell with nav and footer.
2. One task per section, each in its own file: Hero, LogoStrip, FeatureGrid, Testimonial, PricingTable, FaqAccordion.
3. Page composition with real copy for the stated business.
4. States and responsive rules.
Use only `var(--…)` tokens from design/tokens.css.
