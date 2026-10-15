import path from 'node:path'

// Exercise current sources, not stale workspace package outputs. No global build is needed.
export default {
  resolve: { alias: { '@multi-ai-coder/engine': path.resolve('packages/engine/src/index.ts'), '@multi-ai-coder/plugin-sdk': path.resolve('packages/plugin-sdk/src/index.ts') } },
  test: { include: ['packages/engine/src/**/*.test.ts', 'apps/api/src/**/*.test.ts'], fileParallelism: false, maxWorkers: 1, testTimeout: 12000, hookTimeout: 30000 },
}
