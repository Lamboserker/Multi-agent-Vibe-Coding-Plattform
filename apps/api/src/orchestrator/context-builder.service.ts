import { Injectable } from '@nestjs/common'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PrismaService } from '../common/prisma.service.js'
import { isSecretLikePath, redactSecrets } from '../common/fs-safety.js'
import { RepoScannerService, type RepoScanSummary } from './repo-scanner.service.js'

interface ContextBuildInput {
  taskId: string
  projectId: string
  repoPath: string
  userPrompt: string
  scan?: RepoScanSummary
}

@Injectable()
export class ContextBuilderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repoScanner: RepoScannerService,
  ) {}

  async build(input: ContextBuildInput) {
    const scan = input.scan ?? (await this.repoScanner.scan(input.repoPath))
    const relevantFiles = this.selectRelevantFiles(input.userPrompt, scan)
    const snippets = await this.readSnippets(scan.repoPath, relevantFiles)
    const summary = [
      `Repo: ${scan.repoPath}`,
      `Stack: ${scan.frameworks.join(', ') || 'unknown'}`,
      `Package manager: ${scan.packageManager ?? 'unknown'}`,
      `Relevant files: ${relevantFiles.join(', ') || 'none'}`,
      `Validation scripts: ${Object.keys(scan.scripts).filter((script) => ['lint', 'typecheck', 'test', 'build'].includes(script)).join(', ') || 'none'}`,
      snippets.length ? `Snippets:\n${snippets.join('\n\n')}` : 'Snippets: none selected',
    ].join('\n')

    const tokenEstimate = Math.ceil(summary.length / 4)
    return this.prisma.contextSnapshot.create({
      data: {
        taskId: input.taskId,
        projectId: input.projectId,
        summary,
        relevantFiles,
        tokenEstimate,
      },
    })
  }

  selectRelevantFiles(userPrompt: string, scan: RepoScanSummary): string[] {
    const tokens = this.keywords(userPrompt)
    const candidateSet = new Set([
      ...scan.importantFiles,
      ...scan.apiRoutes,
      ...scan.databaseSchemas,
      ...scan.docs.slice(0, 6),
      ...scan.testFiles.slice(0, 20),
    ])

    const scored = [...candidateSet]
      .filter((file) => !isSecretLikePath(file))
      .map((file) => ({
        file,
        score: this.scoreFile(file, tokens, userPrompt),
      }))
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))

    const selected = scored.filter((item) => item.score > 0).slice(0, 16).map((item) => item.file)
    if (!selected.includes('package.json') && scan.importantFiles.includes('package.json')) {
      selected.unshift('package.json')
    }
    return [...new Set(selected)].slice(0, 18)
  }

  private async readSnippets(repoPath: string, relevantFiles: string[]): Promise<string[]> {
    const snippets: string[] = []
    for (const relative of relevantFiles.slice(0, 8)) {
      if (isSecretLikePath(relative) || !this.isTextFile(relative)) continue
      try {
        const absolute = path.join(repoPath, relative)
        const content = await fs.readFile(absolute, 'utf8')
        const trimmed = redactSecrets(content).slice(0, 2400)
        snippets.push(`--- ${relative}\n${trimmed}`)
      } catch {
        // File might have disappeared between scan and context build.
      }
    }
    return snippets
  }

  private keywords(value: string): string[] {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9_/.-]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 3)
      .slice(0, 80)
  }

  private scoreFile(file: string, tokens: string[], prompt: string): number {
    const lowerFile = file.toLowerCase()
    let score = 0
    for (const token of tokens) {
      if (lowerFile.includes(token)) score += token.length > 5 ? 3 : 1
    }
    if (file === 'package.json') score += 5
    if (prompt.includes('database') && file.includes('prisma')) score += 8
    if (prompt.includes('api') && /controller|route|api/.test(lowerFile)) score += 6
    if (prompt.includes('test') && /\.(test|spec)\./.test(lowerFile)) score += 6
    if (prompt.includes('dashboard') && /app|page|component/.test(lowerFile)) score += 4
    return score
  }

  private isTextFile(file: string): boolean {
    return /\.(ts|tsx|js|jsx|json|md|css|scss|prisma|yml|yaml|toml)$/.test(file)
  }
}
