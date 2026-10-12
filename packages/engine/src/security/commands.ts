/**
 * Command allowlist for commands the engine executes on behalf of agents (validation, tests,
 * typechecks). This is a policy layer, not an OS sandbox: it decides *whether* a command may run.
 * Isolation comes from running inside a disposable git worktree with a sanitized environment.
 */

export type CommandDecision = 'allow' | 'approval' | 'deny'

export interface CommandClassification {
  decision: CommandDecision
  reason: string
  argv: string[]
  /** True when the command executes code from the opened project (package scripts, test files). */
  runsProjectCode: boolean
}

const SHELL_OPERATORS = /(\|\||&&|[;|&<>`]|\$\(|\$\{|\r|\n)/

/** Splits a command line into argv. Shell operators are rejected rather than interpreted. */
export function tokenizeCommand(command: string): string[] {
  if (SHELL_OPERATORS.test(command.replace(/"[^"]*"|'[^']*'/g, ''))) {
    throw new Error('Shell operators (; && || | > < & ` $()) are not allowed in agent commands.')
  }
  const argv: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasToken = false
  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasToken = true
      continue
    }
    if (/\s/.test(char)) {
      if (hasToken || current) argv.push(current)
      current = ''
      hasToken = false
      continue
    }
    current += char
    hasToken = true
  }
  if (quote) throw new Error('Unterminated quote in command.')
  if (hasToken || current) argv.push(current)
  return argv
}

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const SAFE_TOOLS = new Set(['tsc', 'vitest', 'jest', 'eslint', 'prettier', 'biome', 'mocha', 'ava', 'vue-tsc', 'svelte-check'])
const DENIED_BINARIES = new Set([
  'rm', 'rmdir', 'del', 'erase', 'format', 'mkfs', 'dd', 'shred',
  'curl', 'wget', 'invoke-webrequest', 'iwr', 'irm', 'scp', 'ssh', 'ftp', 'nc', 'ncat', 'telnet',
  'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'fish', 'wsl',
  'sudo', 'su', 'runas', 'chmod', 'chown', 'icacls', 'takeown', 'reg', 'regedit', 'setx',
  'docker', 'podman', 'kubectl', 'helm', 'terraform', 'ansible', 'vercel', 'netlify', 'fly', 'heroku',
  'shutdown', 'reboot', 'taskkill', 'kill', 'killall', 'winget', 'choco', 'scoop', 'brew', 'apt', 'apt-get', 'yum', 'dnf', 'pacman',
])
const GIT_READ_ONLY = new Set(['status', 'diff', 'log', 'show', 'ls-files', 'rev-parse', 'blame', 'grep', 'branch', 'describe'])

function baseName(binary: string): string {
  return binary.replaceAll('\\', '/').split('/').pop()!.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '')
}

export function classifyCommand(command: string): CommandClassification {
  let argv: string[]
  try {
    argv = tokenizeCommand(command)
  } catch (error) {
    return { decision: 'deny', reason: error instanceof Error ? error.message : String(error), argv: [], runsProjectCode: false }
  }
  if (!argv.length) return { decision: 'deny', reason: 'Empty command.', argv, runsProjectCode: false }

  const binary = baseName(argv[0]!)
  const args = argv.slice(1)
  const lowerArgs = args.map((arg) => arg.toLowerCase())
  const result = (decision: CommandDecision, reason: string, runsProjectCode = false): CommandClassification => ({
    decision,
    reason,
    argv,
    runsProjectCode,
  })

  if (DENIED_BINARIES.has(binary)) return result('deny', `"${binary}" is not permitted for agent commands.`)

  if (/(prisma)/.test(lowerArgs.join(' ')) && /(migrate\s+(reset|deploy)|db\s+push|--accept-data-loss|--force-reset)/.test(lowerArgs.join(' '))) {
    return result('deny', 'Destructive database operations are never executed automatically.')
  }

  if (binary === 'git') {
    const sub = lowerArgs[0] ?? ''
    if (GIT_READ_ONLY.has(sub)) return result('allow', 'Read-only git command.')
    if (sub === 'push' || sub === 'reset' || sub === 'clean' || sub === 'checkout' || sub === 'rebase') {
      return result('deny', `git ${sub} is reserved for the integration engine and the user.`)
    }
    return result('approval', `git ${sub} modifies repository state.`)
  }

  if (PACKAGE_MANAGERS.has(binary)) {
    const sub = lowerArgs.find((arg) => !arg.startsWith('-')) ?? ''
    if (['install', 'i', 'add', 'ci', 'update', 'upgrade', 'remove', 'uninstall', 'rm', 'link', 'publish', 'dlx', 'create', 'init'].includes(sub)) {
      return result('approval', `"${binary} ${sub}" changes dependencies, downloads code or publishes.`)
    }
    if (sub === 'exec' || sub === 'x') {
      const tool = baseName(args[args.findIndex((arg) => arg.toLowerCase() === sub) + 1] ?? '')
      if (SAFE_TOOLS.has(tool)) return result('allow', `${binary} exec ${tool}.`, true)
      return result('approval', `"${binary} exec ${tool}" runs an unknown tool.`, true)
    }
    if (sub === 'run' || sub === 'test' || sub === 't' || sub === 'typecheck' || sub === 'lint' || sub === 'check') {
      return result('allow', 'Package script declared by the project.', true)
    }
    if (sub && binary !== 'npm') return result('allow', 'Package script declared by the project.', true)
    return result('approval', `Unrecognized ${binary} invocation.`, true)
  }

  if (binary === 'npx') {
    const tool = baseName(args.find((arg) => !arg.startsWith('-')) ?? '')
    if (SAFE_TOOLS.has(tool) && lowerArgs.includes('--no-install')) return result('allow', `npx --no-install ${tool}.`, true)
    if (SAFE_TOOLS.has(tool)) return result('approval', 'npx may download packages; add --no-install to run the local tool.', true)
    return result('approval', `npx ${tool} may download and execute unknown code.`, true)
  }

  if (SAFE_TOOLS.has(binary)) return result('allow', `Known validation tool ${binary}.`, true)

  if (binary === 'node') {
    if (lowerArgs[0] === '--test') return result('allow', 'Node built-in test runner.', true)
    if (lowerArgs.some((arg) => arg === '-e' || arg === '--eval' || arg === '-p' || arg === '--print')) {
      return result('deny', 'Inline code evaluation is not permitted.')
    }
    return result('approval', 'Executing a project script with node requires approval.', true)
  }

  if (binary === 'python' || binary === 'python3' || binary === 'py') {
    if (lowerArgs[0] === '-m' && ['pytest', 'unittest', 'mypy', 'ruff', 'pyflakes', 'compileall'].includes(lowerArgs[1] ?? '')) {
      return result('allow', `python -m ${lowerArgs[1]}.`, true)
    }
    if (lowerArgs[0] === '-c') return result('deny', 'Inline code evaluation is not permitted.')
    return result('approval', 'Executing a Python script requires approval.', true)
  }
  if (['pytest', 'mypy', 'ruff'].includes(binary)) return result('allow', `Known validation tool ${binary}.`, true)

  if (binary === 'cargo' && ['test', 'check', 'build', 'clippy', 'fmt'].includes(lowerArgs[0] ?? '')) return result('allow', `cargo ${lowerArgs[0]}.`, true)
  if (binary === 'go' && ['test', 'vet', 'build'].includes(lowerArgs[0] ?? '')) return result('allow', `go ${lowerArgs[0]}.`, true)
  if (binary === 'dotnet' && ['test', 'build'].includes(lowerArgs[0] ?? '')) return result('allow', `dotnet ${lowerArgs[0]}.`, true)
  if ((binary === 'mvn' || binary === 'gradle' || binary === 'gradlew') && lowerArgs.some((arg) => ['test', 'check', 'compile', 'build'].includes(arg))) {
    return result('allow', `${binary} build/test.`, true)
  }

  return result('approval', `"${binary}" is not on the allowlist.`)
}
