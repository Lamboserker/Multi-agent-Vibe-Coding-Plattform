import { Injectable } from '@nestjs/common'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DEFAULT_IGNORES, isSecretLikePath, toRelativePath } from '../common/fs-safety.js'

export interface RepoScanSummary {
  repoPath: string
  exists: boolean
  packageManager?: string
  defaultBranch?: string
  frameworks: string[]
  scripts: Record<string, string>
  dependencies: string[]
  importantFiles: string[]
  apiRoutes: string[]
  databaseSchemas: string[]
  testFiles: string[]
  docs: string[]
  directories: string[]
  warnings: string[]
}

@Injectable()
export class RepoScannerService {
  async scan(repoPath: string): Promise<RepoScanSummary> {
    const root = path.resolve(repoPath)
    const summary: RepoScanSummary = {
      repoPath: root,
      exists: false,
      frameworks: [],
      scripts: {},
      dependencies: [],
      importantFiles: [],
      apiRoutes: [],
      databaseSchemas: [],
      testFiles: [],
      docs: [],
      directories: [],
      warnings: [],
    }

    try {
      const stat = await fs.stat(root)
      summary.exists = stat.isDirectory()
    } catch {
      summary.warnings.push('Repository path does not exist or is not accessible.')
      return summary
    }

    summary.packageManager = await this.detectPackageManager(root)
    summary.defaultBranch = await this.detectGitBranch(root)

    const files = await this.walk(root, root, 900)
    summary.directories = await this.topLevelDirectories(root)
    summary.importantFiles = files.filter((file) => this.isImportantFile(file)).slice(0, 80)
    summary.apiRoutes = files.filter((file) => this.isApiRoute(file)).slice(0, 80)
    summary.databaseSchemas = files.filter((file) => this.isDatabaseSchema(file)).slice(0, 40)
    summary.testFiles = files.filter((file) => this.isTestFile(file)).slice(0, 120)
    summary.docs = files.filter((file) => this.isDocumentation(file)).slice(0, 50)

    const packageJsonPath = path.join(root, 'package.json')
    try {
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as {
        scripts?: Record<string, string>
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      summary.scripts = packageJson.scripts ?? {}
      const deps = {
        ...(packageJson.dependencies ?? {}),
        ...(packageJson.devDependencies ?? {}),
      }
      summary.dependencies = Object.keys(deps).sort()
      summary.frameworks = this.detectFrameworks(summary.dependencies, files)
    } catch {
      summary.warnings.push('No readable package.json found; scanner will rely on filesystem hints.')
      summary.frameworks = this.detectFrameworks([], files)
    }

    return summary
  }

  private async walk(root: string, current: string, limit: number, acc: string[] = []): Promise<string[]> {
    if (acc.length >= limit) return acc

    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return acc
    }

    for (const entry of entries) {
      if (acc.length >= limit) break
      const absolute = path.join(current, entry.name)
      const relative = toRelativePath(root, absolute)
      if (entry.isDirectory()) {
        if (!DEFAULT_IGNORES.has(entry.name)) {
          await this.walk(root, absolute, limit, acc)
        }
        continue
      }

      if (!entry.isFile() || isSecretLikePath(relative)) {
        continue
      }
      acc.push(relative)
    }

    return acc
  }

  private async topLevelDirectories(root: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isDirectory() && !DEFAULT_IGNORES.has(entry.name))
        .map((entry) => entry.name)
        .sort()
    } catch {
      return []
    }
  }

  private async detectPackageManager(root: string): Promise<string | undefined> {
    const candidates: Array<[string, string]> = [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['package-lock.json', 'npm'],
      ['bun.lockb', 'bun'],
      ['bun.lock', 'bun'],
    ]

    for (const [file, manager] of candidates) {
      try {
        await fs.access(path.join(root, file))
        return manager
      } catch {
        // keep checking
      }
    }
    return undefined
  }

  private async detectGitBranch(root: string): Promise<string | undefined> {
    try {
      const head = await fs.readFile(path.join(root, '.git', 'HEAD'), 'utf8')
      const match = head.match(/refs\/heads\/(.+)$/)
      return match?.[1]?.trim()
    } catch {
      return undefined
    }
  }

  private detectFrameworks(dependencies: string[], files: string[]): string[] {
    const deps = new Set(dependencies)
    const frameworks = new Set<string>()
    if (deps.has('next')) frameworks.add('Next.js')
    if (deps.has('react')) frameworks.add('React')
    if (deps.has('@nestjs/core')) frameworks.add('NestJS')
    if (deps.has('express')) frameworks.add('Express')
    if (deps.has('@prisma/client') || files.some((file) => file === 'prisma/schema.prisma')) frameworks.add('Prisma')
    if (deps.has('bullmq')) frameworks.add('BullMQ')
    if (deps.has('vite')) frameworks.add('Vite')
    if (files.some((file) => file.includes('docker-compose'))) frameworks.add('Docker Compose')
    return [...frameworks]
  }

  private isImportantFile(file: string): boolean {
    return [
      'package.json',
      'pnpm-workspace.yaml',
      'turbo.json',
      'tsconfig.json',
      'docker-compose.yml',
      'Dockerfile',
      'next.config.ts',
      'vite.config.ts',
      'nest-cli.json',
      'README.md',
    ].some((candidate) => file.endsWith(candidate))
  }

  private isApiRoute(file: string): boolean {
    return (
      /(^|\/)app\/api\/.+\/route\.(ts|js)$/.test(file) ||
      /(^|\/)pages\/api\/.+\.(ts|js)$/.test(file) ||
      /controller\.(ts|js)$/.test(file) ||
      /routes?\.(ts|js)$/.test(file)
    )
  }

  private isDatabaseSchema(file: string): boolean {
    return file === 'prisma/schema.prisma' || file.endsWith('.schema.prisma') || file.includes('/migrations/')
  }

  private isTestFile(file: string): boolean {
    return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(file) || file.includes('__tests__/')
  }

  private isDocumentation(file: string): boolean {
    return /(^|\/)(README|CHANGELOG|ARCHITECTURE|CONTRIBUTING)\.md$/i.test(file) || file.startsWith('docs/')
  }
}
