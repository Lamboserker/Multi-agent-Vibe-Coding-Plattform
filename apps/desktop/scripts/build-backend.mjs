// Bundles the local runtime (NestJS API + engine) into a single CommonJS file for the
// Electron utility process. The input is the tsc output of apps/api, which already contains
// the decorator metadata NestJS needs (esbuild alone cannot emit it).
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.resolve(root, '../api/dist/main.js')
if (!existsSync(entry)) {
  console.error(`Missing ${entry}. Run "pnpm --filter @multi-ai-coder/api build" first.`)
  process.exit(1)
}

await build({
  entryPoints: [entry],
  outfile: path.join(root, 'dist/backend/main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  logLevel: 'warning',
  // import.meta.url is only used as a dev fallback for locating migrations.
  define: { 'import.meta.url': '__mac_import_meta_url' },
  banner: { js: "const __mac_import_meta_url = require('url').pathToFileURL(__filename).href;" },
  external: [
    '@prisma/client',
    '.prisma/client',
    // optional NestJS integrations that are not used
    '@nestjs/microservices',
    '@nestjs/microservices/*',
    '@nestjs/websockets',
    '@nestjs/websockets/*',
    'class-validator',
    'class-transformer',
    'class-transformer/storage',
    '@fastify/static',
    '@nestjs/platform-socket.io',
  ],
})
console.log('backend bundle → dist/backend/main.cjs')
