import { Injectable } from '@nestjs/common'
import path from 'node:path'
import {
  buildContextDigest,
  buildRepoIndex,
  detectValidationChecks,
  loadIndexCache,
  saveIndexCache,
  type RepoIndex,
  type ValidationCheck,
} from '@multi-ai-coder/engine'
import { runtimeConfig } from '../runtime/runtime-config.js'

/** Deterministic repository analysis with a per-project incremental index cache. */
@Injectable()
export class RepoContextService {
  private readonly memory = new Map<string, RepoIndex>()

  async index(projectId: string, repoPath: string): Promise<RepoIndex> {
    const cacheFile = path.join(runtimeConfig().cacheDir, `index-${projectId}.json`)
    const previous = this.memory.get(projectId) ?? (await loadIndexCache(cacheFile))
    const index = await buildRepoIndex(repoPath, previous)
    this.memory.set(projectId, index)
    await saveIndexCache(cacheFile, index).catch(() => undefined)
    return index
  }

  checks(repoPath: string): ValidationCheck[] {
    return detectValidationChecks(repoPath)
  }

  async digest(projectId: string, repoPath: string, goal: string, budgetTokens = 6000) {
    const index = await this.index(projectId, repoPath)
    const checks = this.checks(repoPath)
    const digest = await buildContextDigest(index, goal, { budgetTokens, validationCommands: checks.map((check) => check.command) })
    return { index, checks, digest }
  }
}
