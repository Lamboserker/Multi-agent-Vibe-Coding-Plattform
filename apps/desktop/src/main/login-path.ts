import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

/**
 * macOS/Linux apps started from Finder/Dock/launcher get a minimal PATH (/usr/bin:/bin:…), so
 * node, npm, git, claude, codex and ollama from Homebrew, nvm or ~/.local/bin are not found.
 * Merges the PATH of the user's login shell (and common install folders as a fallback) into
 * process.env before any runtime process or terminal is started. No-op on Windows.
 */
export function adoptLoginShellPath() {
  if (process.platform === 'win32') return
  const current = (process.env.PATH ?? '').split(':').filter(Boolean)
  let shellPath: string[] = []
  try {
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    const marker = '__MAC_PATH__'
    const output = execFileSync(shell, ['-ilc', `printf '${marker}%s${marker}' "$PATH"`], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] })
    shellPath = (output.split(marker)[1] ?? '').split(':').filter(Boolean)
  } catch {
    // shell missing, slow or broken profile: the fallback folders below still apply
  }
  const home = os.homedir()
  const fallback = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(home, '.local/bin'), path.join(home, '.npm-global/bin'), path.join(home, '.volta/bin'), path.join(home, '.bun/bin')]
  process.env.PATH = [...new Set([...shellPath, ...current, ...fallback])].join(':')
}
