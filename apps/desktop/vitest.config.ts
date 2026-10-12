import { defineConfig } from 'vitest/config'

// Unit tests (main-process validation). The live E2E test lives in e2e/ and runs with node --test.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})
