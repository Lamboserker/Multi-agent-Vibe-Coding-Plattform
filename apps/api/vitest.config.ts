import { defineConfig } from 'vitest/config'

// compiled copies of the tests in dist/ must not run a second time
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } })
