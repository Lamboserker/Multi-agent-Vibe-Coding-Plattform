import path from 'node:path'
import { launch, newProfile, prepareRepository, quit, resultsDir, stamp } from './helpers.mjs'
const { app, page, api } = await launch(newProfile())
await api('PATCH', '/settings', { orchestrator: null })
await api('POST', '/onboarding/complete')
await api('POST', '/projects/open', { path: prepareRepository() })
await page.reload()
await page.waitForSelector('.ide')
await page.locator('nav.activity-bar button[aria-label="Diagnose & Performance"]').click()
await page.getByText('Langsame Operationen').waitFor({ timeout: 30_000 })
const snapshot = (await api('GET', '/system/diagnostics')).data
console.log(JSON.stringify({ cpu: snapshot.system.cpuLoadPercent, gpu: snapshot.gpu?.[0]?.name, rss: snapshot.runtime.rssMb, requests: snapshot.requests.length, index: snapshot.caches.repoIndex }))
console.log(JSON.stringify(await page.evaluate(() => window.mac.app.metrics())))
await page.screenshot({ path: path.join(resultsDir, `${stamp()}-diagnostics.png`) })
await quit(app)
