import { existsSync, renameSync } from 'node:fs'
import path from 'node:path'

export const PRODUCT_DIR = 'Multi-AI Coder'
export const DEVELOPMENT_DIR = 'Multi-AI Coder Dev'

/**
 * Profile folder of a development build (`pnpm dev`, unpackaged `electron .`). It is separate from the
 * installed app's folder, so an installation starts empty with the setup wizard instead of picking up
 * the developer's projects and settings.
 *
 * Until 0.3 both shared `<appData>/Multi-AI Coder`; that folder is moved once to the development
 * profile. While the installed app holds it open the move fails and the shared folder is used for
 * this start (the move is retried next time).
 */
export function developmentProfileDir(appData: string, log: (message: string) => void = () => {}) {
  const development = path.join(appData, DEVELOPMENT_DIR)
  if (existsSync(development)) return development
  const shared = path.join(appData, PRODUCT_DIR)
  if (!existsSync(path.join(shared, 'multi-ai-coder.db'))) return development
  try {
    renameSync(shared, development)
    log(`moved the development profile from ${shared} to ${development}`)
    return development
  } catch (error) {
    log(`could not move ${shared} (in use?): ${error instanceof Error ? error.message : String(error)}; using it for this start`)
    return shared
  }
}
