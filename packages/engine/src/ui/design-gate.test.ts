import { describe, expect, it } from 'vitest'
import { shouldDesign } from './design-gate.js'

describe('shouldDesign', () => {
  it.each([
    'Erstelle ein CRM-Dashboard für Vertriebler',
    'Baue eine Landingpage für mein Café',
    'Build a SaaS admin panel',
    'Gestalte die Oberfläche moderner',
    'Create a landing page for our product',
    'Entwirf einen Onlineshop mit Warenkorb',
    'Modernisiere die Startseite und überarbeite das design',
    'Make a new dashboard with charts',
    'Erstelle ein Formular für die Registrierung',
    'Erstelle eine Todo-App mit React',
    'Baue eine neue Seite für unser Team',
    'Build a web app for booking rooms',
    'Erstelle ein Admin-Dashboard mit API-Anbindung und modernem Layout',
  ])('designs: %s', (prompt) => expect(shouldDesign(prompt)).toBe(true))

  it.each([
    'Behebe den Fehler in src/app.ts',
    'Fix the build',
    'Benenne foo in bar um',
    'Schreibe Tests für die API',
    'Ändere die Farbe des Buttons in Button.tsx',
    'Update the README',
    'Apply the migration',
    'Formatiere den Code',
    'Create a guide for the platform format',
    'Change the color of the app header',
    'Erstelle eine neue API-Route für die App',
    'Build a REST API for my app',
    'Erstelle ein Datenbank-Schema für die App',
    'Create a CLI app that imports CSV files',
    'Erstelle eine REST-API für das Admin-Backend',
    'Create unit tests for the dashboard service',
    'Erstelle Tests für den Shop-Checkout',
    'Build a new endpoint for the CRM',
  ])('skips: %s', (prompt) => expect(shouldDesign(prompt)).toBe(false))

  it('honours force and skip', () => {
    expect(shouldDesign('Schreibe Tests', 'force')).toBe(true)
    expect(shouldDesign('Erstelle ein Dashboard', 'skip')).toBe(false)
    expect(shouldDesign('Erstelle ein Dashboard', 'auto')).toBe(true)
  })
})
