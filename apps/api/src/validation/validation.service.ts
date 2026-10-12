import { Injectable } from '@nestjs/common'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { PrismaService } from '../common/prisma.service.js'
import type { RepoScanSummary } from '../orchestrator/repo-scanner.service.js'

const execFileAsync = promisify(execFile)

interface ValidationResult {
  command: string
  status: 'passed' | 'failed' | 'skipped'
  outputSummary: string
}

@Injectable()
export class ValidationService {
  constructor(private readonly prisma: PrismaService) {}

  planFromScan(scan: RepoScanSummary) {
    const scripts = scan.scripts
    const manager = scan.packageManager ?? 'npm'
    const commands: string[] = []
    const unavailableReasons: string[] = []
    const isPnpmWorkspace = manager === 'pnpm' && scan.importantFiles.includes('pnpm-workspace.yaml')

    for (const script of ['typecheck', 'lint', 'test', 'build']) {
      if (scripts[script]) {
        const command = this.packageCommand(manager, script, isPnpmWorkspace)
        if (command) commands.push(command)
        else unavailableReasons.push('Build is skipped during live workspace validation because it writes artifacts and can restart the API watcher.')
      } else {
        unavailableReasons.push(`No ${script} script found in package.json.`)
      }
    }

    if (commands.length === 0 && Object.keys(scripts).length === 0) {
      unavailableReasons.push('No package scripts detected; validation can only review static diff metadata.')
    }

    return { commands, unavailableReasons }
  }

  async validateTask(taskId: string, execute = false) {
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: { project: true } })
    const scan = task.project.techStack as unknown as RepoScanSummary
    const plan = this.planFromScan(scan)
    if (!execute) {
      return {
        execute,
        commands: plan.commands,
        unavailableReasons: plan.unavailableReasons,
        results: plan.commands.map((command) => ({
          command,
          status: 'skipped',
          outputSummary: 'Execution disabled. Command is planned but not run.',
        })),
      }
    }

    const results: ValidationResult[] = []
    results.push(...(await this.runCommands(plan.commands, task.project.repoPath)))

    return {
      execute,
      commands: plan.commands,
      unavailableReasons: plan.unavailableReasons,
      results,
    }
  }

  async runCommands(commands: string[], cwd: string): Promise<ValidationResult[]> {
    const results: ValidationResult[] = []
    for (const command of commands) {
      results.push(await this.runCommand(command, cwd))
    }
    return results
  }

  private packageCommand(manager: string, script: string, isPnpmWorkspace = false): string | null {
    if (isPnpmWorkspace) {
      if (script === 'build') return null
      return `pnpm -r --filter ./packages/** --filter ./apps/** ${script}`
    }
    if (manager === 'npm') return `npm run ${script}`
    if (manager === 'yarn') return `yarn ${script}`
    if (manager === 'bun') return `bun run ${script}`
    return `pnpm ${script}`
  }

  private async runCommand(command: string, cwd: string): Promise<ValidationResult> {
    const liveCommand = this.liveSafeCommand(command, cwd)
    if (!liveCommand) {
      return {
        command,
        status: 'skipped',
        outputSummary: 'Skipped during live workspace validation because the command writes build artifacts.',
      }
    }

    const [binary, ...args] = liveCommand.split(' ')
    if (!binary) {
      return { command, status: 'failed', outputSummary: 'Invalid command.' }
    }

    try {
      const result = process.platform === 'win32'
        ? await execFileAsync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', liveCommand], {
            cwd,
            timeout: 120_000,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
          })
        : await execFileAsync(binary, args, {
        cwd,
        timeout: 120_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      })
      return {
        command: liveCommand,
        status: this.summarizeOutput(`${result.stdout}\n${result.stderr}`).includes('No projects matched') ? 'failed' : 'passed',
        outputSummary: this.summarizeOutput(`${result.stdout}\n${result.stderr}`),
      }
    } catch (error) {
      const message = this.errorOutput(error)
      return {
        command,
        status: 'failed',
        outputSummary: this.summarizeOutput(message),
      }
    }
  }

  private liveSafeCommand(command: string, cwd: string): string | null {
    const normalizedCommand = command
      .replaceAll('"./packages/**"', './packages/**')
      .replaceAll('"./apps/**"', './apps/**')
    const isPnpmWorkspace = existsSync(path.join(cwd, 'pnpm-workspace.yaml'))
    if (!isPnpmWorkspace) return normalizedCommand
    if (normalizedCommand === 'pnpm typecheck') return 'pnpm -r --filter ./packages/** --filter ./apps/** typecheck'
    if (normalizedCommand === 'pnpm lint') return 'pnpm -r --filter ./packages/** --filter ./apps/** lint'
    if (normalizedCommand === 'pnpm test') return 'pnpm -r --filter ./packages/** --filter ./apps/** test'
    if (normalizedCommand === 'pnpm build') return null
    return normalizedCommand
  }

  private errorOutput(error: unknown): string {
    if (error && typeof error === 'object') {
      const withOutput = error as { stdout?: unknown; stderr?: unknown; message?: unknown }
      const output = [withOutput.stdout, withOutput.stderr, withOutput.message].filter(Boolean).join('\n')
      if (output) return output
    }
    return error instanceof Error ? error.message : String(error)
  }

  private summarizeOutput(output: string): string {
    return output.replace(/\s+/g, ' ').slice(0, 1200)
  }
}
