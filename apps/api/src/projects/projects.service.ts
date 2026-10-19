import { BadRequestException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { isGitRepository } from '@multi-ai-coder/engine'
import { PrismaService } from '../common/prisma.service.js'
import { RepoScannerService } from '../orchestrator/repo-scanner.service.js'
import { SettingsService } from '../runtime/settings.service.js'
import { ensureRepository, WorkspaceFsService } from '../workspace-fs/workspace-fs.service.js'

interface CreateProjectDto {
  name: string
  repoPath: string
  defaultBranch?: string
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repoScanner: RepoScannerService,
    private readonly settings: SettingsService,
    private readonly files: WorkspaceFsService,
  ) {}

  async create(dto: CreateProjectDto) {
    const scan = await this.repoScanner.scan(dto.repoPath)
    if (!scan.exists) throw new BadRequestException(`Folder not found: ${dto.repoPath}`)
    return this.prisma.project.create({
      data: {
        name: dto.name,
        repoPath: scan.repoPath,
        defaultBranch: dto.defaultBranch ?? scan.defaultBranch ?? 'main',
        techStack: scan as unknown as Prisma.InputJsonValue,
        packageManager: scan.packageManager,
      },
    })
  }

  async link(dto: CreateProjectDto) {
    return this.create(dto)
  }

  /** Opens a folder from the file system (desktop): reuses the project record for the same path. */
  async open(folder: string, name?: string) {
    const repoPath = path.resolve(folder)
    if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) throw new BadRequestException(`Folder not found: ${folder}`)
    // agents need a repository with a commit: set it up when a project is opened (never rewrites history)
    const repository = await ensureRepository(repoPath).catch((error: unknown) => ({ initialized: false, committed: false, hasCommit: false, skipped: error instanceof Error ? error.message : String(error) }))
    const all = await this.prisma.project.findMany({ where: { repoPath } })
    let project = all[0] ?? (await this.create({ name: name ?? path.basename(repoPath), repoPath }))
    project = await this.prisma.project.update({ where: { id: project.id }, data: { lastOpenedAt: new Date() } })
    await this.settings.update({ lastProjectId: project.id })
    await this.files.watchProject(project.id)
    return { ...project, isGit: await isGitRepository(repoPath), repository }
  }

  async createNew(parentDir: string, name: string) {
    const target = await this.files.createNewProject(parentDir, name)
    return this.open(target, name)
  }

  async clone(url: string, parentDir: string, name?: string) {
    const target = await this.files.cloneProject(url, parentDir, name)
    return this.open(target)
  }

  async findAll() {
    return this.prisma.project.findMany({
      orderBy: [{ lastOpenedAt: 'desc' }, { createdAt: 'desc' }],
      include: { _count: { select: { tasks: true } } },
    })
  }

  async findOne(id: string) {
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id },
      include: { tasks: { orderBy: { createdAt: 'desc' }, take: 20 } },
    })
    return { ...project, isGit: await isGitRepository(project.repoPath).catch(() => false), exists: existsSync(project.repoPath) }
  }

  async remove(id: string) {
    // Removes the project record only; files on disk are never touched.
    await this.prisma.project.delete({ where: { id } })
    this.files.unwatch(id)
    return { ok: true }
  }

  async index(id: string) {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id } })
    const scan = await this.repoScanner.scan(project.repoPath)
    return this.prisma.project.update({
      where: { id },
      data: {
        techStack: scan as unknown as Prisma.InputJsonValue,
        packageManager: scan.packageManager,
        defaultBranch: scan.defaultBranch ?? project.defaultBranch,
      },
    })
  }
}
