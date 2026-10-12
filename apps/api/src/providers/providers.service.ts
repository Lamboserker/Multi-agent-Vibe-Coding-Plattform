import { Injectable } from '@nestjs/common'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

@Injectable()
export class ProvidersService {
  async testOllama(body: { baseUrl?: string }) {
    const baseUrl = body.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, { method: 'GET' })
      if (!response.ok) return { ok: false, message: `Ollama returned HTTP ${response.status}.` }
      const data = (await response.json()) as { models?: Array<{ name?: string }> }
      return {
        ok: true,
        message: 'Ollama is reachable.',
        models: (data.models ?? []).map((model) => model.name).filter(Boolean).slice(0, 20),
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  async testOpenAICompatible(body: { baseUrl?: string; apiKeyEnvName?: string }) {
    if (!body.baseUrl) return { ok: false, message: 'baseUrl is required for OpenAI-compatible providers.' }
    const apiKey = body.apiKeyEnvName ? process.env[body.apiKeyEnvName] : undefined
    if (body.apiKeyEnvName && !apiKey) {
      return { ok: false, message: `Server env var ${body.apiKeyEnvName} is not set.` }
    }

    try {
      const response = await fetch(`${body.baseUrl.replace(/\/$/, '')}/models`, {
        method: 'GET',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      })
      if (!response.ok) return { ok: false, message: `Provider returned HTTP ${response.status}.` }
      const data = (await response.json()) as { data?: Array<{ id?: string }> }
      return {
        ok: true,
        message: 'OpenAI-compatible model endpoint is reachable.',
        models: (data.data ?? []).map((model) => model.id).filter(Boolean).slice(0, 20),
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  async testGeminiCli() {
    try {
      const result = await execFileAsync('gemini', ['--version'], {
        timeout: 10_000,
        windowsHide: true,
      })
      return {
        ok: true,
        message: 'Gemini CLI is installed.',
        version: `${result.stdout}${result.stderr}`.trim(),
      }
    } catch (error) {
      return {
        ok: false,
        message: 'Gemini CLI is not available on PATH or did not respond.',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
