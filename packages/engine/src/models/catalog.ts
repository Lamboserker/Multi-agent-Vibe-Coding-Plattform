import type { HardwareProfile } from '../hardware/detect.js'
import { usableVramMb } from '../hardware/detect.js'

/**
 * Candidate coding model families. This list is only the *starting point* for discovery
 * (researched 2026-10); download sizes and tool-calling support are verified live against the
 * Ollama registry, and installed models are inspected via /api/show. Users can add any model.
 */
export interface CandidateModel {
  name: string
  tags: string[]
  family: string
  license: string
  /** Free-text strengths, shown to the user. */
  notes: string
  /** Rough quality tier for coding tasks, used only to order candidates within a size budget. */
  codingTier: 1 | 2 | 3 | 4
  agentic: boolean
  completionOnly?: boolean
}

export const CATALOG_RESEARCHED_AT = '2026-10-09'

export const CANDIDATE_MODELS: CandidateModel[] = [
  {
    name: 'qwen2.5-coder',
    tags: ['0.5b', '1.5b', '3b', '7b', '14b', '32b'],
    family: 'Qwen Coder',
    license: 'Apache-2.0 (3B: Qwen Research License)',
    notes: 'Code-specialised, wide size range, tool template, good for small edits and boilerplate.',
    codingTier: 2,
    agentic: false,
  },
  {
    name: 'qwen3-coder',
    tags: ['30b'],
    family: 'Qwen Coder',
    license: 'Apache-2.0',
    notes: 'MoE (~3.3B active) coding/agentic model with long context; ~19 GB at Q4.',
    codingTier: 4,
    agentic: true,
  },
  {
    name: 'qwen3',
    tags: ['1.7b', '4b', '8b', '14b'],
    family: 'Qwen 3',
    license: 'Apache-2.0',
    notes: 'General model with reliable tool calling and optional thinking; solid small-agent default.',
    codingTier: 2,
    agentic: true,
  },
  {
    name: 'devstral',
    tags: ['24b'],
    family: 'Mistral Devstral',
    license: 'Apache-2.0',
    notes: 'Built for agentic software-engineering loops (multi-file edits, tool use).',
    codingTier: 4,
    agentic: true,
  },
  {
    name: 'gpt-oss',
    tags: ['20b'],
    family: 'OpenAI gpt-oss',
    license: 'Apache-2.0',
    notes: 'MXFP4 open-weight model with native tool calling; fits in ~16 GB.',
    codingTier: 3,
    agentic: true,
  },
  {
    name: 'deepseek-coder-v2',
    tags: ['16b'],
    family: 'DeepSeek Coder',
    license: 'DeepSeek License (use restrictions apply)',
    notes: 'MoE Lite variant; strong code completion, limited tool support.',
    codingTier: 3,
    agentic: false,
  },
  {
    name: 'starcoder2',
    tags: ['3b', '7b', '15b'],
    family: 'StarCoder',
    license: 'BigCode OpenRAIL-M',
    notes: 'Completion model without chat/tool template; not suited for instruction-driven agent tasks.',
    codingTier: 1,
    agentic: false,
    completionOnly: true,
  },
  {
    name: 'codellama',
    tags: ['7b', '13b'],
    family: 'Code Llama',
    license: 'Llama 2 Community License',
    notes: 'Older generation; kept for compatibility, superseded by newer coders.',
    codingTier: 1,
    agentic: false,
  },
]

export interface RegistryModelInfo {
  model: string
  exists: boolean
  downloadBytes?: number
  /** "yes" = the chat template references tools; "no" = template without tools; "unknown" = no template layer. */
  toolTemplate: 'yes' | 'no' | 'unknown'
  error?: string
}

const REGISTRY = 'https://registry.ollama.ai/v2/library'

/** Looks up a model in the public Ollama registry (manifest = real layer sizes, template = tool support). */
export async function lookupRegistryModel(model: string, fetchImpl: typeof fetch = fetch): Promise<RegistryModelInfo> {
  const [name, tag = 'latest'] = model.split(':')
  if (!name || !/^[a-z0-9._-]+(\/[a-z0-9._-]+)?$/i.test(name) || !/^[a-z0-9._-]+$/i.test(tag)) {
    return { model, exists: false, toolTemplate: 'unknown', error: 'Invalid model name.' }
  }
  const repository = name.includes('/') ? name : name
  const base = name.includes('/') ? 'https://registry.ollama.ai/v2' : REGISTRY
  try {
    const response = await fetchImpl(`${base}/${repository}/manifests/${tag}`, {
      headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 404) return { model, exists: false, toolTemplate: 'unknown' }
    if (!response.ok) return { model, exists: false, toolTemplate: 'unknown', error: `Registry HTTP ${response.status}` }
    const manifest = (await response.json()) as { layers?: Array<{ mediaType: string; size: number; digest: string }> }
    const layers = manifest.layers ?? []
    const downloadBytes = layers.reduce((sum, layer) => sum + layer.size, 0)
    const template = layers.find((layer) => layer.mediaType.endsWith('.template'))
    let toolTemplate: RegistryModelInfo['toolTemplate'] = 'unknown'
    if (template && template.size < 256 * 1024) {
      const blob = await fetchImpl(`${base}/${repository}/blobs/${template.digest}`, { signal: AbortSignal.timeout(15_000) })
      if (blob.ok) toolTemplate = /\.Tools\b|\btools\b/.test(await blob.text()) ? 'yes' : 'no'
    }
    return { model, exists: true, downloadBytes, toolTemplate }
  } catch (error) {
    return { model, exists: false, toolTemplate: 'unknown', error: error instanceof Error ? error.message : String(error) }
  }
}

export type ModelRole = 'fast' | 'balanced' | 'advanced'

export type FitLevel = 'gpu' | 'partial_offload' | 'cpu' | 'too_large'

export interface ModelRecommendation {
  model: string
  family: string
  license: string
  notes: string
  downloadBytes: number
  estimatedMemoryBytes: number
  fit: FitLevel
  fitExplanation: string
  diskOk: boolean
  toolCalling: 'verified' | 'template' | 'unknown' | 'none'
  roles: ModelRole[]
  recommended: boolean
  completionOnly: boolean
}

/**
 * Memory estimate: weights (≈ download size) + KV cache / runtime overhead. The overhead factor is
 * an approximation (labelled as such in the UI); actual usage is read from /api/ps once loaded.
 */
export function estimateRuntimeMemory(downloadBytes: number, contextTokens = 16_384): number {
  const kvCache = contextTokens * 0.000125 * 1024 ** 3 * Math.min(2, Math.max(0.5, downloadBytes / (8 * 1024 ** 3)))
  return Math.round(downloadBytes * 1.1 + kvCache + 0.4 * 1024 ** 3)
}

export function classifyFit(memoryBytes: number, profile: HardwareProfile): { fit: FitLevel; explanation: string } {
  const vramMb = usableVramMb(profile)
  const ramBytes = profile.memory.totalBytes
  const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (vramMb) {
    const vramBytes = vramMb * 1024 * 1024 * 0.92
    if (memoryBytes <= vramBytes) return { fit: 'gpu', explanation: `~${gb(memoryBytes)} fits into ${gb(vramMb * 1024 * 1024)} VRAM.` }
    if (memoryBytes <= vramBytes + ramBytes * 0.5) {
      return { fit: 'partial_offload', explanation: `~${gb(memoryBytes)} exceeds VRAM; layers are split between GPU and RAM (noticeably slower).` }
    }
  } else if (memoryBytes <= ramBytes * 0.6) {
    return { fit: 'cpu', explanation: `No reliable GPU memory detected; ~${gb(memoryBytes)} runs on CPU/RAM (slow).` }
  }
  return { fit: 'too_large', explanation: `~${gb(memoryBytes)} does not fit into available VRAM/RAM.` }
}

export interface RecommendationInput {
  profile: HardwareProfile
  registry: RegistryModelInfo[]
  installed?: Array<{ name: string; size: number; capabilities?: string[] }>
}

/** Assigns roles (fast / balanced / advanced) to verified candidates that fit the hardware. */
export function recommendModels(input: RecommendationInput): ModelRecommendation[] {
  const freeDisk = input.profile.disks.ollamaModels?.freeBytes
  const installedNames = new Set((input.installed ?? []).map((model) => model.name))
  const recommendations: ModelRecommendation[] = []

  for (const info of input.registry) {
    if (!info.exists || !info.downloadBytes) continue
    const [name] = info.model.split(':')
    const candidate = CANDIDATE_MODELS.find((model) => model.name === name)
    const installed = input.installed?.find((model) => model.name === info.model)
    const memory = estimateRuntimeMemory(info.downloadBytes)
    const { fit, explanation } = classifyFit(memory, input.profile)
    const diskOk = installedNames.has(info.model) || freeDisk === undefined || freeDisk > info.downloadBytes + 2 * 1024 ** 3
    const toolCalling: ModelRecommendation['toolCalling'] = installed?.capabilities
      ? installed.capabilities.includes('tools')
        ? 'verified'
        : 'none'
      : info.toolTemplate === 'yes'
        ? 'template'
        : info.toolTemplate === 'no'
          ? 'none'
          : 'unknown'
    recommendations.push({
      model: info.model,
      family: candidate?.family ?? name ?? info.model,
      license: candidate?.license ?? 'see model card',
      notes: candidate?.notes ?? '',
      downloadBytes: info.downloadBytes,
      estimatedMemoryBytes: memory,
      fit,
      fitExplanation: explanation,
      diskOk,
      toolCalling,
      roles: [],
      recommended: false,
      completionOnly: candidate?.completionOnly ?? false,
    })
  }

  const usable = recommendations.filter((rec) => rec.fit !== 'too_large' && !rec.completionOnly && rec.diskOk)
  const tierOf = (rec: ModelRecommendation) => CANDIDATE_MODELS.find((model) => rec.model.startsWith(`${model.name}:`))?.codingTier ?? 2
  const score = (rec: ModelRecommendation) =>
    tierOf(rec) * 10 + (rec.toolCalling === 'verified' || rec.toolCalling === 'template' ? 5 : 0) + (rec.fit === 'gpu' ? 4 : rec.fit === 'partial_offload' ? 1 : 0)

  const pick = (filter: (rec: ModelRecommendation) => boolean, sort: (a: ModelRecommendation, b: ModelRecommendation) => number) =>
    usable.filter(filter).sort(sort)[0]

  const gpuOrCpu = (rec: ModelRecommendation) => rec.fit === 'gpu' || rec.fit === 'cpu'
  const fast = pick(
    (rec) => gpuOrCpu(rec) && rec.downloadBytes <= 3.2 * 1024 ** 3 && rec.toolCalling !== 'none',
    (a, b) => score(b) - score(a) || b.downloadBytes - a.downloadBytes,
  )
  const balanced = pick(
    (rec) => gpuOrCpu(rec) && rec.downloadBytes <= 9.5 * 1024 ** 3 && rec.downloadBytes > 3.2 * 1024 ** 3 && rec.toolCalling !== 'none',
    (a, b) => score(b) - score(a) || b.downloadBytes - a.downloadBytes,
  )
  const advanced = pick(
    (rec) => rec.downloadBytes > 9.5 * 1024 ** 3 && rec.toolCalling !== 'none',
    (a, b) => score(b) - score(a) || a.downloadBytes - b.downloadBytes,
  )

  // On weak hardware one model takes several roles.
  const assignments: Array<[ModelRole, ModelRecommendation | undefined]> = [
    ['fast', fast],
    ['balanced', balanced ?? fast],
    ['advanced', advanced ?? balanced ?? fast],
  ]
  for (const [role, rec] of assignments) {
    if (!rec) continue
    rec.roles.push(role)
    rec.recommended = true
  }
  return recommendations.sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.downloadBytes - b.downloadBytes)
}

export function candidateModelNames(): string[] {
  return CANDIDATE_MODELS.flatMap((model) => model.tags.map((tag) => `${model.name}:${tag}`))
}
