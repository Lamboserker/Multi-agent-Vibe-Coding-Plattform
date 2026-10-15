// GitHub plugin (reference implementation of the plugin API). Runs sandboxed: every request goes
// through context.http (only api.github.com is granted) and context.process (only git).

const API = 'https://api.github.com'

function parseRemote(url) {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())
  return match ? `${match[1]}/${match[2]}` : undefined
}

async function repository(context) {
  const configured = (await context.settings.get('repository')) || ''
  if (/^[\w.-]+\/[\w.-]+$/.test(configured.trim())) return configured.trim()
  const project = await context.project()
  if (!project) throw new Error('Kein Projekt geöffnet.')
  const result = await context.process.run('git', ['remote', 'get-url', 'origin'], { cwd: 'project', timeoutMs: 10000 })
  const repo = result.exitCode === 0 ? parseRemote(result.stdout) : undefined
  if (!repo) throw new Error('Das Projekt hat keinen GitHub-Remote "origin". Repository in den Plugin-Einstellungen eintragen.')
  return repo
}

async function github(context, path, init = {}) {
  const token = await context.secrets.get('token')
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'multi-ai-coder', ...(init.headers || {}) }
  if (token) headers.Authorization = `Bearer ${token}`
  const api = String(await context.settings.get('apiUrl') || API).replace(/\/$/, '')
  const response = await context.http.fetch(`${api}${path}`, { ...init, headers })
  if (response.status >= 300 && response.status < 400) throw new Error(`GitHub API leitet weiter (${response.status}); API-URL prüfen.`)
  if (response.status === 401) throw new Error('GitHub: Token ungültig oder abgelaufen.')
  if (response.status === 403 && /rate limit/i.test(response.body)) throw new Error('GitHub: Rate-Limit erreicht. Ein Access Token in den Plugin-Einstellungen erhöht das Limit.')
  if (response.status === 404) throw new Error(`GitHub: nicht gefunden (${path}). Privates Repository? Dann wird ein Token benötigt.`)
  if (response.status >= 400) throw new Error(`GitHub ${response.status}: ${response.body.slice(0, 300)}`)
  return response.body ? JSON.parse(response.body) : undefined
}

const short = (text, length = 80) => (text && text.length > length ? `${text.slice(0, length - 1)}…` : text || '')
const date = (value) => (value ? new Date(value).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '')

async function pullRequestText(context, repo, number) {
  const [pr, files, comments] = await Promise.all([
    github(context, `/repos/${repo}/pulls/${number}`),
    github(context, `/repos/${repo}/pulls/${number}/files?per_page=100`),
    github(context, `/repos/${repo}/pulls/${number}/comments?per_page=50`),
  ])
  const lines = [`Pull Request #${pr.number}: ${pr.title}`, `Status: ${pr.state}${pr.draft ? ' (Entwurf)' : ''}, ${pr.head.ref} → ${pr.base.ref}, von ${pr.user.login}`, '', pr.body || '(keine Beschreibung)', '', `Geänderte Dateien (${files.length}):`]
  for (const file of files) lines.push(`- ${file.filename} (+${file.additions} −${file.deletions})`)
  if (comments.length) {
    lines.push('', 'Review-Kommentare:')
    for (const comment of comments) lines.push(`- ${comment.user.login} zu ${comment.path}:${comment.line ?? comment.original_line ?? ''}: ${short(comment.body.replace(/\s+/g, ' '), 300)}`)
  }
  return { pr, text: lines.join('\n') }
}

async function issueText(context, repo, number) {
  const [issue, comments] = await Promise.all([github(context, `/repos/${repo}/issues/${number}`), github(context, `/repos/${repo}/issues/${number}/comments?per_page=30`)])
  const lines = [`Issue #${issue.number}: ${issue.title}`, `Status: ${issue.state}, von ${issue.user.login}${issue.labels.length ? `, Labels: ${issue.labels.map((label) => label.name).join(', ')}` : ''}`, '', issue.body || '(keine Beschreibung)']
  if (comments.length) {
    lines.push('', 'Kommentare:')
    for (const comment of comments) lines.push(`- ${comment.user.login}: ${short(comment.body.replace(/\s+/g, ' '), 400)}`)
  }
  return { issue, text: lines.join('\n') }
}

module.exports = {
  activate(context) {
    context.commands.register('repositories', async (args) => {
      const page = Math.max(1, Number(args.page) || 1)
      const owner = String(args.owner || '').trim()
      const repos = await github(context, owner ? `/users/${encodeURIComponent(owner)}/repos?per_page=100&page=${page}` : `/user/repos?per_page=100&page=${page}`)
      return { view: { type: 'table', columns: ['Repository', 'Branch', 'Privat'], rows: repos.map((repo) => ({ cells: [repo.full_name, repo.default_branch, String(repo.private)] })) } }
    })
    context.commands.register('branches', async (args) => {
      const repo = await repository(context)
      const branches = await github(context, `/repos/${repo}/branches?per_page=100&page=${Math.max(1, Number(args.page) || 1)}`)
      return { view: { type: 'table', columns: ['Branch', 'Commit', 'Geschützt'], rows: branches.map((branch) => ({ cells: [branch.name, branch.commit.sha, String(branch.protected)] })) } }
    })
    context.commands.register('reviews', async (args) => {
      const repo = await repository(context)
      const number = Number(args.number)
      if (!Number.isSafeInteger(number) || number < 1) throw new Error('Ungültige PR-Nummer.')
      const reviews = await github(context, `/repos/${repo}/pulls/${number}/reviews?per_page=100`)
      return { view: { type: 'table', columns: ['Autor', 'Status', 'Review'], rows: reviews.map((review) => ({ cells: [review.user.login, review.state, review.body || ''] })) } }
    })
    context.commands.register('createReview', async (args) => {
      if (args.confirmed !== true) throw new Error('Review veröffentlichen erfordert ausdrückliche Bestätigung.')
      const number = Number(args.number)
      if (!Number.isSafeInteger(number) || number < 1 || !['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(args.event)) throw new Error('Ungültige Review-Daten.')
      const repo = await repository(context)
      const review = await github(context, `/repos/${repo}/pulls/${number}/reviews`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: String(args.body || ''), event: args.event }) })
      return { message: `Review ${review.id}: ${review.state}` }
    })
    context.views.register('main', async () => {
      let repo
      try {
        repo = await repository(context)
      } catch (error) {
        return { type: 'stack', children: [{ type: 'heading', text: 'GitHub' }, { type: 'text', tone: 'warning', text: error.message }] }
      }
      const hasToken = Boolean(await context.secrets.get('token').catch(() => undefined))
      const [pulls, issues] = await Promise.all([github(context, `/repos/${repo}/pulls?state=open&per_page=30`), github(context, `/repos/${repo}/issues?state=open&per_page=30`)])
      const onlyIssues = issues.filter((issue) => !issue.pull_request)
      return {
        type: 'stack',
        children: [
          { type: 'heading', text: `GitHub · ${repo}` },
          { type: 'form', fields: [{ name: 'owner', label: 'Repositories eines Benutzers (leer = eigene)', type: 'text' }, { name: 'page', label: 'Seite', type: 'number', value: 1 }], submit: { label: 'Repositories laden', command: 'repositories' } },
          { type: 'actions', items: [{ label: 'Branches', command: 'branches' }] },
          { type: 'form', fields: [{ name: 'number', label: 'PR-Nummer', type: 'number' }], submit: { label: 'Reviews laden', command: 'reviews' } },
          { type: 'form', fields: [{ name: 'number', label: 'PR-Nummer', type: 'number' }, { name: 'event', label: 'Review', type: 'select', options: ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'], value: 'COMMENT' }, { name: 'body', label: 'Kommentar', type: 'textarea' }], submit: { label: 'Review veröffentlichen', command: 'createReview', confirm: 'Review im GitHub-Repository veröffentlichen?' } },
          { type: 'kv', items: [{ label: 'Offene Pull Requests', value: String(pulls.length) }, { label: 'Offene Issues', value: String(onlyIssues.length) }, { label: 'Authentifizierung', value: hasToken ? 'Access Token' : 'ohne Token (nur öffentlich, 60 Anfragen/h)' }] },
          { type: 'heading', text: 'Pull Requests' },
          pulls.length
            ? {
                type: 'table',
                columns: ['#', 'Titel', 'Autor', 'Branch', 'Aktualisiert'],
                rows: pulls.map((pr) => ({
                  cells: [String(pr.number), short(pr.title), pr.user.login, pr.head.ref, date(pr.updated_at)],
                  actions: [
                    { label: 'Details', command: 'pullRequest', args: { number: pr.number } },
                    { label: 'In Chat', command: 'toChat', args: { kind: 'pull', number: pr.number }, resultTarget: 'chat' },
                  ],
                })),
              }
            : { type: 'text', tone: 'muted', text: 'Keine offenen Pull Requests.' },
          { type: 'heading', text: 'Issues' },
          onlyIssues.length
            ? {
                type: 'table',
                columns: ['#', 'Titel', 'Labels', 'Autor', 'Aktualisiert'],
                rows: onlyIssues.map((issue) => ({
                  cells: [String(issue.number), short(issue.title), issue.labels.map((label) => label.name).join(', '), issue.user.login, date(issue.updated_at)],
                  actions: [
                    { label: 'Details', command: 'issue', args: { number: issue.number } },
                    { label: 'In Chat', command: 'toChat', args: { kind: 'issue', number: issue.number }, resultTarget: 'chat' },
                  ],
                })),
              }
            : { type: 'text', tone: 'muted', text: 'Keine offenen Issues.' },
          { type: 'heading', text: 'Neues Issue' },
          {
            type: 'form',
            fields: [
              { name: 'title', label: 'Titel', type: 'text' },
              { name: 'body', label: 'Beschreibung', type: 'textarea' },
            ],
            submit: { label: 'Issue anlegen', command: 'createIssue', confirm: `Issue in ${repo} anlegen?` },
          },
        ],
      }
    })

    context.commands.register('pullRequest', async (args) => {
      const repo = await repository(context)
      const { pr, text } = await pullRequestText(context, repo, Number(args.number))
      return { title: `PR #${pr.number}`, view: { type: 'stack', children: [{ type: 'heading', text: `#${pr.number} ${pr.title}` }, { type: 'markdown', text: text }, { type: 'actions', items: [{ label: 'In Chat übernehmen', command: 'toChat', args: { kind: 'pull', number: pr.number }, resultTarget: 'chat' }] }] } }
    })

    context.commands.register('issue', async (args) => {
      const repo = await repository(context)
      const { issue, text } = await issueText(context, repo, Number(args.number))
      return { title: `Issue #${issue.number}`, view: { type: 'stack', children: [{ type: 'heading', text: `#${issue.number} ${issue.title}` }, { type: 'markdown', text: text }, { type: 'actions', items: [{ label: 'In Chat übernehmen', command: 'toChat', args: { kind: 'issue', number: issue.number }, resultTarget: 'chat' }] }] } }
    })

    context.commands.register('toChat', async (args) => {
      const repo = await repository(context)
      const { text } = args.kind === 'pull' ? await pullRequestText(context, repo, Number(args.number)) : await issueText(context, repo, Number(args.number))
      return { text, message: 'Als Kontext in den Chat übernommen.' }
    })

    context.commands.register('createIssue', async (args) => {
      const title = String(args.title || '').trim()
      if (!title) throw new Error('Titel fehlt.')
      if (!(await context.secrets.get('token'))) throw new Error('Zum Anlegen von Issues wird ein Access Token benötigt (Plugin-Einstellungen).')
      const repo = await repository(context)
      const issue = await github(context, `/repos/${repo}/issues`, { method: 'POST', body: JSON.stringify({ title, body: String(args.body || '') }), headers: { 'Content-Type': 'application/json' } })
      return { message: `Issue #${issue.number} angelegt: ${issue.html_url}` }
    })

    context.tools.register('github_issues', async (args) => {
      const repo = await repository(context)
      const issues = (await github(context, `/repos/${repo}/issues?state=open&per_page=50`)).filter((issue) => !issue.pull_request)
      const query = String(args.query || '').toLowerCase()
      return issues.filter((issue) => !query || issue.title.toLowerCase().includes(query)).map((issue) => ({ number: issue.number, title: issue.title, labels: issue.labels.map((label) => label.name) }))
    })

    context.tools.register('github_pull_request', async (args) => (await pullRequestText(context, await repository(context), Number(args.number))).text)

    // "#123" in a goal: the issue text becomes planning context (only if the project is on GitHub)
    context.contextProviders.register('referenced-issues', async ({ goal }) => {
      const numbers = [...new Set([...String(goal).matchAll(/(?:^|\s)#(\d{1,7})\b/g)].map((match) => Number(match[1])))].slice(0, 3)
      if (!numbers.length) return undefined
      const repo = await repository(context).catch(() => undefined)
      if (!repo) return undefined
      const texts = await Promise.all(numbers.map((number) => issueText(context, repo, number).then((result) => result.text, () => undefined)))
      return texts.filter(Boolean).join('\n\n---\n\n') || undefined
    })
  },
}
