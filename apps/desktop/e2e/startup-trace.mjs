// Startup breakdown (renderer marks + runtime log) for one profile, averaged over N warm starts.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { launch, newProfile, prepareRepository, quit } from './helpers.mjs'
const profile = newProfile()
const repo = prepareRepository()
let { app, page, api } = await launch(profile)
await api('PATCH', '/settings', { orchestrator: null })
await api('POST', '/onboarding/complete')
await api('POST', '/projects/open', { path: repo })
await quit(app)
for (let index = 0; index < 4; index += 1) {
  const started = Date.now()
  ;({ app, page } = await launch(profile))
  await page.waitForSelector('.ide')
  const marks = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('mark').map((mark) => [mark.name, Math.round(mark.startTime)])))
  const fcp = await page.evaluate(() => Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1))
  const origin = await page.evaluate(() => performance.timeOrigin)
  const log = readFileSync(path.join(profile, 'logs', 'runtime.log'), 'utf8').split(/\r?\n/)
  const startLine = [...log].reverse().find((line) => line.includes('starting runtime'))
  const readyLine = [...log].reverse().find((line) => line.includes('runtime ready'))
  console.log(JSON.stringify({ processToPageOrigin: Math.round(origin - started), fcp, ...marks, runtimeMs: new Date(readyLine.slice(1, 25)) - new Date(startLine.slice(1, 25)), runtimeReadyAbs: new Date(readyLine.slice(1, 25)) - started }))
  await quit(app)
}
