// Assembles the minimal app directory that electron-builder packages (apps/desktop/release-app):
// bundled main/preload/renderer/backend, SQL migrations, and the few native/external modules
// (Prisma client + query engine, node-pty prebuilds). No dev dependencies end up in the installer.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(root, '..', '..')
const out = path.join(root, 'release-app')
const require = createRequire(path.join(root, 'package.json'))
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

for (const required of ['dist/main/main.cjs', 'dist/preload/preload.cjs', 'dist/renderer/index.html', 'dist/backend/main.cjs']) {
  if (!existsSync(path.join(root, required))) {
    console.error(`Missing ${required} – run "pnpm --filter @multi-ai-coder/desktop build" first.`)
    process.exit(1)
  }
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const noMaps = (source) => !source.endsWith('.map')
cpSync(path.join(root, 'dist/main'), path.join(out, 'dist/main'), { recursive: true, filter: noMaps })
cpSync(path.join(root, 'dist/preload'), path.join(out, 'dist/preload'), { recursive: true, filter: noMaps })
cpSync(path.join(root, 'dist/renderer'), path.join(out, 'dist/renderer'), { recursive: true })
mkdirSync(path.join(out, 'backend'), { recursive: true })
cpSync(path.join(root, 'dist/backend/main.cjs'), path.join(out, 'backend/main.cjs'))
cpSync(path.join(root, 'dist/backend/plugin-host.cjs'), path.join(out, 'backend/plugin-host.cjs'))
for (const file of ['ts-worker.cjs', 'boot.cjs', 'ts-worker-boot.cjs']) cpSync(path.join(root, 'dist/backend', file), path.join(out, 'backend', file))
cpSync(path.join(root, 'dist/backend/lsp-server.mjs'), path.join(out, 'backend/lsp-server.mjs'))
cpSync(path.join(root, 'dist/backend/typescript'), path.join(out, 'backend/typescript'), { recursive: true })
// plugins and skills shipped with the app (trusted)
for (const folder of ['plugins', 'skills']) {
  if (existsSync(path.join(repo, folder))) cpSync(path.join(repo, folder), path.join(out, folder), { recursive: true, filter: (file) => !/[\\/]node_modules[\\/]/.test(file) })
}
cpSync(path.join(repo, 'prisma/migrations'), path.join(out, 'backend/migrations'), { recursive: true })

// build assignment: which source state this package was built from (commit + uncommitted changes)
{
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    } catch {
      return ''
    }
  }
  const status = git(['status', '--porcelain=v1', '--untracked-files=all'])
  const tracked = git(['diff', 'HEAD', '--binary'])
  const untracked = status.split('\n').filter((line) => line.startsWith('?? ')).map((line) => line.slice(3).replace(/^"|"$/g, '')).sort()
  const hash = createHash('sha256').update(tracked)
  for (const file of untracked) {
    hash.update(`\0${file}\0`)
    try { hash.update(readFileSync(path.join(repo, file))) } catch { /* directories/unreadable */ }
  }
  // A content manifest distinguishes source changes from later documentation-only edits.
  // Ignored runtime data/secrets/build outputs never enter this git-listed source inventory.
  const sourceFiles = Object.fromEntries(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0')
    .filter((file) => /^(apps\/|packages\/|plugins\/|skills\/|prisma\/|pnpm-|package\.json$|tsconfig|scripts\/)/.test(file) && !file.includes('/results/') && !/(^|\/)\.env($|\.)/.test(file))
    .sort().flatMap((file) => { try { return [[file, createHash('sha256').update(readFileSync(path.join(repo, file))).digest('hex')]] } catch { return [] } }))
  writeFileSync(path.join(out, 'build-info.json'), JSON.stringify({
    version: pkg.version,
    commit: git(['rev-parse', 'HEAD']).trim() || null,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']).trim() || null,
    uncommittedChanges: status.trim().split('\n').filter(Boolean).length,
    workingTreeSha256: hash.digest('hex'),
    sourceFiles,
    sourceSha256: createHash('sha256').update(JSON.stringify(sourceFiles)).digest('hex'),
    builtAt: new Date().toISOString(),
  }, null, 2))
}
if (existsSync(path.join(root, 'build/icon.png'))) cpSync(path.join(root, 'build/icon.png'), path.join(out, 'build/icon.png'))

// --- external runtime modules ---------------------------------------------------------------
const modules = path.join(out, 'node_modules')
const copyPackage = (name, from) => {
  const source = realpathSync(from)
  const target = path.join(modules, ...name.split('/'))
  cpSync(source, target, { recursive: true, dereference: true, filter: (file) => !/[\\/]node_modules[\\/]/.test(path.relative(source, file)) })
  return target
}

// Prisma: the client package and the generated client next to it (with the query engine for this platform).
const prismaClientDir = path.dirname(require.resolve('@prisma/client/package.json'))
copyPackage('@prisma/client', prismaClientDir)
const generated = path.join(path.dirname(realpathSync(prismaClientDir)), '..', '.prisma', 'client')
const generatedDir = existsSync(generated) ? generated : path.join(realpathSync(prismaClientDir), '..', '..', '.prisma', 'client')
if (!existsSync(path.join(generatedDir, 'index.js'))) {
  console.error(`Generated Prisma client not found (${generatedDir}). Run "pnpm prisma:generate".`)
  process.exit(1)
}
cpSync(generatedDir, path.join(modules, '.prisma', 'client'), { recursive: true, dereference: true })
const engines = readdirSync(path.join(modules, '.prisma', 'client')).filter((file) => file.includes('query_engine') || file.includes('libquery_engine'))
console.log(`prisma engines: ${engines.join(', ') || 'none (!)'}`)

// node-pty (prebuilt N-API binaries via @lydell/node-pty + the platform package)
const ptyDir = path.dirname(require.resolve('@lydell/node-pty/package.json'))
copyPackage('@lydell/node-pty', ptyDir)
const ptyPkg = JSON.parse(readFileSync(path.join(ptyDir, 'package.json'), 'utf8'))
const platformPkg = `@lydell/node-pty-${process.platform}-${process.arch}`
if (ptyPkg.optionalDependencies?.[platformPkg]) {
  const ptyRequire = createRequire(path.join(realpathSync(ptyDir), 'package.json'))
  copyPackage(platformPkg, path.dirname(ptyRequire.resolve(`${platformPkg}/package.json`)))
} else {
  console.warn(`No prebuilt node-pty package for ${process.platform}-${process.arch}; the integrated terminal will be unavailable.`)
}

writeFileSync(
  path.join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: 'multi-ai-coder',
      productName: pkg.productName,
      version: pkg.version,
      description: pkg.description,
      author: pkg.author,
      main: 'dist/main/main.cjs',
      private: true,
    },
    null,
    2,
  )}\n`,
)
console.log(`staged app → ${path.relative(root, out)}`)
