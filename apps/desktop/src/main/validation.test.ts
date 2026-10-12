import { describe, expect, it } from 'vitest'
import {
  isAllowedCommand,
  isAllowedCwd,
  IpcValidationError,
  validateApiRequest,
  validateExternalUrl,
  validateTerminalCreate,
  validateTerminalData,
  validateTerminalId,
} from './validation.js'

describe('validateApiRequest', () => {
  it('accepts normal API calls and normalizes the method', () => {
    expect(validateApiRequest({ method: 'get', path: '/projects/abc/file?path=src%2Fa.ts' })).toEqual({ method: 'GET', path: '/projects/abc/file?path=src%2Fa.ts', body: undefined })
    expect(validateApiRequest({ method: 'POST', path: '/tasks', body: { projectId: 'x' } }).body).toEqual({ projectId: 'x' })
  })

  it.each([
    [{ method: 'TRACE', path: '/x' }, /method/],
    [{ method: 'GET', path: 'projects' }, /path/],
    [{ method: 'GET', path: '//evil.example.com/x' }, /path/],
    [{ method: 'GET', path: '/projects/../../etc' }, /traversal/],
    [{ method: 'GET', path: '/projects/a\r\nHost: x' }, /characters/],
    [{ method: 'GET', path: '/projects\\x' }, /characters/],
    [{ method: 'GET', path: '/events' }, /not available/],
    [{ method: 'POST', path: '/auth/login', body: {} }, /not available/],
    [{ method: 'GET', path: '/tasks', body: { a: 1 } }, /body/],
    ['not an object', /object/],
  ])('rejects %j', (input, message) => {
    expect(() => validateApiRequest(input)).toThrow(message)
  })

  it('rejects oversized bodies', () => {
    expect(() => validateApiRequest({ method: 'PUT', path: '/projects/a/file', body: { content: 'x'.repeat(9 * 1024 * 1024) } })).toThrow(/too large/)
  })
})

describe('terminal validation', () => {
  it('accepts sizes, ids and commands within limits', () => {
    expect(validateTerminalCreate({ cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24, cwd: undefined, command: undefined })
    expect(validateTerminalCreate({ cols: 80, rows: 24, command: ['claude', 'auth', 'login'] }).command).toEqual(['claude', 'auth', 'login'])
    expect(validateTerminalId('term-12')).toBe('term-12')
    expect(validateTerminalData('ls\r')).toBe('ls\r')
  })

  it('rejects invalid input', () => {
    expect(() => validateTerminalCreate({ cols: 0, rows: 24 })).toThrow(IpcValidationError)
    expect(() => validateTerminalCreate({ cols: 80, rows: 24, command: ['rm', '-rf\n/'] })).toThrow(/command/)
    expect(() => validateTerminalCreate({ cols: 80, rows: 24, command: [] })).toThrow(/command/)
    expect(() => validateTerminalId('../term')).toThrow(/id/)
    expect(() => validateTerminalData('x'.repeat(70_000))).toThrow()
  })

  it('only starts exactly allowlisted commands', () => {
    const allowed = [['C:/bin/claude.exe', 'auth', 'login'], ['winget', 'install', '--id', 'Ollama.Ollama']]
    expect(isAllowedCommand(['C:/bin/claude.exe', 'auth', 'login'], allowed)).toBe(true)
    expect(isAllowedCommand(['C:/bin/claude.exe', 'auth', 'login', '--extra'], allowed)).toBe(false)
    expect(isAllowedCommand(['powershell', '-c', 'evil'], allowed)).toBe(false)
  })

  it('restricts the working directory to opened projects', () => {
    const normalize = (value: string) => value.replaceAll('\\', '/').toLowerCase()
    expect(isAllowedCwd('C:\\work\\repo\\src', ['C:\\work\\repo'], normalize)).toBe(true)
    expect(isAllowedCwd('C:\\work\\repo-other', ['C:\\work\\repo'], normalize)).toBe(false)
    expect(isAllowedCwd('C:\\Windows', ['C:\\work\\repo'], normalize)).toBe(false)
  })
})

describe('validateExternalUrl', () => {
  it('only allows https links', () => {
    expect(validateExternalUrl('https://ollama.com/download')).toBe('https://ollama.com/download')
    expect(() => validateExternalUrl('file:///C:/Windows/system32/calc.exe')).toThrow(/https/)
    expect(() => validateExternalUrl('javascript:alert(1)')).toThrow()
    expect(() => validateExternalUrl('http://example.com')).toThrow(/https/)
  })
})
