import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveExecutable, runProcess, sanitizedEnv } from '@multi-ai-coder/engine'
import type { IntegrationPlatform, McpPreset, PrerequisiteCheck } from '@multi-ai-coder/shared'

const labels: Record<string, string> = { node: 'Node.js ≥ 22 und npm', uv: 'uv (verwaltetes Python)', git: 'Git', chrome: 'Google Chrome', blender: 'Blender' }
const winget: Record<string, string> = { node: 'OpenJS.NodeJS.LTS', uv: 'astral-sh.uv', git: 'Git.Git', chrome: 'Google.Chrome', blender: 'BlenderFoundation.Blender' }

/** Fixed install actions. Neither executable names nor arguments come from HTTP input. */
export class IntegrationRuntime {
  platform = process.platform as IntegrationPlatform

  constructor(readonly dataDir: string) {}

  private async locate(id: string): Promise<string | undefined> {
    const command = id === 'node' ? 'node' : id
    const found = resolveExecutable(command)
    if (found) return found
    const userBinary = path.join(os.homedir(), '.local', 'bin', `${command}${this.platform === 'win32' ? '.exe' : ''}`)
    if (existsSync(userBinary)) return userBinary
    if (this.platform === 'darwin') {
      const applications: Record<string, string> = { chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', blender: '/Applications/Blender.app/Contents/MacOS/Blender' }
      const executable = applications[id]
      if (executable && existsSync(executable)) return executable
    }
    if (this.platform === 'linux' && id === 'chrome') return resolveExecutable('google-chrome') ?? resolveExecutable('chromium') ?? resolveExecutable('chromium-browser')
    if (this.platform !== 'win32') return undefined
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    const candidates: Record<string, string[]> = {
      node: [path.join(programFiles, 'nodejs', 'node.exe')],
      uv: [path.join(os.homedir(), '.local', 'bin', 'uv.exe'), path.join(local, 'Microsoft', 'WinGet', 'Links', 'uv.exe')],
      git: [path.join(programFiles, 'Git', 'cmd', 'git.exe')],
      chrome: [path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe')],
    }
    if (id === 'blender') {
      const base = path.join(programFiles, 'Blender Foundation')
      const folders = await fs.readdir(base).catch(() => [])
      candidates.blender = folders.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((folder) => path.join(base, folder, 'blender.exe'))
    }
    return candidates[id]?.find((candidate) => existsSync(candidate))
  }

  async check(id: string): Promise<PrerequisiteCheck> {
    let executable = await this.locate(id)
    if (id === 'node' && executable) {
      const version = await runProcess(executable, ['--version'], { timeoutMs: 5000, env: sanitizedEnv() })
      const npm = this.npm(executable)
      if (version.exitCode !== 0 || Number(version.stdout.match(/v(\d+)/)?.[1] ?? 0) < 22 || !npm) executable = undefined
    }
    return {
      id, label: labels[id] ?? id, available: Boolean(executable), path: executable,
      installable: this.platform === 'win32' && Boolean(winget[id]) && Boolean(resolveExecutable('winget')),
      instruction: id === 'blender' ? 'Blender installieren und öffnen; anschließend das MCP-Add-on aktivieren und dessen Server starten.' : `${labels[id] ?? id} installieren. Nach einer Installation die Voraussetzungen erneut prüfen.`,
    }
  }

  private npm(node: string): string | undefined {
    const sibling = path.join(path.dirname(node), this.platform === 'win32' ? 'npm.cmd' : 'npm')
    return existsSync(sibling) ? sibling : resolveExecutable('npm')
  }

  async installPrerequisite(id: string, signal: AbortSignal) {
    if (this.platform !== 'win32' || !winget[id] || !resolveExecutable('winget')) throw new Error('Für diese Voraussetzung ist keine automatische Installation verfügbar.')
    const result = await runProcess('winget', ['install', '--id', winget[id]!, '--exact', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements', '--silent', '--disable-interactivity'], { env: sanitizedEnv(), signal, timeoutMs: 600_000, maxOutputBytes: 64_000, cleanupChildren: true })
    if (signal.aborted) throw new Error('Einrichtung abgebrochen.')
    if (result.exitCode !== 0) throw new Error(`Installation von ${labels[id]} fehlgeschlagen. Bitte über die offizielle Anleitung installieren und erneut prüfen.`)
  }

  private root(preset: McpPreset) { return path.join(this.dataDir, 'integrations', preset.id, preset.packageVersion ?? preset.version) }

  async installPackage(preset: McpPreset, signal: AbortSignal) {
    if (signal.aborted) throw new Error('Einrichtung abgebrochen.')
    if (!preset.runtime) return
    const root = this.root(preset)
    await fs.mkdir(root, { recursive: true })
    let result
    if (preset.runtime === 'npm') {
      const node = (await this.check('node')).path
      if (!node) throw new Error('Node.js ≥ 22 und npm fehlen.')
      result = await runProcess(this.npm(node)!, ['install', '--prefix', root, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--package-lock=false', '--save-exact', `${preset.package}@${preset.packageVersion}`], { cwd: root, env: sanitizedEnv(), signal, timeoutMs: 600_000, maxOutputBytes: 64_000, cleanupChildren: true })
    } else {
      const uv = (await this.check('uv')).path
      if (!uv) throw new Error('uv fehlt.')
      result = await runProcess(uv, ['tool', 'install', '--python', preset.python ?? '3.12', `${preset.package}==${preset.packageVersion}`], { cwd: root, env: this.uvEnv(root), signal, timeoutMs: 600_000, maxOutputBytes: 64_000, cleanupChildren: true })
    }
    if (signal.aborted) throw new Error('Einrichtung abgebrochen.')
    if (result.exitCode !== 0) throw new Error('Das festgeschriebene Serverpaket konnte nicht installiert werden. Netzwerk und Paketverfügbarkeit prüfen und erneut versuchen.')
  }

  private uvEnv(root: string) {
    return sanitizedEnv({ UV_TOOL_DIR: path.join(root, 'tools'), UV_TOOL_BIN_DIR: path.join(root, 'bin'), UV_PYTHON_INSTALL_DIR: path.join(this.dataDir, 'integrations', 'python') })
  }

  async launch(preset: McpPreset): Promise<{ command: string; args: string[]; cwd: string }> {
    const root = this.root(preset)
    const cwd = path.join(this.dataDir, 'integrations', preset.id, 'data')
    await fs.mkdir(cwd, { recursive: true })
    if (preset.runtime === 'npm') {
      const node = (await this.check('node')).path
      if (!node) throw new Error('Node.js fehlt.')
      const packageDir = path.join(root, 'node_modules', preset.package!)
      const info = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8')) as { version: string; bin: string | Record<string, string> }
      if (info.version !== preset.packageVersion) throw new Error('Die installierte Paketversion entspricht nicht dem Katalog.')
      const relative = typeof info.bin === 'string' ? info.bin : info.bin[preset.binary!]
      if (!relative) throw new Error('Das Paket enthält den erwarteten Server-Einstiegspunkt nicht.')
      const entry = path.resolve(packageDir, relative)
      if (path.relative(packageDir, entry).startsWith('..') || !existsSync(entry)) throw new Error('Ungültiger Server-Einstiegspunkt.')
      return { command: node, args: [entry], cwd }
    }
    const command = path.join(root, 'bin', `${preset.binary}${this.platform === 'win32' ? '.exe' : ''}`)
    if (!existsSync(command)) throw new Error('Serverpaket fehlt. Installation auswählen und erneut versuchen.')
    return { command, args: [], cwd }
  }

  async installAddon(preset: McpPreset, signal: AbortSignal) {
    if (preset.id !== 'blender') throw new Error('Dieses Paket hat keinen unterstützten Add-on-Installer.')
    const launch = await this.launch(preset)
    const result = await runProcess(launch.command, [...launch.args, 'install-addon'], { cwd: launch.cwd, env: sanitizedEnv(), signal, timeoutMs: 120_000, cleanupChildren: true, maxOutputBytes: 64_000 })
    if (result.exitCode !== 0 || signal.aborted) throw new Error('Blender-Add-on konnte nicht installiert werden. Bitte über die verlinkte Anleitung manuell installieren.')
  }
}
