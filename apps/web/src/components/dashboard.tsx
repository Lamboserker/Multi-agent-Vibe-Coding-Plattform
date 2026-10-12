'use client'

import { FormEvent, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  ClipboardCheck,
  Code2,
  Coins,
  Cpu,
  Database,
  FileSearch,
  GitBranch,
  LayoutDashboard,
  ListChecks,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Route,
  Save,
  Server,
  ShieldCheck,
  Sparkles,
  TestTube2,
  ToggleLeft,
  ToggleRight,
  WalletCards,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { API_BASE_URL, ApiError, apiRequest } from '@/lib/api'
import { LogoutButton } from './logout-button'

type ModelClass = 'no_llm' | 'local_llm' | 'free_llm' | 'cheap_api_llm' | 'premium_llm'
type CostMode = 'cheapest' | 'balanced' | 'quality'

interface RepoScanSummary {
  exists?: boolean
  frameworks?: string[]
  scripts?: Record<string, string>
  importantFiles?: string[]
  apiRoutes?: string[]
  databaseSchemas?: string[]
  testFiles?: string[]
  docs?: string[]
  directories?: string[]
  warnings?: string[]
}

interface Project {
  id: string
  name: string
  repoPath: string
  defaultBranch?: string | null
  techStack?: RepoScanSummary
  packageManager?: string | null
  createdAt: string
  updatedAt: string
  _count?: { tasks: number }
  tasks?: Task[]
}

interface Task {
  id: string
  projectId: string
  project?: Project
  userPrompt: string
  normalizedGoal?: string | null
  status: string
  complexity?: string | null
  taskType?: string | null
  riskLevel?: string | null
  contextNeed?: string | null
  securitySensitive: boolean
  estimatedCostTier?: string | null
  maxCostEuro?: string | number | null
  createdAt: string
  updatedAt: string
  subtasks?: Subtask[]
  runs?: AgentRun[]
  contexts?: ContextSnapshot[]
}

interface Subtask {
  id: string
  taskId: string
  title: string
  goal: string
  status: string
  assignedAgentType: string
  selectedModelClass: ModelClass
  allowedFiles: string[]
  deniedFiles: string[]
  expectedChange: string
  validationCommands: string[]
  budgetLimitEuro: string | number
  dependsOn: string[]
}

interface ModelProvider {
  id: string
  name: string
  providerType: 'ollama' | 'openai_compatible' | 'gemini_cli' | 'manual'
  modelClass: ModelClass
  baseUrl?: string | null
  apiKeyEnvName?: string | null
  enabled: boolean
  supportsStreaming: boolean
  supportsToolUse: boolean
  supportsStructuredOutput: boolean
  contextWindow?: number | null
  costInputPerMillion?: string | number | null
  costOutputPerMillion?: string | number | null
  freeQuotaDaily?: number | null
  notes?: string | null
}

interface ContextSnapshot {
  id: string
  summary: string
  relevantFiles: string[]
  tokenEstimate: number
  createdAt: string
}

interface AgentRun {
  id: string
  taskId: string
  subtaskId?: string | null
  subtask?: Subtask | null
  agentName: string
  selectedModelClass: ModelClass
  providerId?: string | null
  provider?: ModelProvider | null
  status: string
  promptSummary: string
  inputTokenEstimate: number
  outputTokenEstimate: number
  estimatedCostEuro: string | number
  actualCostEuro?: string | number | null
  diffSummary?: string | null
  validationStatus: string
  score?: number | null
  errorMessage?: string | null
  createdAt: string
  reviews?: Review[]
}

interface Review {
  id: string
  verdict: string
  score: number
  issues: string[]
  requiresHumanApproval: boolean
  recommendedAction: string
  createdAt: string
}

interface CostSummary {
  totalEstimatedCostEuro: number
  totalActualCostEuro: number
  totalRuns: number
  byModelClass: Record<string, number>
  byProvider: Record<string, number>
  premiumRuns: number
  freeOrLocalRuns: number
}

interface AnalyzeResult {
  task: Task
  classification: {
    normalizedGoal: string
    complexity: string
    taskType: string
    riskLevel: string
    contextNeed: string
    securitySensitive: boolean
    estimatedCostTier: string
    deterministicOnly: boolean
    affectedAreas: string[]
    reason: string
  }
  routing: {
    selectedModelClass: ModelClass
    providerName?: string
    estimatedInputTokens: number
    estimatedOutputTokens: number
    estimatedCostEuro: number
    requiresHumanApproval: boolean
    reasons: string[]
    escalationRules: string[]
  }
  context: ContextSnapshot
  validation: {
    commands: string[]
    unavailableReasons: string[]
  }
}

interface PlanResult {
  taskId: string
  classification: AnalyzeResult['classification']
  contextSnapshotId: string
  contextTokenEstimate: number
  validation: AnalyzeResult['validation']
  subtasks: Subtask[]
  planRationale: Array<{
    title: string
    selectedModelClass: ModelClass
    requiresHumanApproval: boolean
    routingReasons: string[]
  }>
}

interface RunResult {
  mode: string
  runs: AgentRun[]
  reviews: Review[]
  totalEstimatedCostEuro: number
}

interface ValidationResult {
  execute: boolean
  commands: string[]
  unavailableReasons: string[]
  results: Array<{
    command: string
    status: string
    outputSummary: string
  }>
}

interface ProviderTestResult {
  ok: boolean
  message: string
  models?: string[]
  version?: string
  detail?: string
}

const modelLabels: Record<string, string> = {
  no_llm: 'no_llm',
  local_llm: 'local',
  free_llm: 'free',
  cheap_api_llm: 'cheap_api',
  premium_llm: 'premium',
}

const modelClasses: ModelClass[] = ['no_llm', 'local_llm', 'free_llm', 'cheap_api_llm', 'premium_llm']
const metricWindowDays = 30

const navItems: Array<{ Icon: LucideIcon; href: string; label: string }> = [
  { Icon: LayoutDashboard, href: '/dashboard', label: 'Dashboard' },
  { Icon: Database, href: '/projects', label: 'Projects' },
  { Icon: ListChecks, href: '/tasks', label: 'Tasks' },
  { Icon: Route, href: '/plan', label: 'Plan' },
  { Icon: Play, href: '/runs', label: 'Runs' },
  { Icon: Cpu, href: '/models', label: 'Models' },
  { Icon: Coins, href: '/costs', label: 'Costs' },
  { Icon: ShieldCheck, href: '/safety', label: 'Safety' },
]

const defaultRepoPath = 'D:\\Programmieren\\Multi-Agent-Vibe-Coding-Plattform'

export function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [models, setModels] = useState<ModelProvider[]>([])
  const [costSummary, setCostSummary] = useState<CostSummary | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const [taskDetail, setTaskDetail] = useState<Task | null>(null)
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null)
  const [plan, setPlan] = useState<PlanResult | null>(null)
  const [runResult, setRunResult] = useState<RunResult | null>(null)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [providerTest, setProviderTest] = useState<ProviderTestResult | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [operation, setOperation] = useState<string | null>(null)

  const [projectForm, setProjectForm] = useState({ name: 'Multi-Agent-Vibe-Coding-Plattform', repoPath: defaultRepoPath })
  const [taskForm, setTaskForm] = useState({
    userPrompt: 'Add a functional project onboarding flow and show cost-aware model routing decisions.',
    maxCostEuro: '0.50',
    costMode: 'balanced' as CostMode,
    premiumAllowed: false,
    allowedModelClasses: new Set<ModelClass>(modelClasses),
  })

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0]
  const selectedTask =
    (taskDetail?.id === selectedTaskId ? taskDetail : null) ?? tasks.find((task) => task.id === selectedTaskId) ?? tasks[0]
  const allRuns = useMemo(() => tasks.flatMap((task) => task.runs ?? []), [tasks])
  const metricSeries = useMemo(() => buildMetricSeries(tasks, allRuns, metricWindowDays), [tasks, allRuns])
  const selectedTaskRuns = selectedTask?.runs ?? []
  const currentSubtasks = plan?.subtasks ?? selectedTask?.subtasks ?? []
  const currentContext = analysis?.context ?? selectedTask?.contexts?.[0]

  const runCounts = useMemo(() => {
    const counts = new Map<ModelClass, number>()
    for (const modelClass of modelClasses) counts.set(modelClass, 0)
    for (const run of allRuns) counts.set(run.selectedModelClass, (counts.get(run.selectedModelClass) ?? 0) + 1)
    return counts
  }, [allRuns])

  useEffect(() => {
    void refreshAll('initial')
  }, [])

  useEffect(() => {
    if (!selectedProjectId && projects[0]) setSelectedProjectId(projects[0].id)
  }, [projects, selectedProjectId])

  useEffect(() => {
    if (!selectedTaskId && tasks[0]) setSelectedTaskId(tasks[0].id)
  }, [tasks, selectedTaskId])

  useEffect(() => {
    if (selectedTaskId) {
      setAnalysis(null)
      setPlan(null)
      setRunResult(null)
      setValidation(null)
      void loadTask(selectedTaskId, false)
    }
  }, [selectedTaskId])

  async function refreshAll(reason = 'manual') {
    setLoading(true)
    setError(null)
    try {
      const [projectData, taskData, modelData, costData] = await Promise.all([
        apiRequest<Project[]>('/projects'),
        apiRequest<Task[]>('/tasks'),
        apiRequest<ModelProvider[]>('/models'),
        apiRequest<CostSummary>('/cost/summary'),
      ])
      setProjects(projectData)
      setTasks(taskData)
      setModels(modelData)
      setCostSummary(costData)
      if (reason === 'manual') setNotice('Dashboard data refreshed.')
    } catch (requestError) {
      setError(formatError(requestError))
    } finally {
      setLoading(false)
    }
  }

  async function loadTask(taskId: string, announce = true) {
    try {
      const data = await apiRequest<Task>(`/tasks/${taskId}`)
      setTaskDetail(data)
      if (announce) setNotice('Task loaded.')
    } catch (requestError) {
      setError(formatError(requestError))
    }
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await runOperation('Creating project', async () => {
      const project = await apiRequest<Project>('/projects', {
        method: 'POST',
        body: JSON.stringify(projectForm),
      })
      setSelectedProjectId(project.id)
      setNotice('Project created and indexed.')
      await refreshAll('silent')
    })
  }

  async function indexProject(projectId: string) {
    await runOperation('Indexing project', async () => {
      await apiRequest<Project>(`/projects/${projectId}/index`, { method: 'POST' })
      setNotice('Project index refreshed.')
      await refreshAll('silent')
    })
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const projectId = selectedProjectId || selectedProject?.id
    if (!projectId) {
      setError('Create or select a project first.')
      return
    }

    await runOperation('Creating task', async () => {
      const task = await apiRequest<Task>('/tasks', {
        method: 'POST',
        body: JSON.stringify({
          projectId,
          userPrompt: taskForm.userPrompt,
          maxCostEuro: Number(taskForm.maxCostEuro || 0),
        }),
      })
      setSelectedTaskId(task.id)
      setTaskDetail(task)
      setAnalysis(null)
      setPlan(null)
      setRunResult(null)
      setValidation(null)
      setNotice('Task created. Run analysis next.')
      await refreshAll('silent')
    })
  }

  async function analyzeTask() {
    const taskId = selectedTask?.id
    if (!taskId) return setError('Select or create a task first.')
    await runOperation('Analyzing task', async () => {
      const result = await apiRequest<AnalyzeResult>(`/tasks/${taskId}/analyze`, {
        method: 'POST',
        body: JSON.stringify(taskOptionsPayload()),
      })
      setAnalysis(result)
      setTaskDetail(result.task)
      setPlan(null)
      setRunResult(null)
      setValidation(null)
      setNotice(`Analysis complete: ${result.routing.selectedModelClass}.`)
      await refreshAll('silent')
    })
  }

  async function planTask() {
    const taskId = selectedTask?.id
    if (!taskId) return setError('Select or create a task first.')
    await runOperation('Planning task', async () => {
      const result = await apiRequest<PlanResult>(`/tasks/${taskId}/plan`, {
        method: 'POST',
        body: JSON.stringify(taskOptionsPayload()),
      })
      setPlan(result)
      setNotice(`Plan created with ${result.subtasks.length} subtask(s).`)
      await loadTask(taskId, false)
      await refreshAll('silent')
    })
  }

  async function runTask() {
    const taskId = selectedTask?.id
    if (!taskId) return setError('Select or create a task first.')
    await runOperation('Running simulation', async () => {
      const result = await apiRequest<RunResult>(`/tasks/${taskId}/run`, {
        method: 'POST',
        body: JSON.stringify({ simulate: true }),
      })
      setRunResult(result)
      setNotice(`Simulation complete. Estimated cost: ${formatEuro(result.totalEstimatedCostEuro)}.`)
      await loadTask(taskId, false)
      await refreshAll('silent')
    })
  }

  async function runFullPipeline() {
    const taskId = selectedTask?.id
    if (!taskId) return setError('Select or create a task first.')

    await runOperation('Analyzing, planning, and running simulation', async () => {
      const options = taskOptionsPayload()
      const analysisResult = await apiRequest<AnalyzeResult>(`/tasks/${taskId}/analyze`, {
        method: 'POST',
        body: JSON.stringify(options),
      })
      setAnalysis(analysisResult)

      const planResult = await apiRequest<PlanResult>(`/tasks/${taskId}/plan`, {
        method: 'POST',
        body: JSON.stringify(options),
      })
      setPlan(planResult)

      const run = await apiRequest<RunResult>(`/tasks/${taskId}/run`, {
        method: 'POST',
        body: JSON.stringify({ simulate: true }),
      })
      setRunResult(run)
      setNotice(`Pipeline complete. ${planResult.subtasks.length} subtask(s), ${run.runs.length} run(s), ${formatEuro(run.totalEstimatedCostEuro)} estimated.`)
      await loadTask(taskId, false)
      await refreshAll('silent')
    })
  }

  async function validateTask() {
    const taskId = selectedTask?.id
    if (!taskId) return setError('Select or create a task first.')
    await runOperation('Planning validation', async () => {
      const result = await apiRequest<ValidationResult>(`/tasks/${taskId}/validate`, {
        method: 'POST',
        body: JSON.stringify({ execute: false }),
      })
      setValidation(result)
      setNotice('Validation commands planned.')
    })
  }

  async function reviewTask() {
    const taskId = selectedTask?.id
    if (!taskId) return setError('Select or create a task first.')
    await runOperation('Reviewing task', async () => {
      const reviews = await apiRequest<Review[]>(`/tasks/${taskId}/review`, { method: 'POST' })
      setNotice(`Review complete with ${reviews.length} review result(s).`)
      await loadTask(taskId, false)
      await refreshAll('silent')
    })
  }

  async function toggleModel(model: ModelProvider) {
    await runOperation('Updating model', async () => {
      await apiRequest<ModelProvider>(`/models/${model.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !model.enabled }),
      })
      setNotice(`${model.name} ${model.enabled ? 'disabled' : 'enabled'}.`)
      await refreshAll('silent')
    })
  }

  async function testModel(model: ModelProvider) {
    await runOperation('Testing provider', async () => {
      const result = await apiRequest<ProviderTestResult>('/models/test-connection', {
        method: 'POST',
        body: JSON.stringify({
          providerType: model.providerType,
          baseUrl: model.baseUrl,
          apiKeyEnvName: model.apiKeyEnvName,
        }),
      })
      setProviderTest(result)
      setNotice(result.ok ? `${model.name} connection OK.` : `${model.name} connection failed.`)
    })
  }

  async function runOperation(label: string, action: () => Promise<void>) {
    setOperation(label)
    setError(null)
    setNotice(null)
    try {
      await action()
    } catch (requestError) {
      setError(formatError(requestError))
    } finally {
      setOperation(null)
    }
  }

  function taskOptionsPayload() {
    return {
      costMode: taskForm.costMode,
      premiumAllowed: taskForm.premiumAllowed,
      allowedModelClasses: [...taskForm.allowedModelClasses],
    }
  }

  function updateAllowedModelClass(modelClass: ModelClass, allowed: boolean) {
    setTaskForm((current) => {
      const next = new Set(current.allowedModelClasses)
      if (allowed) next.add(modelClass)
      else next.delete(modelClass)
      return { ...current, allowedModelClasses: next }
    })
  }

  const localRunPercent = percentage(runCounts.get('local_llm') ?? 0, allRuns.length)
  const freeRunPercent = percentage(runCounts.get('free_llm') ?? 0, allRuns.length)
  const cheapRunPercent = percentage(runCounts.get('cheap_api_llm') ?? 0, allRuns.length)
  const premiumRunPercent = percentage(runCounts.get('premium_llm') ?? 0, allRuns.length)
  const completedTasks = tasks.filter((task) => task.status === 'completed').length
  const premiumAvoided = Math.max(0, allRuns.length - (runCounts.get('premium_llm') ?? 0))

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">AI</div>
          <div>
            <strong>Multi-AI Coder</strong>
            <span>Cost-Aware Coding Platform</span>
          </div>
        </div>

        <section className="sidebar-section">
          <div className="section-label">API</div>
          <div className="api-status">
            <span className={error ? 'api-dot offline' : 'api-dot online'} />
            <div>
              <strong>{error ? 'Needs attention' : 'Connected'}</strong>
              <small>{API_BASE_URL}</small>
            </div>
          </div>
          <button className="ghost-button" type="button" onClick={() => void refreshAll('manual')} disabled={loading || Boolean(operation)}>
            <RefreshCw size={16} /> Refresh
          </button>
          <LogoutButton className="ghost-button" disabled={loading || Boolean(operation)} />
        </section>

        <section className="sidebar-section">
          <div className="section-label">Projects</div>
          <div className="project-list">
            {projects.length === 0 ? (
              <p className="muted-copy">No projects yet.</p>
            ) : (
              projects.map((project) => (
                <button
                  className={`project-pill ${project.id === selectedProject?.id ? 'selected' : ''}`}
                  key={project.id}
                  type="button"
                  onClick={() => setSelectedProjectId(project.id)}
                >
                  <Server size={16} />
                  <span>{project.name}</span>
                  <i data-state={project.techStack?.exists ? 'indexed' : 'pending'} />
                </button>
              ))
            )}
          </div>
        </section>

        <nav className="main-nav" aria-label="Main navigation">
          {navItems.map(({ Icon, href, label }) => (
            <a href={href} key={href}>
              <Icon size={17} />
              {label}
            </a>
          ))}
        </nav>

        <section className="credit-panel">
          <span className="section-label">Credits</span>
          <strong>{formatEuro(0)}</strong>
          <small>Credit accounting is prepared in the backend. Local and BYOK runs can stay zero-cost.</small>
          <button className="primary-button" type="button" disabled>
            <WalletCards size={16} /> Credit stub
          </button>
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>Cost-Aware Orchestrator</h1>
            <p>Real API-backed project intake, task analysis, planning, simulation, review, and model management.</p>
          </div>
          <div className="toolbar">
            <div className="mode-button" aria-label="Current cost mode">
              <Route size={16} />
              <span>
                Cost Mode
                <strong>{capitalize(taskForm.costMode)}</strong>
              </span>
            </div>
            <button className="primary-button" type="button" onClick={() => document.getElementById('task-intake')?.scrollIntoView()}>
              <Plus size={17} /> New Task
            </button>
          </div>
        </header>

        {(notice || error || operation) && (
          <div className={`notice ${error ? 'error' : ''}`}>
            {operation && <Loader2 className="spin" size={16} />}
            <span>{error ?? operation ?? notice}</span>
          </div>
        )}

        <section className="metrics-grid" aria-label="Cost and model usage" id="dashboard">
          <MetricCard
            icon={<CircleDollarSign size={18} />}
            label="Estimated cost"
            value={formatEuro(costSummary?.totalEstimatedCostEuro ?? 0)}
            trend={`${costSummary?.totalRuns ?? 0} stored run(s) / ${metricWindowDays}d curve`}
            tone="green"
            series={metricSeries.cost}
            seriesLabel="Estimated and actual run cost by day"
          />
          <MetricCard
            icon={<CheckCircle2 size={18} />}
            label="Tasks completed"
            value={String(completedTasks)}
            trend={`${tasks.length} task(s) in history / completed by day`}
            tone="blue"
            series={metricSeries.completedTasks}
            seriesLabel="Completed tasks by day"
          />
          <MetricCard
            icon={<Cpu size={18} />}
            label="Local model usage"
            value={`${localRunPercent}%`}
            trend={`${runCounts.get('local_llm') ?? 0} local run(s) / ${allRuns.length} total`}
            tone="green"
            series={metricSeries.localRuns}
            seriesLabel="Local model runs by day"
          />
          <MetricCard
            icon={<Bot size={18} />}
            label="Free model usage"
            value={`${freeRunPercent}%`}
            trend={`${runCounts.get('free_llm') ?? 0} free run(s) / ${allRuns.length} total`}
            tone="blue"
            series={metricSeries.freeRuns}
            seriesLabel="Free model runs by day"
          />
          <MetricCard
            icon={<Code2 size={18} />}
            label="Cheap API usage"
            value={`${cheapRunPercent}%`}
            trend={`${runCounts.get('cheap_api_llm') ?? 0} cheap API run(s) / ${allRuns.length} total`}
            tone="orange"
            series={metricSeries.cheapRuns}
            seriesLabel="Cheap API model runs by day"
          />
          <MetricCard
            icon={<Sparkles size={18} />}
            label="Premium usage"
            value={`${premiumRunPercent}%`}
            trend={`${premiumAvoided} run(s) avoided premium`}
            tone="purple"
            series={metricSeries.premiumRuns}
            seriesLabel="Premium model runs by day"
          />
        </section>

        <section className="content-grid">
          <Panel id="projects" title="Project Manager" action={<button type="button" onClick={() => selectedProject && void indexProject(selectedProject.id)} disabled={!selectedProject || Boolean(operation)}><RefreshCw size={15} /> Index selected</button>}>
            <form className="form-grid" onSubmit={(event) => void createProject(event)}>
              <Field label="Project name">
                <input value={projectForm.name} onChange={(event) => setProjectForm((current) => ({ ...current, name: event.target.value }))} required />
              </Field>
              <Field label="Local repo path">
                <input value={projectForm.repoPath} onChange={(event) => setProjectForm((current) => ({ ...current, repoPath: event.target.value }))} required />
              </Field>
              <button className="primary-button form-submit" type="submit" disabled={Boolean(operation)}>
                <Save size={16} /> Save project
              </button>
            </form>

            {selectedProject ? (
              <div className="project-detail">
                <div>
                  <h3>{selectedProject.name}</h3>
                  <p>{selectedProject.repoPath}</p>
                </div>
                <div className="chip-row">
                  <Badge value={selectedProject.packageManager ?? 'unknown package manager'} />
                  {(selectedProject.techStack?.frameworks ?? []).map((framework) => (
                    <Badge value={framework} key={framework} />
                  ))}
                </div>
                <div className="insight-grid">
                  <RunTile icon={<FileSearch size={18} />} label="Important files" value={String(selectedProject.techStack?.importantFiles?.length ?? 0)} />
                  <RunTile icon={<Database size={18} />} label="Database schemas" value={String(selectedProject.techStack?.databaseSchemas?.length ?? 0)} />
                  <RunTile icon={<TestTube2 size={18} />} label="Test files" value={String(selectedProject.techStack?.testFiles?.length ?? 0)} />
                  <RunTile icon={<Code2 size={18} />} label="Scripts" value={Object.keys(selectedProject.techStack?.scripts ?? {}).join(', ') || 'none'} />
                </div>
                <FileList title="Warnings" files={selectedProject.techStack?.warnings ?? []} />
              </div>
            ) : (
              <EmptyState title="No project selected" text="Create a project from a local repository path to enable task analysis." />
            )}
          </Panel>

          <Panel id="tasks" title="Task Intake" action={<button type="button" onClick={() => selectedTask && void analyzeTask()} disabled={!selectedTask || Boolean(operation)}><ClipboardCheck size={15} /> Analyze selected</button>}>
            <form className="task-form" id="task-intake" onSubmit={(event) => void createTask(event)}>
              <Field label="Project">
                <select value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)} required>
                  <option value="" disabled>Select project</option>
                  {projects.map((project) => (
                    <option value={project.id} key={project.id}>{project.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Coding task">
                <textarea value={taskForm.userPrompt} onChange={(event) => setTaskForm((current) => ({ ...current, userPrompt: event.target.value }))} rows={5} required />
              </Field>
              <div className="form-row">
                <Field label="Max cost EUR">
                  <input type="number" min="0" step="0.01" value={taskForm.maxCostEuro} onChange={(event) => setTaskForm((current) => ({ ...current, maxCostEuro: event.target.value }))} />
                </Field>
                <Field label="Mode">
                  <select value={taskForm.costMode} onChange={(event) => setTaskForm((current) => ({ ...current, costMode: event.target.value as CostMode }))}>
                    <option value="cheapest">cheapest</option>
                    <option value="balanced">balanced</option>
                    <option value="quality">quality</option>
                  </select>
                </Field>
              </div>
              <label className="toggle-line">
                <input type="checkbox" checked={taskForm.premiumAllowed} onChange={(event) => setTaskForm((current) => ({ ...current, premiumAllowed: event.target.checked }))} />
                Allow premium planning/review when policy requires it
              </label>
              <div className="model-class-picker">
                {modelClasses.map((modelClass) => (
                  <label key={modelClass}>
                    <input type="checkbox" checked={taskForm.allowedModelClasses.has(modelClass)} onChange={(event) => updateAllowedModelClass(modelClass, event.target.checked)} />
                    <Badge value={modelClass} />
                  </label>
                ))}
              </div>
              <button className="primary-button form-submit" type="submit" disabled={projects.length === 0 || Boolean(operation)}>
                <Plus size={16} /> Create task
              </button>
            </form>

            <div className="pipeline-actions">
              <button type="button" onClick={() => void analyzeTask()} disabled={!selectedTask || Boolean(operation)}>
                <ClipboardCheck size={16} /> Analyze
              </button>
              <button type="button" onClick={() => void planTask()} disabled={!selectedTask || Boolean(operation)}>
                <Route size={16} /> Plan
              </button>
              <button type="button" onClick={() => void runTask()} disabled={!selectedTask || Boolean(operation)}>
                <Play size={16} /> Run simulation
              </button>
              <button className="strong-action" type="button" onClick={() => void runFullPipeline()} disabled={!selectedTask || Boolean(operation)}>
                <Sparkles size={16} /> Analyze + Plan + Run
              </button>
            </div>

            <div className="task-list">
              {tasks.length === 0 ? (
                <EmptyState title="No tasks yet" text="Create a task to unlock analysis, planning, simulation, validation, and review actions." />
              ) : (
                tasks.map((task) => (
                  <button className={`task-row ${task.id === selectedTask?.id ? 'selected' : ''}`} type="button" key={task.id} onClick={() => setSelectedTaskId(task.id)}>
                    <span>
                      <strong>{task.normalizedGoal ?? task.userPrompt}</strong>
                      <small>{task.project?.name ?? projectName(task.projectId, projects)} - {formatDate(task.createdAt)}</small>
                    </span>
                    <Status value={task.status} />
                  </button>
                ))
              )}
            </div>
          </Panel>

          <Panel title="Task Analysis" action={<button type="button" onClick={() => void planTask()} disabled={!selectedTask || Boolean(operation)}><Route size={15} /> Create plan</button>}>
            {selectedTask ? (
              <div className="task-card">
                <div className="prompt-box">{selectedTask.userPrompt}</div>
                <div className="analysis-grid">
                  <div>
                    <MetricLine label="Complexity" value={analysis?.classification.complexity ?? selectedTask.complexity ?? 'not analyzed'} tone={riskTone(selectedTask.complexity)} />
                    <MetricLine label="Task type" value={analysis?.classification.taskType ?? selectedTask.taskType ?? 'not analyzed'} />
                    <MetricLine label="Risk level" value={analysis?.classification.riskLevel ?? selectedTask.riskLevel ?? 'not analyzed'} tone={riskTone(analysis?.classification.riskLevel ?? selectedTask.riskLevel)} />
                    <MetricLine label="Context need" value={analysis?.classification.contextNeed ?? selectedTask.contextNeed ?? 'not analyzed'} />
                    <MetricLine label="Security sensitive" value={analysis?.classification.securitySensitive || selectedTask.securitySensitive ? 'yes' : 'no'} tone={analysis?.classification.securitySensitive || selectedTask.securitySensitive ? 'orange' : 'green'} />
                  </div>
                  <div className="decision-box">
                    <span>Recommended model class</span>
                    <strong>{analysis?.routing.selectedModelClass ?? 'Run analysis'}</strong>
                    {analysis?.routing.selectedModelClass && <Badge value={analysis.routing.selectedModelClass} />}
                    <ul>
                      {(analysis?.routing.reasons ?? ['No routing decision yet.']).map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </div>
                </div>
                {analysis && (
                  <div className="insight-grid">
                    <RunTile icon={<FileSearch size={18} />} label="Context tokens" value={String(analysis.context.tokenEstimate)} />
                    <RunTile icon={<Cpu size={18} />} label="Provider" value={analysis.routing.providerName ?? 'unassigned'} />
                    <RunTile icon={<Coins size={18} />} label="Est. cost" value={formatEuro(analysis.routing.estimatedCostEuro)} />
                    <RunTile icon={<ShieldCheck size={18} />} label="Human approval" value={analysis.routing.requiresHumanApproval ? 'required' : 'not required'} />
                  </div>
                )}
              </div>
            ) : (
              <EmptyState title="No task selected" text="Create or select a task to analyze routing and risk." />
            )}
          </Panel>

          <Panel id="plan" title="Plan View" action={<button type="button" onClick={() => void runTask()} disabled={!selectedTask || Boolean(operation)}><Play size={15} /> Run simulation</button>}>
            {currentSubtasks.length ? (
              <div className="plan-list">
                {currentSubtasks.map((subtask, index) => (
                  <article className="plan-item" key={subtask.id}>
                    <div className="step-index">{index + 1}</div>
                    <div>
                      <h3>{subtask.title}</h3>
                      <p>{subtask.assignedAgentType} - {subtask.expectedChange}</p>
                      <div className="chip-row">
                        <Badge value={subtask.selectedModelClass} />
                        <span className="mini-chip">{formatEuro(subtask.budgetLimitEuro)}</span>
                        <span className="mini-chip">{subtask.validationCommands.length} validation command(s)</span>
                      </div>
                      <FileList title="Allowed files" files={subtask.allowedFiles} compact />
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState title="No plan yet" text="Run analysis, then create a plan to see file-scoped subtasks and model classes." />
            )}
          </Panel>

          <Panel id="runs" title="Run And Validation" action={<div className="panel-actions"><button type="button" onClick={() => void validateTask()} disabled={!selectedTask || Boolean(operation)}><TestTube2 size={15} /> Plan checks</button><button type="button" onClick={() => void reviewTask()} disabled={!selectedTask || Boolean(operation)}><ShieldCheck size={15} /> Review</button></div>}>
            <div className="run-grid">
              <RunTile icon={<FileSearch size={18} />} label="Context snapshot" value={currentContext ? `${currentContext.relevantFiles.length} files / ${currentContext.tokenEstimate} tokens` : 'none'} />
              <RunTile icon={<GitBranch size={18} />} label="Latest diff" value={selectedTaskRuns[0]?.diffSummary ?? runResult?.runs[0]?.diffSummary ?? 'none'} />
              <RunTile icon={<TestTube2 size={18} />} label="Validation" value={validation?.commands.join(', ') || selectedTaskRuns[0]?.validationStatus || 'not planned'} />
              <RunTile icon={<AlertTriangle size={18} />} label="Escalation" value={selectedTask?.securitySensitive ? 'human approval required' : 'policy-gated'} />
            </div>
            <div className="table compact-table">
              <div className="table-head run-table">
                <span>Agent</span>
                <span>Model</span>
                <span>Provider</span>
                <span>Cost</span>
                <span>Status</span>
              </div>
              {(runResult?.runs ?? selectedTaskRuns).map((run) => (
                <div className="table-row run-table" key={run.id}>
                  <span><strong>{run.agentName}</strong></span>
                  <span><Badge value={run.selectedModelClass} /></span>
                  <span>{run.provider?.name ?? 'unassigned'}</span>
                  <span>{formatEuro(run.estimatedCostEuro)}</span>
                  <span><Status value={run.status} /></span>
                </div>
              ))}
            </div>
            {validation && (
              <div className="validation-list">
                {validation.results.map((result) => (
                  <article key={result.command}>
                    <strong>{result.command}</strong>
                    <Status value={result.status} />
                    <p>{result.outputSummary}</p>
                  </article>
                ))}
              </div>
            )}
          </Panel>

          <Panel id="models" title="Model Marketplace" action={<button type="button" onClick={() => void refreshAll('manual')}><RefreshCw size={15} /> Reload</button>}>
            <div className="market-list">
              {models.map((model) => (
                <div className="market-row" key={model.id}>
                  <div>
                    <strong>{model.name}</strong>
                    <span>{model.providerType} - {model.notes ?? 'No notes'}</span>
                  </div>
                  <Badge value={model.modelClass} />
                  <span>{model.contextWindow ? `${model.contextWindow.toLocaleString()} ctx` : 'unknown ctx'}</span>
                  <span>{priceLabel(model)}</span>
                  <Status value={model.enabled ? 'enabled' : 'disabled'} />
                  <div className="row-actions">
                    <button type="button" onClick={() => void toggleModel(model)} disabled={Boolean(operation)} title={model.enabled ? 'Disable model' : 'Enable model'}>
                      {model.enabled ? <ToggleRight size={17} /> : <ToggleLeft size={17} />}
                    </button>
                    <button type="button" onClick={() => void testModel(model)} disabled={Boolean(operation)}>
                      Test
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {providerTest && (
              <div className={`provider-result ${providerTest.ok ? 'ok' : 'fail'}`}>
                <strong>{providerTest.ok ? 'Provider test passed' : 'Provider test failed'}</strong>
                <p>{providerTest.message}</p>
                {providerTest.models?.length ? <p>{providerTest.models.join(', ')}</p> : null}
              </div>
            )}
          </Panel>

          <Panel id="costs" title="Cost Breakdown" action={<span className="panel-meta">Persisted AgentRun cost ledger</span>}>
            <div className="cost-layout">
              <div className="donut" aria-label="Cost breakdown chart">
                <span>{formatNumber(costSummary?.totalEstimatedCostEuro ?? 0)}</span>
                <small>EUR total</small>
              </div>
              <div className="breakdown-list">
                {modelClasses.map((modelClass) => (
                  <MetricLine key={modelClass} label={modelLabels[modelClass] ?? modelClass} value={formatEuro(costSummary?.byModelClass?.[modelClass] ?? 0)} tone={modelTone(modelClass)} />
                ))}
                <div className="savings">
                  <ShieldCheck size={16} />
                  Premium is approval-gated and should be used for planning or review, not default implementation.
                </div>
              </div>
            </div>
          </Panel>

          <Panel id="safety" title="Safety Boundaries" action={<span className="panel-meta">MVP guardrails</span>}>
            <div className="safety-grid">
              {[
                'Secret-like files are denied from context.',
                'Provider keys stay server-side through env var names.',
                'Real patch execution is blocked until worktrees and file locks exist.',
                'Auth, payment, security, database migration, and infrastructure changes require human approval.',
              ].map((item) => (
                <article key={item}>
                  <ShieldCheck size={18} />
                  <span>{item}</span>
                </article>
              ))}
            </div>
          </Panel>
        </section>
      </section>
    </main>
  )
}

function MetricCard({
  icon,
  label,
  value,
  trend,
  tone,
  series,
  seriesLabel,
}: {
  icon: React.ReactNode
  label: string
  value: string
  trend: string
  tone: 'green' | 'blue' | 'orange' | 'purple'
  series: number[]
  seriesLabel: string
}) {
  return (
    <article className={`metric-card ${tone}`}>
      <div className="metric-head">
        <span>{label}</span>
        <i>{icon}</i>
      </div>
      <strong>{value}</strong>
      <small>{trend}</small>
      <MetricSparkline series={series} label={seriesLabel} />
    </article>
  )
}

function MetricSparkline({ series, label }: { series: number[]; label: string }) {
  const width = 180
  const height = 54
  const paddingX = 3
  const paddingY = 5
  const values = series.length ? series : [0]
  const max = Math.max(...values, 0)
  const min = Math.min(...values, 0)
  const span = max - min || 1
  const step = values.length > 1 ? (width - paddingX * 2) / (values.length - 1) : width - paddingX * 2
  const points = values
    .map((value, index) => {
      const x = paddingX + step * index
      const y = height - paddingY - ((value - min) / span) * (height - paddingY * 2)
      return `${round(x)},${round(y)}`
    })
    .join(' ')
  const firstPoint = points.split(' ')[0] ?? `${paddingX},${height - paddingY}`
  const lastPoint = points.split(' ').at(-1) ?? `${width - paddingX},${height - paddingY}`
  const areaPoints = `${paddingX},${height - paddingY} ${firstPoint} ${points} ${lastPoint} ${width - paddingX},${height - paddingY}`
  const latest = values.at(-1) ?? 0

  return (
    <svg className="metric-sparkline" role="img" aria-label={`${label}. Latest value ${formatNumber(latest)}.`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <polyline className="sparkline-grid upper" points={`0,${paddingY} ${width},${paddingY}`} />
      <polyline className="sparkline-grid lower" points={`0,${height - paddingY} ${width},${height - paddingY}`} />
      <polygon className="sparkline-fill" points={areaPoints} />
      <polyline className="sparkline-line" points={points} />
      <circle className="sparkline-dot" cx={round(width - paddingX)} cy={round(height - paddingY - ((latest - min) / span) * (height - paddingY * 2))} r="2.2" />
    </svg>
  )
}

function Panel({ id, title, action, children }: { id?: string; title: string; action: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="panel" id={id}>
      <header>
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  )
}

function Badge({ value }: { value: string }) {
  return <span className={`badge ${value.replaceAll('_', '-').replaceAll(' ', '-').toLowerCase()}`}>{modelLabels[value] ?? value}</span>
}

function Status({ value }: { value: string }) {
  return <span className={`status ${value.replaceAll(' ', '-').replaceAll('_', '-').toLowerCase()}`}>{value}</span>
}

function MetricLine({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="metric-line">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
    </div>
  )
}

function RunTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <article className="run-tile">
      <i>{icon}</i>
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </article>
  )
}

function FileList({ title, files, compact = false }: { title: string; files: string[]; compact?: boolean }) {
  if (!files.length) return null
  return (
    <div className={`file-list ${compact ? 'compact' : ''}`}>
      <span>{title}</span>
      <div>
        {files.slice(0, compact ? 8 : 18).map((file) => (
          <code key={file}>{file}</code>
        ))}
        {files.length > (compact ? 8 : 18) && <code>+{files.length - (compact ? 8 : 18)} more</code>}
      </div>
    </div>
  )
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  )
}

function buildMetricSeries(tasks: Task[], runs: AgentRun[], days: number) {
  const buckets = createDayBuckets(days)
  const bucketIndexes = new Map(buckets.map((bucket, index) => [bucket, index]))
  const createSeries = () => buckets.map(() => 0)
  const cost = createSeries()
  const completedTasks = createSeries()
  const localRuns = createSeries()
  const freeRuns = createSeries()
  const cheapRuns = createSeries()
  const premiumRuns = createSeries()

  const addToSeries = (series: number[], key: string | null, value = 1) => {
    if (!key) return
    const index = bucketIndexes.get(key)
    if (index === undefined) return
    series[index] = (series[index] ?? 0) + value
  }

  for (const run of runs) {
    const key = dayKey(run.createdAt)
    addToSeries(cost, key, numericValue(run.actualCostEuro ?? run.estimatedCostEuro))
    if (run.selectedModelClass === 'local_llm') addToSeries(localRuns, key)
    if (run.selectedModelClass === 'free_llm') addToSeries(freeRuns, key)
    if (run.selectedModelClass === 'cheap_api_llm') addToSeries(cheapRuns, key)
    if (run.selectedModelClass === 'premium_llm') addToSeries(premiumRuns, key)
  }

  for (const task of tasks) {
    if (task.status === 'completed') addToSeries(completedTasks, dayKey(task.updatedAt))
  }

  return {
    cheapRuns,
    completedTasks,
    cost,
    freeRuns,
    localRuns,
    premiumRuns,
  }
}

function createDayBuckets(days: number): string[] {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today)
    date.setDate(today.getDate() - (days - 1 - index))
    return dayKey(date) ?? ''
  })
}

function dayKey(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function numericValue(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function round(value: number): string {
  return value.toFixed(2)
}

function formatError(error: unknown): string {
  if (error instanceof ApiError) return error.status ? `${error.message} (HTTP ${error.status})` : error.message
  if (error instanceof Error) return error.message
  return String(error)
}

function formatEuro(value: string | number | null | undefined): string {
  const numeric = typeof value === 'string' ? Number(value) : value
  return `${(numeric ?? 0).toFixed(4)} EUR`
}

function formatNumber(value: number): string {
  return value.toFixed(2)
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function percentage(value: number, total: number): number {
  if (!total) return 0
  return Math.round((value / total) * 100)
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function projectName(projectId: string, projects: Project[]): string {
  return projects.find((project) => project.id === projectId)?.name ?? 'Unknown project'
}

function riskTone(value?: string | null): string {
  if (!value) return 'neutral'
  if (['critical', 'high', 'complex'].includes(value)) return 'orange'
  if (['low', 'small', 'trivial'].includes(value)) return 'green'
  return 'blue'
}

function modelTone(modelClass: ModelClass): string {
  if (modelClass === 'local_llm') return 'green'
  if (modelClass === 'free_llm') return 'blue'
  if (modelClass === 'cheap_api_llm') return 'orange'
  if (modelClass === 'premium_llm') return 'purple'
  return 'neutral'
}

function priceLabel(model: ModelProvider): string {
  if (model.modelClass === 'no_llm' || model.modelClass === 'local_llm') return '0 EUR'
  if (model.modelClass === 'free_llm') return model.freeQuotaDaily ? `${model.freeQuotaDaily}/day free` : 'free quota'
  return `${model.costInputPerMillion ?? '?'} / ${model.costOutputPerMillion ?? '?'} per 1M`
}
