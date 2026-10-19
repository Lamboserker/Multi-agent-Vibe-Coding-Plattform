import { describe, expect, it } from 'vitest'
import { sanitizedEnv } from './process.js'

describe('sanitizedEnv', () => {
  it('drops the package-manager context of the app itself, keeps the rest', () => {
    const separator = process.platform === 'win32' ? ';' : ':'
    const env = sanitizedEnv({}, {
      PATH: ['/app/apps/desktop/node_modules/.bin', '/app/node_modules/.bin', '/usr/bin', '/pnpm/dist/node-gyp-bin'].join(separator),
      npm_config_user_agent: 'pnpm/10',
      npm_lifecycle_event: 'dev',
      PNPM_PACKAGE_NAME: '@multi-ai-coder/desktop',
      INIT_CWD: '/app',
      HOME: '/home/user',
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(Object.keys(env).filter((key) => /npm|pnpm|INIT_CWD/i.test(key))).toEqual([])
    expect(env.HOME).toBe('/home/user')
  })
})
