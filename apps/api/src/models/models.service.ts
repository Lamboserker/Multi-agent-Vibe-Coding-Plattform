import { Injectable } from '@nestjs/common'
import { ModelClass, ProviderType, Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma.service.js'
import { ProvidersService } from '../providers/providers.service.js'

interface UpsertModelProviderDto {
  name: string
  providerType: ProviderType
  modelClass: ModelClass
  baseUrl?: string
  apiKeyEnvName?: string
  enabled?: boolean
  supportsStreaming?: boolean
  supportsToolUse?: boolean
  supportsStructuredOutput?: boolean
  contextWindow?: number
  costInputPerMillion?: number
  costOutputPerMillion?: number
  freeQuotaDaily?: number
  notes?: string
}

@Injectable()
export class ModelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProvidersService,
  ) {}

  async findAll() {
    await this.ensureDefaults()
    return this.prisma.modelProvider.findMany({ orderBy: [{ modelClass: 'asc' }, { name: 'asc' }] })
  }

  async availability() {
    await this.ensureDefaults()
    const providers = await this.prisma.modelProvider.findMany({ orderBy: [{ modelClass: 'asc' }, { name: 'asc' }] })
    return {
      localAvailable: providers.some((provider) => provider.enabled && provider.modelClass === ModelClass.local_llm),
      freeQuotaAvailable: providers.some((provider) => provider.enabled && provider.modelClass === ModelClass.free_llm),
      cheapApiAvailable: providers.some((provider) => provider.enabled && provider.modelClass === ModelClass.cheap_api_llm),
      premiumAvailable: providers.some((provider) => provider.enabled && provider.modelClass === ModelClass.premium_llm),
      providers,
    }
  }

  async create(dto: UpsertModelProviderDto) {
    return this.prisma.modelProvider.create({ data: this.toCreateData(dto) })
  }

  async update(id: string, dto: Partial<UpsertModelProviderDto>) {
    return this.prisma.modelProvider.update({ where: { id }, data: this.toUpdateData(dto) })
  }

  async testConnection(body: { providerType: ProviderType; baseUrl?: string; apiKeyEnvName?: string }) {
    if (body.providerType === 'ollama') return this.providers.testOllama(body)
    if (body.providerType === 'openai_compatible') return this.providers.testOpenAICompatible(body)
    if (body.providerType === 'gemini_cli') return this.providers.testGeminiCli()
    return { ok: false, message: 'Provider type has no active test adapter.' }
  }

  async ensureDefaults() {
    const defaults: UpsertModelProviderDto[] = [
      {
        name: 'Ollama Gemma 4 E4B',
        providerType: ProviderType.ollama,
        modelClass: ModelClass.local_llm,
        baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
        enabled: true,
        supportsStreaming: true,
        supportsToolUse: false,
        supportsStructuredOutput: false,
        contextWindow: 128000,
        costInputPerMillion: 0,
        costOutputPerMillion: 0,
        notes: 'Local Ollama-compatible strategy for Gemma/Qwen/DeepSeek/CodeLlama-class coder models.',
      },
      {
        name: 'Ollama Qwen Coder',
        providerType: ProviderType.ollama,
        modelClass: ModelClass.local_llm,
        baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
        enabled: true,
        supportsStreaming: true,
        contextWindow: 128000,
        costInputPerMillion: 0,
        costOutputPerMillion: 0,
        notes: 'Local Qwen Coder fallback, configurable per machine.',
      },
      {
        name: 'Gemini CLI / Code Assist',
        providerType: ProviderType.gemini_cli,
        modelClass: ModelClass.free_llm,
        enabled: true,
        supportsStreaming: true,
        contextWindow: 1000000,
        freeQuotaDaily: 50,
        notes: 'Optional free-quota adapter. The API never stores client-side provider secrets.',
      },
      {
        name: 'OpenRouter Free Pool',
        providerType: ProviderType.openai_compatible,
        modelClass: ModelClass.free_llm,
        baseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
        apiKeyEnvName: 'OPENROUTER_API_KEY',
        enabled: true,
        supportsStreaming: true,
        contextWindow: 128000,
        freeQuotaDaily: 20,
        notes: 'OpenRouter free-pool adapter. Requires a valid server-side key and terms-compliant free model.',
      },
      {
        name: 'DeepSeek Coder API',
        providerType: ProviderType.openai_compatible,
        modelClass: ModelClass.cheap_api_llm,
        baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
        apiKeyEnvName: 'DEEPSEEK_API_KEY',
        enabled: true,
        supportsStreaming: true,
        supportsStructuredOutput: true,
        contextWindow: 128000,
        costInputPerMillion: 0.14,
        costOutputPerMillion: 0.28,
        notes: 'Low-cost implementation tier for bounded coding subtasks.',
      },
      {
        name: 'Qwen API Coder',
        providerType: ProviderType.openai_compatible,
        modelClass: ModelClass.cheap_api_llm,
        baseUrl: process.env.QWEN_BASE_URL ?? process.env.QWEN_API_BASE_URL ?? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        apiKeyEnvName: 'QWEN_API_KEY',
        enabled: true,
        supportsStreaming: true,
        supportsStructuredOutput: true,
        contextWindow: 128000,
        costInputPerMillion: 0.2,
        costOutputPerMillion: 0.6,
        notes: 'OpenAI-compatible cheap coder model slot.',
      },
      {
        name: 'Premium Architecture Reviewer',
        providerType: ProviderType.openai_compatible,
        modelClass: ModelClass.premium_llm,
        baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        apiKeyEnvName: 'OPENAI_API_KEY',
        enabled: true,
        supportsStreaming: true,
        supportsToolUse: true,
        supportsStructuredOutput: true,
        contextWindow: 200000,
        costInputPerMillion: 3,
        costOutputPerMillion: 12,
        notes: 'For architecture, security, auth, payment, database migrations, and repeated low-cost failures. Not a default worker.',
      },
    ]

    const count = await this.prisma.modelProvider.count()
    if (count === 0) {
      await this.prisma.modelProvider.createMany({
        data: defaults.map((item) => this.toCreateManyData(item)),
      })
      return
    }

    for (const item of defaults) {
      const existing = await this.prisma.modelProvider.findFirst({ where: { name: item.name } })
      if (!existing) {
        await this.prisma.modelProvider.create({ data: this.toCreateData(item) })
        continue
      }

      const repair: Partial<UpsertModelProviderDto> = {}
      const envBaseUrl = this.baseUrlOverride(item.name)
      if (envBaseUrl && existing.baseUrl !== envBaseUrl) {
        repair.baseUrl = envBaseUrl
      } else if (!existing.baseUrl && item.baseUrl) {
        repair.baseUrl = item.baseUrl
      }
      if (!existing.apiKeyEnvName && item.apiKeyEnvName) repair.apiKeyEnvName = item.apiKeyEnvName
      if (!existing.contextWindow && item.contextWindow) repair.contextWindow = item.contextWindow
      if (!existing.costInputPerMillion && item.costInputPerMillion !== undefined) {
        repair.costInputPerMillion = item.costInputPerMillion
      }
      if (!existing.costOutputPerMillion && item.costOutputPerMillion !== undefined) {
        repair.costOutputPerMillion = item.costOutputPerMillion
      }

      if (Object.keys(repair).length) {
        await this.prisma.modelProvider.update({ where: { id: existing.id }, data: this.toUpdateData(repair) })
      }
    }
  }

  private baseUrlOverride(providerName: string) {
    if (providerName === 'OpenRouter Free Pool') return process.env.OPENROUTER_BASE_URL
    if (providerName === 'DeepSeek Coder API') return process.env.DEEPSEEK_BASE_URL
    if (providerName === 'Qwen API Coder') return process.env.QWEN_BASE_URL ?? process.env.QWEN_API_BASE_URL
    if (providerName === 'Premium Architecture Reviewer') return process.env.OPENAI_BASE_URL
    return undefined
  }

  private toCreateData(dto: UpsertModelProviderDto): Prisma.ModelProviderCreateInput {
    return {
      ...dto,
      costInputPerMillion:
        dto.costInputPerMillion === undefined ? undefined : new Prisma.Decimal(dto.costInputPerMillion),
      costOutputPerMillion:
        dto.costOutputPerMillion === undefined ? undefined : new Prisma.Decimal(dto.costOutputPerMillion),
    }
  }

  private toCreateManyData(dto: UpsertModelProviderDto): Prisma.ModelProviderCreateManyInput {
    return this.toCreateData(dto) as Prisma.ModelProviderCreateManyInput
  }

  private toUpdateData(dto: Partial<UpsertModelProviderDto>): Prisma.ModelProviderUpdateInput {
    return {
      ...dto,
      costInputPerMillion:
        dto.costInputPerMillion === undefined ? undefined : new Prisma.Decimal(dto.costInputPerMillion),
      costOutputPerMillion:
        dto.costOutputPerMillion === undefined ? undefined : new Prisma.Decimal(dto.costOutputPerMillion),
    }
  }
}
