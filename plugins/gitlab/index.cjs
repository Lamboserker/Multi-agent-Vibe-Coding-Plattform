// GitLab plugin (gitlab.com). Sandboxed: only gitlab.com through context.http, only git as process.

const API = 'https://gitlab.com/api/v4'

function parseRemote(url) {
  const match = /gitlab\.com[:/](.+?)(?:\.git)?\/?$/i.exec(url.trim())
  return match ? match[1] : undefined
}

async function projectPath(context) {
  const configured = String((await context.settings.get('project')) || '').trim()
  if (configured) return configured
  if (!(await context.project())) throw new Error('Kein Projekt geöffnet.')
  const result = await context.process.run('git', ['remote', 'get-url', 'origin'], { cwd: 'project', timeoutMs: 10000 })
  const path = result.exitCode === 0 ? parseRemote(result.stdout) : undefined
  if (!path) throw new Error('Das Projekt hat keinen gitlab.com-Remote "origin". Projektpfad in den Plugin-Einstellungen eintragen.')
  return path
}

async function gitlab(context, path, raw = false) {
  const token = await context.secrets.get('token')
  const api = String(await context.settings.get('apiUrl') || API).replace(/\/$/, '')
  const response = await context.http.fetch(`${api}${path}`, { headers: token ? { 'PRIVATE-TOKEN': token } : {} })
  if (response.status >= 300 && response.status < 400) throw new Error(`GitLab API leitet weiter (${response.status}). API-URL und Zugriff prüfen; keine Zugangsdaten an Weiterleitungsziele gesendet.`)
  if (response.status === 401) throw new Error('GitLab: Token ungültig oder fehlt.')
  if (response.status === 404) throw new Error(`GitLab: nicht gefunden (${path}). Privates Projekt? Dann wird ein Token benötigt.`)
  if (response.status >= 400) throw new Error(`GitLab ${response.status}: ${response.body.slice(0, 300)}`)
  if (!raw && /^\s*</.test(response.body)) throw new Error('GitLab liefert HTML statt API-JSON. API-URL, Proxy oder Weiterleitung prüfen.')
  return raw ? response.body : JSON.parse(response.body)
}

const short = (text, length = 80) => (text && text.length > length ? `${text.slice(0, length - 1)}…` : text || '')
const date = (value) => (value ? new Date(value).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '')
const tone = (status) => (status === 'success' ? 'ok' : status === 'failed' ? 'error' : status === 'running' || status === 'pending' ? 'accent' : 'warn')

async function mergeRequestText(context, project, iid) {
  const encoded = encodeURIComponent(project)
  const [mr, changes] = await Promise.all([gitlab(context, `/projects/${encoded}/merge_requests/${iid}`), gitlab(context, `/projects/${encoded}/merge_requests/${iid}/diffs?per_page=100`)])
  const lines = [`Merge Request !${mr.iid}: ${mr.title}`, `Status: ${mr.state}, ${mr.source_branch} → ${mr.target_branch}, von ${mr.author.username}`, '', mr.description || '(keine Beschreibung)', '', `Geänderte Dateien (${changes.length}):`]
  for (const change of changes) lines.push(`- ${change.new_path}${change.new_file ? ' (neu)' : change.deleted_file ? ' (gelöscht)' : ''}`)
  return { mr, text: lines.join('\n') }
}

async function failedJobs(context, project) {
  const encoded = encodeURIComponent(project)
  const [pipeline] = await gitlab(context, `/projects/${encoded}/pipelines?per_page=1`)
  if (!pipeline) return { pipeline: undefined, jobs: [] }
  const jobs = (await gitlab(context, `/projects/${encoded}/pipelines/${pipeline.id}/jobs?per_page=100`)).filter((job) => job.status === 'failed')
  const withLogs = await Promise.all(
    jobs.slice(0, 5).map(async (job) => ({ name: job.name, stage: job.stage, log: (await gitlab(context, `/projects/${encoded}/jobs/${job.id}/trace`, true).catch(() => '')).slice(-4000) })),
  )
  return { pipeline, jobs: withLogs }
}

module.exports = {
  activate(context) {
    context.commands.register('projects', async (args) => {
      const query = new URLSearchParams({ per_page: '100', page: String(Math.max(1, Number(args.page) || 1)), simple: 'true' })
      if (args.search) query.set('search', String(args.search))
      if (await context.secrets.get('token')) query.set('membership', 'true')
      const projects = await gitlab(context, `/projects?${query}`)
      return { view: { type: 'table', columns: ['ID', 'Projekt', 'Branch'], rows: projects.map((project) => ({ cells: [String(project.id), project.path_with_namespace, project.default_branch || ''] })) } }
    })
    context.views.register('main', async () => {
      let project
      try {
        project = await projectPath(context)
      } catch (error) {
        return { type: 'stack', children: [{ type: 'heading', text: 'GitLab' }, { type: 'text', tone: 'warning', text: error.message }] }
      }
      const encoded = encodeURIComponent(project)
      const [mrs, issues, pipelines] = await Promise.all([
        gitlab(context, `/projects/${encoded}/merge_requests?state=opened&per_page=30`),
        gitlab(context, `/projects/${encoded}/issues?state=opened&per_page=30`),
        gitlab(context, `/projects/${encoded}/pipelines?per_page=10`),
      ])
      return {
        type: 'stack',
        children: [
          { type: 'heading', text: `GitLab · ${project}` },
          { type: 'form', fields: [{ name: 'search', label: 'Projekte suchen', type: 'text' }, { name: 'page', label: 'Seite', type: 'number', value: 1 }], submit: { label: 'Projekte laden', command: 'projects' } },
          { type: 'heading', text: 'Pipelines' },
          pipelines.length
            ? {
                type: 'table',
                columns: ['ID', 'Status', 'Ref', 'Erstellt'],
                rows: pipelines.map((pipeline) => ({ cells: [String(pipeline.id), pipeline.status, pipeline.ref, date(pipeline.created_at)], actions: [{ label: 'Jobs', command: 'pipelineJobs', args: { id: pipeline.id } }] })),
              }
            : { type: 'text', tone: 'muted', text: 'Keine Pipelines.' },
          { type: 'heading', text: 'Merge Requests' },
          mrs.length
            ? {
                type: 'table',
                columns: ['!', 'Titel', 'Autor', 'Branch', 'Aktualisiert'],
                rows: mrs.map((mr) => ({
                  cells: [String(mr.iid), short(mr.title), mr.author.username, mr.source_branch, date(mr.updated_at)],
                  actions: [
                    { label: 'Details', command: 'mergeRequest', args: { iid: mr.iid } },
                    { label: 'In Chat', command: 'toChat', args: { iid: mr.iid }, resultTarget: 'chat' },
                  ],
                })),
              }
            : { type: 'text', tone: 'muted', text: 'Keine offenen Merge Requests.' },
          { type: 'heading', text: 'Issues' },
          issues.length
            ? { type: 'table', columns: ['#', 'Titel', 'Labels', 'Aktualisiert'], rows: issues.map((issue) => ({ cells: [String(issue.iid), short(issue.title), issue.labels.join(', '), date(issue.updated_at)] })) }
            : { type: 'text', tone: 'muted', text: 'Keine offenen Issues.' },
        ],
      }
    })

    context.commands.register('mergeRequest', async (args) => {
      const { mr, text } = await mergeRequestText(context, await projectPath(context), Number(args.iid))
      return { title: `!${mr.iid}`, view: { type: 'stack', children: [{ type: 'heading', text: `!${mr.iid} ${mr.title}` }, { type: 'markdown', text }, { type: 'actions', items: [{ label: 'In Chat übernehmen', command: 'toChat', args: { iid: mr.iid }, resultTarget: 'chat' }] }] } }
    })

    context.commands.register('pipelineJobs', async (args) => {
      const project = await projectPath(context)
      const jobs = await gitlab(context, `/projects/${encodeURIComponent(project)}/pipelines/${Number(args.id)}/jobs?per_page=100`)
      return {
        title: `Pipeline ${args.id}`,
        view: {
          type: 'stack',
          children: [
            { type: 'heading', text: `Pipeline ${args.id}` },
            ...jobs.map((job) => ({ type: 'badge', text: `${job.stage} / ${job.name}: ${job.status}`, tone: tone(job.status) })),
          ],
        },
      }
    })

    context.commands.register('toChat', async (args) => ({ text: (await mergeRequestText(context, await projectPath(context), Number(args.iid))).text, message: 'Als Kontext in den Chat übernommen.' }))

    context.tools.register('gitlab_merge_request', async (args) => (await mergeRequestText(context, await projectPath(context), Number(args.iid))).text)
    context.tools.register('gitlab_failed_jobs', async () => {
      const { pipeline, jobs } = await failedJobs(context, await projectPath(context))
      if (!pipeline) return 'No pipelines.'
      if (!jobs.length) return `Latest pipeline ${pipeline.id} (${pipeline.status}) has no failed jobs.`
      return jobs.map((job) => `Job ${job.stage}/${job.name} failed. Log tail:\n${job.log}`).join('\n\n')
    })
  },
}
