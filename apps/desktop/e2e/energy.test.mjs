// GUI test of the electricity view: tariff entered in the costs screen, live draw, costs from
// unit price + pro-rata base price. No model call.
//
//   pnpm --filter @multi-ai-coder/desktop build && node --test e2e/energy.test.mjs
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { go, launch, newProfile, quit, resultsDir, stamp, waitUntil } from './helpers.mjs'

test('electricity: tariff, live draw and costs on the costs screen', { timeout: 5 * 60_000 }, async () => {
  const { app, page, api, consoleErrors } = await launch(newProfile())
  try {
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await go(page, 'Kosten')
    const card = page.locator('[data-testid="energy-card"]')
    await card.getByText('Dein Stromtarif').waitFor({ timeout: 30_000 })
    await card.getByLabel('Arbeitspreis in Cent pro kWh').fill('32,5')
    await card.getByLabel('Grundpreis in Euro pro Monat').fill('12,50')
    await card.getByLabel('Grundlast des PCs in Watt').fill('60')
    await card.getByLabel('CPU-Leistung unter Volllast in Watt').fill('100')
    await card.getByRole('button', { name: 'Tarif speichern' }).click()
    await waitUntil(async () => (await api('GET', '/settings')).data.electricity?.pricePerKwh === 0.325, 10_000, 'tariff saved')
    assert.deepEqual((await api('GET', '/settings')).data.electricity, { pricePerKwh: 0.325, basePricePerMonth: 12.5, systemBaseWatts: 60, cpuMaxWatts: 100 })
    // live draw: at least the configured base load, and a cost per hour from the tariff
    await waitUntil(async () => Number((await card.getByTestId('energy-live-watts').textContent()).replace(/\D/g, '')) >= 60, 15_000, 'live draw shown')
    await card.getByText('Arbeitspreis +').waitFor()
    const energy = (await api('GET', '/system/energy?days=7')).data
    assert.ok(energy.live.totalW >= 60)
    assert.equal(energy.live.systemSource, 'estimate')
    assert.ok(energy.live.costPerHour.total > 0)
    assert.equal(energy.period.days, 7)
    assert.ok(Math.abs(energy.period.baseCost - (12.5 * 12 / 365) * 7) < 0.0001, 'base price: 7 days pro rata')
    // the meter integrates over time
    await waitUntil(async () => (await api('GET', '/system/energy?days=1')).data.today.kWh > 0, 40_000, 'energy metered')
    await page.getByRole('radio', { name: '7 Tage' }).click()
    await card.getByText('Letzte 7 Tage').waitFor()
    await card.screenshot({ path: path.join(resultsDir, `${stamp()}-energy.png`) })
    assert.deepEqual(consoleErrors.filter((message) => !/Failed to load resource/.test(message)), [])
  } finally {
    await quit(app)
  }
})
