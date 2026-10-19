import { describe, expect, it } from 'vitest'
import { withoutPackageManagerContext } from './clean-env'

describe('project terminal environment', () => {
  it('has no npm/pnpm context and no app node_modules/.bin on PATH', () => {
    const env = withoutPackageManagerContext({
      Path: 'D:\\app\\apps\\desktop\\node_modules\\.bin;D:\\app\\node_modules\\.bin;C:\\Windows\\System32;C:\\nodejs',
      npm_config_user_agent: 'pnpm/10',
      pnpm_config_verify_deps_before_run: 'false',
      PNPM_SCRIPT_SRC_DIR: 'D:\\app\\apps\\desktop',
      INIT_CWD: 'D:\\app',
      USERPROFILE: 'C:\\Users\\me',
      empty: undefined,
    })
    expect(env.Path).toBe('C:\\Windows\\System32;C:\\nodejs')
    expect(Object.keys(env).sort()).toEqual(['Path', 'USERPROFILE'])
  })
})
