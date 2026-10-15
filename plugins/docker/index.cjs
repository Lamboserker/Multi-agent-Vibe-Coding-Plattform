// Docker plugin. Sandboxed: runs only the docker CLI through context.process (no shell); reads the
// project only to find compose files.

const NAME = /^[\w][\w.-]{0,127}$/
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']

async function docker(context, args, options = {}) {
  const result = await context.process.run('docker', args, { timeoutMs: 120000, ...options })
  if (result.exitCode !== 0) {
    const message = (result.stderr || result.stdout).trim()
    if (/cannot connect|daemon|pipe.*docker_engine|is the docker daemon running/i.test(message)) throw new Error('Docker läuft nicht (Docker Desktop starten).')
    throw new Error(message.slice(0, 600) || `docker ${args[0]} fehlgeschlagen (${result.exitCode}).`)
  }
  return result.stdout
}

/** devcontainer.json is JSONC: comments and trailing commas are allowed. */
function parseJsonc(text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (char === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i < 0) throw new Error('devcontainer.json: Kommentar nicht geschlossen.')
      i++
    } else out += char
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/** Lifecycle command of devcontainer.json (string → shell, array → exec, object → several in order). */
function lifecycleCommands(value) {
  if (value === undefined) return []
  if (typeof value === 'string') return [['sh', '-c', value]]
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) return [value]
  if (value && typeof value === 'object') return Object.values(value).flatMap(lifecycleCommands)
  throw new Error('Ungültiger Lifecycle-Befehl in devcontainer.json.')
}

const jsonLines = (text) =>
  text
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line))

function container(args) {
  const name = String(args.container || '')
  if (!NAME.test(name)) throw new Error('Ungültiger Container-Name.')
  return name
}

async function composeFile(context) {
  if (!(await context.project())) return undefined
  const entries = await context.fs.list('')
  return COMPOSE_FILES.find((file) => entries.some((entry) => entry.name === file))
}

async function logs(context, name, lines = 200) {
  const result = await context.process.run('docker', ['logs', '--tail', String(Math.min(Math.max(Number(lines) || 200, 1), 2000)), '--timestamps', name], { timeoutMs: 30000 })
  if (result.exitCode !== 0) throw new Error((result.stderr || '').trim().slice(0, 400) || 'docker logs fehlgeschlagen.')
  // docker writes the container's stderr to stderr
  return `${result.stdout}${result.stderr}`.trim()
}

module.exports = {
  _internal: { parseJsonc, lifecycleCommands },
  activate(context) {
    context.commands.register('devcontainer', async () => {
      const project = await context.project()
      if (!project) throw new Error('Kein Projekt geöffnet.')
      const config = parseJsonc(await context.fs.read('.devcontainer/devcontainer.json'))
      // features need the Dev Container CLI (OCI downloads + build); initializeCommand would run on the host
      if (config.features && Object.keys(config.features).length) throw new Error('Devcontainer-Features benötigen die Dev-Container-CLI und werden hier nicht unterstützt (nicht stillschweigend ignoriert). Features entfernen oder in ein Dockerfile übernehmen.')
      if (config.initializeCommand) throw new Error('initializeCommand würde auf dem Host laufen und wird aus Sicherheitsgründen nicht ausgeführt.')
      const env = config.containerEnv || {}
      for (const [key, value] of Object.entries(env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') throw new Error(`Ungültige containerEnv-Variable ${key}.`)
      const postCreate = lifecycleCommands(config.postCreateCommand)
      const postStart = lifecycleCommands(config.postStartCommand)
      const name = `mac-dev-${project.id}`.replace(/[^\w.-]/g, '-').slice(0, 120)
      // paths in devcontainer.json are relative to .devcontainer; ".." (the project root) is the usual build context
      const inProject = (relative, what) => {
        const parts = `.devcontainer/${relative}`.split('/').filter((part) => part && part !== '.')
        const resolved = []
        for (const part of parts) {
          if (part === '..') { if (!resolved.length) throw new Error(`${what} muss innerhalb des Projekts liegen.`); resolved.pop() } else resolved.push(part)
        }
        if (String(relative).startsWith('/')) throw new Error(`${what} muss innerhalb des Projekts liegen.`)
        return resolved.join('/') || '.'
      }
      if (config.dockerComposeFile) {
        const files = Array.isArray(config.dockerComposeFile) ? config.dockerComposeFile : [config.dockerComposeFile]
        const args = ['compose']
        for (const file of files) {
          if (typeof file !== 'string') throw new Error('Ungültige Compose-Datei.')
          args.push('-f', inProject(file, 'Compose-Datei'))
        }
        if (!NAME.test(String(config.service || ''))) throw new Error('Compose-Service fehlt.')
        await docker(context, [...args, 'up', '-d', config.service], { cwd: 'project', timeoutMs: 600000 })
        if (postCreate.length || postStart.length) {
          const id = (await docker(context, [...args, 'ps', '-q', config.service], { cwd: 'project' })).trim()
          for (const command of [...postCreate, ...postStart]) await docker(context, ['exec', id, ...command], { timeoutMs: 600000 })
        }
        return { message: `Devcontainer-Service ${config.service} gestartet.` }
      }
      let image = config.image
      if (config.build) {
        const buildContext = inProject(String(config.build.context || '.'), 'Build-Kontext')
        const file = inProject(String(config.build.dockerfile || 'Dockerfile'), 'Dockerfile')
        image = `${name}:dev`
        await docker(context, ['build', '-t', image, '-f', file, buildContext], { cwd: 'project', timeoutMs: 600000 })
      }
      if (typeof image !== 'string' || !/^[\w][\w./:@-]+$/.test(image)) throw new Error('Devcontainer benötigt image, build oder dockerComposeFile.')
      const target = typeof config.workspaceFolder === 'string' && /^\/[\w./-]+$/.test(config.workspaceFolder) && !config.workspaceFolder.includes('..') ? config.workspaceFolder : `/workspaces/${project.name.replace(/[^\w.-]/g, '-')}`
      const existing = await context.process.run('docker', ['inspect', name], { timeoutMs: 15000 })
      const created = existing.exitCode !== 0
      if (!created) await docker(context, ['start', name])
      else {
        const args = ['run', '-d', '--name', name, '--label', 'multi-ai-coder.devcontainer=1', '--mount', `type=bind,source=${project.repoPath},target=${target}`, '--workdir', target]
        for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`)
        for (const port of config.forwardPorts || []) {
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Ungültiger forwardPort.')
          args.push('-p', `127.0.0.1:${port}:${port}`)
        }
        await docker(context, [...args, image, 'sleep', 'infinity'], { timeoutMs: 600000 })
      }
      // lifecycle inside the container: postCreateCommand once after creation, postStartCommand on every start
      const outputs = []
      for (const command of [...(created ? postCreate : []), ...postStart]) outputs.push(`$ ${command.join(' ')}\n${(await docker(context, ['exec', '--workdir', target, name, ...command], { timeoutMs: 600000 })).trim()}`)
      const state = (await docker(context, ['inspect', '--format', '{{.State.Status}}', name])).trim()
      return { message: `Devcontainer ${name} gestartet (${state}).`, view: { type: 'code', content: [`Status: ${state}`, `Arbeitsordner: ${target}`, ...outputs].join('\n\n') } }
    })
    context.views.register('main', async () => {
      let version
      try {
        version = (await docker(context, ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15000 })).trim()
      } catch (error) {
        return { type: 'stack', children: [{ type: 'heading', text: 'Docker' }, { type: 'text', tone: 'warning', text: error.message }] }
      }
      const [containers, images, compose] = await Promise.all([docker(context, ['ps', '-a', '--format', '{{json .}}']).then(jsonLines), docker(context, ['images', '--format', '{{json .}}']).then(jsonLines), composeFile(context).catch(() => undefined)])
      return {
        type: 'stack',
        children: [
          { type: 'heading', text: `Docker ${version}` },
          { type: 'actions', items: [{ label: 'Entwicklungscontainer starten', command: 'devcontainer', confirm: 'Devcontainer aus .devcontainer/devcontainer.json bauen/starten und das Projekt einbinden?' }] },
          compose
            ? { type: 'stack', children: [{ type: 'text', text: `Projekt: ${compose}` }, { type: 'actions', items: [{ label: 'compose up -d', command: 'composeUp', confirm: 'docker compose up -d im Projekt ausführen?' }, { label: 'compose down', command: 'composeDown', confirm: 'docker compose down im Projekt ausführen?' }] }] }
            : { type: 'text', tone: 'muted', text: 'Keine compose-Datei im Projekt.' },
          { type: 'heading', text: `Container (${containers.length})` },
          containers.length
            ? {
                type: 'table',
                columns: ['Name', 'Image', 'Status', 'Ports'],
                rows: containers.map((entry) => {
                  const running = entry.State === 'running'
                  return {
                    cells: [entry.Names, entry.Image, entry.Status, entry.Ports || ''],
                    actions: [
                      running ? { label: 'Stopp', command: 'stop', args: { container: entry.Names } } : { label: 'Start', command: 'start', args: { container: entry.Names } },
                      { label: 'Neustart', command: 'restart', args: { container: entry.Names } },
                      { label: 'Logs', command: 'logs', args: { container: entry.Names } },
                      { label: 'Logs → Chat', command: 'logsToChat', args: { container: entry.Names }, resultTarget: 'chat' },
                      { label: 'Entfernen', command: 'remove', args: { container: entry.Names }, confirm: `Container ${entry.Names} entfernen?` },
                    ],
                  }
                }),
              }
            : { type: 'text', tone: 'muted', text: 'Keine Container.' },
          { type: 'heading', text: `Images (${images.length})` },
          { type: 'table', columns: ['Repository', 'Tag', 'Größe', 'Erstellt'], rows: images.slice(0, 50).map((image) => ({ cells: [image.Repository, image.Tag, image.Size, image.CreatedSince] })) },
        ],
      }
    })

    for (const action of ['start', 'stop', 'restart']) {
      context.commands.register(action, async (args) => {
        const name = container(args)
        await docker(context, [action, name])
        return { message: `${name}: ${action} ausgeführt.` }
      })
    }
    context.commands.register('remove', async (args) => {
      const name = container(args)
      await docker(context, ['rm', '-f', name])
      return { message: `${name} entfernt.` }
    })
    context.commands.register('logs', async (args) => {
      const name = container(args)
      return { title: `Logs ${name}`, view: { type: 'stack', children: [{ type: 'heading', text: `Logs: ${name}` }, { type: 'code', content: (await logs(context, name, args.lines)) || '(leer)' }] } }
    })
    context.commands.register('logsToChat', async (args) => {
      const name = container(args)
      return { text: `Logs des Containers ${name} (letzte 200 Zeilen):\n${await logs(context, name)}`, message: 'Logs in den Chat übernommen.' }
    })
    context.commands.register('composeUp', async () => {
      const file = await composeFile(context)
      if (!file) throw new Error('Keine compose-Datei im Projekt.')
      const output = await docker(context, ['compose', '-f', file, 'up', '-d'], { cwd: 'project', timeoutMs: 600000 })
      return { message: 'docker compose up -d ausgeführt.', view: { type: 'code', content: output || 'ok' } }
    })
    context.commands.register('composeDown', async () => {
      const file = await composeFile(context)
      if (!file) throw new Error('Keine compose-Datei im Projekt.')
      await docker(context, ['compose', '-f', file, 'down'], { cwd: 'project', timeoutMs: 300000 })
      return { message: 'docker compose down ausgeführt.' }
    })

    context.tools.register('docker_containers', async () => (await docker(context, ['ps', '-a', '--format', '{{json .}}']).then(jsonLines)).map((entry) => ({ name: entry.Names, image: entry.Image, state: entry.State, status: entry.Status, ports: entry.Ports })))
    context.tools.register('docker_logs', async (args) => logs(context, container(args), args.lines ?? 200))
  },
}
