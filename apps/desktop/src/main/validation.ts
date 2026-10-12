/**
 * Validation of everything that crosses the IPC boundary. The renderer is treated as untrusted:
 * it can only reach the local runtime through these narrow, validated channels.
 */

export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IpcValidationError'
  }
}

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const MAX_BODY_BYTES = 8 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function validateApiRequest(input: unknown): ApiRequest {
  if (!isRecord(input)) throw new IpcValidationError('Request must be an object.')
  const method = String(input.method ?? '').toUpperCase()
  if (!METHODS.has(method)) throw new IpcValidationError('Unsupported HTTP method.')
  const path = input.path
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.length > 4096) throw new IpcValidationError('Invalid API path.')
  if (/[\r\n\\\0]/.test(path)) throw new IpcValidationError('Invalid characters in API path.')
  const [pathname] = path.split('?')
  if (pathname!.split('/').some((segment) => segment === '..' || segment === '.')) throw new IpcValidationError('Path traversal in API path.')
  if (!/^[\w\-./%~:@+,]*$/.test(pathname!)) throw new IpcValidationError('Invalid characters in API path.')
  if (pathname === '/events' || pathname!.startsWith('/auth/')) throw new IpcValidationError('This endpoint is not available through the bridge.')
  let body: unknown
  if (input.body !== undefined) {
    if (method === 'GET') throw new IpcValidationError('GET requests cannot have a body.')
    let serialized: string
    try {
      serialized = JSON.stringify(input.body)
    } catch {
      throw new IpcValidationError('Body is not serializable.')
    }
    if (Buffer.byteLength(serialized) > MAX_BODY_BYTES) throw new IpcValidationError('Body is too large.')
    body = JSON.parse(serialized)
  }
  return { method: method as ApiRequest['method'], path, body }
}

export interface TerminalCreateRequest {
  cols: number
  rows: number
  cwd?: string
  command?: string[]
  title?: string
  projectId?: string
  /** Id of a terminal (e.g. restored history) that the new process replaces. */
  replaces?: string
}

export function validateTerminalCreate(input: unknown): TerminalCreateRequest {
  if (!isRecord(input)) throw new IpcValidationError('Terminal options must be an object.')
  const cols = Number(input.cols)
  const rows = Number(input.rows)
  if (!Number.isInteger(cols) || cols < 2 || cols > 1000 || !Number.isInteger(rows) || rows < 1 || rows > 500) throw new IpcValidationError('Invalid terminal size.')
  const cwd = input.cwd === undefined ? undefined : String(input.cwd)
  if (cwd !== undefined && (cwd.length > 1024 || /[\0\r\n]/.test(cwd))) throw new IpcValidationError('Invalid working directory.')
  let command: string[] | undefined
  if (input.command !== undefined) {
    if (!Array.isArray(input.command) || !input.command.length || input.command.length > 20 || input.command.some((part) => typeof part !== 'string' || part.length > 1024 || /[\0\r\n]/.test(part))) {
      throw new IpcValidationError('Invalid command.')
    }
    command = input.command as string[]
  }
  const title = input.title === undefined ? undefined : validateTerminalTitle(input.title)
  const projectId = input.projectId === undefined ? undefined : String(input.projectId)
  if (projectId !== undefined && !/^[\w-]{1,64}$/.test(projectId)) throw new IpcValidationError('Invalid project id.')
  const replaces = input.replaces === undefined ? undefined : validateTerminalId(input.replaces)
  return { cols, rows, cwd, command, title, projectId, replaces }
}

export function validateTerminalId(input: unknown): string {
  if (typeof input !== 'string' || !/^term-\d{1,6}$/.test(input)) throw new IpcValidationError('Invalid terminal id.')
  return input
}

export function validateTerminalTitle(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 80 || /[\0\r\n]/.test(input)) throw new IpcValidationError('Invalid terminal title.')
  return input.trim()
}

export function validateTerminalData(input: unknown): string {
  if (typeof input !== 'string' || input.length > 64 * 1024) throw new IpcValidationError('Invalid terminal input.')
  return input
}

/** Only https links (docs, downloads) may be opened in the system browser. */
export function validateExternalUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048) throw new IpcValidationError('Invalid URL.')
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new IpcValidationError('Invalid URL.')
  }
  if (url.protocol !== 'https:') throw new IpcValidationError('Only https:// links can be opened.')
  return url.toString()
}

/** Commands the terminal may start directly (official login / install commands reported by the runtime). */
export function isAllowedCommand(command: string[], allowed: string[][]): boolean {
  return allowed.some((candidate) => candidate.length === command.length && candidate.every((part, index) => part === command[index]))
}

export function isAllowedCwd(cwd: string, roots: string[], normalize: (value: string) => string): boolean {
  const target = normalize(cwd)
  return roots.some((root) => {
    const base = normalize(root)
    return target === base || target.startsWith(base.endsWith('/') ? base : `${base}/`)
  })
}
