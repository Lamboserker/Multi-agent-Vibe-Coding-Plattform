// Engine-level benchmark (Phase 0.3, 2.1): repository index, git worktrees, patch validation,
// orchestrator CLI process startup (no model call), Ollama cold/warm inference.
//
//   pnpm --filter @multi-ai-coder/engine build
//   node packages/engine/bench/engine-benchmark.mjs [--files 5000] [--ollama http://127.0.0.1:11435] [--model qwen2.5-coder:7b] [--label x]
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const engine = await import(new URL('../dist/index.js', import.meta.url).href)
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []))
const fileCount = Number(args.files ?? 5000)
const label = args.label ?? 'engine'
const results = { label, startedAt: new Date().toISOString(), environment: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryGb: Math.round(os.totalmem() / 1024 ** 3), node: process.version }, metrics: {} }

const time = async (fn) => {
  const started = performance.now()
  const value = await fn()
  return { ms: Math.round((performance.now() - started) * 10) / 10, value }
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const log = (name, value) => {
  results.metrics[name] = value
  console.log(`[engine:${label}] ${name}`, JSON.stringify(value))
}

/** Synthetic TypeScript monorepo with imports between files, committed to git. */
function syntheticRepo(count) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'mac-bench-repo-'))
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'bench', type: 'module', scripts: { test: 'node --test' } }))
  for (let index = 0; index < count; index += 1) {
    const dir = path.join(repo, 'src', `module${index % 50}`)
    mkdirSync(dir, { recursive: true })
    const previous = index % 50 === 0 ? '' : `import { value${index - 1} } from './file${index - 1}'\n`
    writeFileSync(path.join(dir, `file${index}.ts`), `${previous}export interface Shape${index} { id: number; name: string }\nexport const value${index} = ${index}\nexport function compute${index}(input: number): number {\n  return input * ${index}\n}\nexport class Service${index} {\n  run(): number { return compute${index}(${index}) }\n}\n`)
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=b', '-c', 'user.email=b@b', 'commit', '-q', '-m', 'init'], { cwd: repo })
  return repo
}

// --- repository index ------------------------------------------------------------
const repo = syntheticRepo(fileCount)
const cold = await time(() => engine.buildRepoIndex(repo))
const warm = await time(() => engine.buildRepoIndex(repo, cold.value))
writeFileSync(path.join(repo, 'src', 'module1', 'file1.ts'), 'export const changed = 1\n')
const oneChanged = await time(() => engine.buildRepoIndex(repo, warm.value))
const digest = await time(() => engine.buildContextDigest(oneChanged.value, 'Add a compute helper to Service42 in module42', { budgetTokens: 6000 }))
const cacheFile = path.join(repo, '..', `index-${path.basename(repo)}.json`)
const save = await time(() => engine.saveIndexCache(cacheFile, oneChanged.value))
const load = await time(() => engine.loadIndexCache(cacheFile))
log('repo_index', { files: fileCount, coldMs: cold.ms, warmNoChangeMs: warm.ms, oneFileChangedMs: oneChanged.ms, digestMs: digest.ms, cacheSaveMs: save.ms, cacheLoadMs: load.ms, reused: oneChanged.value.stats.reusedFromCache, reindexed: oneChanged.value.stats.indexedFiles })

// --- git worktree + patch validation --------------------------------------------------
const manager = new engine.WorktreeManager({ root: mkdtempSync(path.join(os.tmpdir(), 'mac-bench-wt-')) })
const base = await engine.headCommit(repo)
const create = []
const remove = []
const validate = []
for (let index = 0; index < 5; index += 1) {
  const created = await time(() => manager.create(repo, { projectKey: 'bench', name: `t${index}`, branch: `mac/bench/t${index}`, baseCommit: base }))
  create.push(created.ms)
  writeFileSync(path.join(created.value.path, 'src', 'module2', 'file2.ts'), 'export const value2 = 3\n')
  const commit = await engine.commitIfChanged(created.value.path, `t${index}: change`)
  validate.push((await time(() => engine.validatePatch(created.value.path, base, commit, { allowedPatterns: ['src/**'], deniedPatterns: engine.DEFAULT_DENIED_PATTERNS, strictScope: false, maxFiles: 40, maxFileBytes: 512 * 1024 }))).ms)
  remove.push((await time(() => manager.remove(repo, created.value.path, created.value.branch))).ms)
}
log('git', { worktreeCreateMs: median(create), worktreeRemoveMs: median(remove), patchValidateMs: median(validate), samples: create.length })

// pooled worktrees (reused between tasks; only differing files are rewritten)
if (typeof engine.WorktreeManager === 'function') {
  const pooled = new engine.WorktreeManager({ root: mkdtempSync(path.join(os.tmpdir(), 'mac-bench-pool-')), poolSize: 2 })
  const first = await time(() => pooled.create(repo, { projectKey: 'bench', name: 'p0', branch: 'mac/pool/p0', baseCommit: base }))
  let handle = first.value
  const acquire = []
  const release = []
  for (let index = 1; index <= 5; index += 1) {
    writeFileSync(path.join(handle.path, 'src', 'module3', 'file3.ts'), `export const value3 = ${index}\n`)
    await engine.commitIfChanged(handle.path, `p${index}: change`)
    release.push((await time(() => pooled.remove(repo, handle.path, handle.branch))).ms)
    const next = await time(() => pooled.create(repo, { projectKey: 'bench', name: `p${index}`, branch: `mac/pool/p${index}`, baseCommit: base }))
    acquire.push(next.ms)
    handle = next.value
  }
  await pooled.remove(repo, handle.path, handle.branch)
  log('git_pooled', { firstCreateMs: first.ms, reuseCreateMs: median(acquire), releaseMs: median(release), samples: acquire.length })
}

// --- orchestrator CLIs: process startup and status (no model call) ----------------------
for (const [name, adapter] of [['codex', new engine.CodexAdapter({})], ['claude-code', new engine.ClaudeCodeAdapter({})]]) {
  const detections = []
  const statuses = []
  for (let index = 0; index < 3; index += 1) {
    detections.push((await time(() => adapter.detect())).ms)
    statuses.push((await time(() => adapter.getStatus().catch(() => undefined))).ms)
  }
  const detection = await adapter.detect()
  let versionSpawnMs
  if (detection.binary) {
    const started = performance.now()
    spawnSync(detection.binary, ['--version'], { shell: /\.(cmd|bat)$/i.test(detection.binary), stdio: 'ignore', timeout: 30_000 })
    versionSpawnMs = Math.round(performance.now() - started)
  }
  log(`cli_${name}`, { installed: detection.installed, detectMs: median(detections), statusMs: median(statuses), versionSpawnMs })
}

// --- Ollama: cold load, time to first token, tokens/s ----------------------------------
const ollamaUrl = args.ollama ?? 'http://127.0.0.1:11434'
const model = args.model
if (model) {
  const client = new engine.OllamaClient(ollamaUrl)
  if (await client.isReachable()) {
    await client.unload(model).catch(() => undefined)
    const runOnce = async () => {
      const started = performance.now()
      let firstToken
      const response = await fetch(`${ollamaUrl}/api/generate`, { method: 'POST', body: JSON.stringify({ model, prompt: 'Write a TypeScript function that adds two numbers. Code only.', stream: true, options: { num_predict: 96, temperature: 0 } }) })
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let final
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (const line of buffer.split('\n').slice(0, -1)) {
          const event = JSON.parse(line)
          if (event.response && firstToken === undefined) firstToken = performance.now() - started
          if (event.done) final = event
        }
        buffer = buffer.split('\n').at(-1)
      }
      return { totalMs: Math.round(performance.now() - started), ttftMs: Math.round(firstToken ?? 0), loadMs: Math.round((final?.load_duration ?? 0) / 1e6), tokensPerSecond: final?.eval_count ? Math.round((final.eval_count / (final.eval_duration / 1e9)) * 10) / 10 : undefined }
    }
    const coldRun = await runOnce()
    const warmRun = await runOnce()
    const running = await client.running().catch(() => [])
    const loaded = running.find((entry) => entry.name === model)
    log('ollama', { url: ollamaUrl, model, cold: coldRun, warm: warmRun, vramMb: loaded ? Math.round(loaded.size_vram / 1024 / 1024) : undefined })
  } else {
    log('ollama', { url: ollamaUrl, model, error: 'not reachable' })
  }
}

results.finishedAt = new Date().toISOString()
const out = path.resolve(here, '..', '..', '..', 'apps', 'desktop', 'e2e', 'results', `engine-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
mkdirSync(path.dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(results, null, 2))
console.log(`[engine:${label}] written ${out}`)
