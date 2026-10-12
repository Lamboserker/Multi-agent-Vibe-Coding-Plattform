'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { FormEvent, KeyboardEvent, ReactNode, RefObject, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  CircleDollarSign,
  Code2,
  Cpu,
  FileCode2,
  FolderPlus,
  GitCompare,
  History,
  LayoutDashboard,
  ListChecks,
  Loader2,
  MessageSquare,
  RefreshCw,
  Route,
  RotateCcw,
  Send,
  Settings,
  ShieldCheck,
  TerminalSquare,
  XCircle,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { API_BASE_URL, ApiError, apiRequest } from '@/lib/api'
import { LogoutButton } from './logout-button'
import { ThemeToggle } from './theme-toggle'

type ModelClass = 'no_llm' | 'local_llm' | 'free_llm' | 'cheap_api_llm' | 'premium_llm'
type CostMode = 'cheapest' | 'balanced' | 'quality'
type ExecutionMode = 'confirm' | 'auto'
type WorkspaceView = 'chat' | 'projects' | 'tasks' | 'plan' | 'runs' | 'models' | 'costs' | 'safety' | 'settings'

interface Project {
  id: string
  name: string
  repoPath: string
  packageManager?: string | null
}

interface ChatMessage {
  id: string
  taskId?: string | null
  projectId: string
  role: 'user' | 'assistant' | 'agent' | 'system'
  content: string
  createdAt: string
}

interface TaskPlan {
  id: string
  taskId: string
  summary: string
  estimatedCostEuro: string | number
  requiresApproval: boolean
  nextAction: string
  createdAt: string
}

interface Task {
  id: string
  projectId: string
  project?: Project
  userPrompt: string
  normalizedGoal?: string | null
  status: string
  mode?: string
  premiumAllowed?: boolean
  currentStep?: string
  maxCostEuro?: string | number | null
  lastRunId?: string | null
  createdAt: string
  updatedAt: string
  subtasks?: Subtask[]
  runs?: AgentRun[]
  feedback?: RunFeedback[]
  chatMessages?: ChatMessage[]
  plans?: TaskPlan[]
  contexts?: ContextSnapshot[]
}

interface ContextSnapshot {
  id: string
  taskId: string
  projectId: string
  summary: string
  relevantFiles: string[]
  tokenEstimate: number
  createdAt: string
}

interface Subtask {
  id: string
  taskId: string
  title: string
  goal: string
  status: string
  assignedAgentType: string
  selectedModelClass: ModelClass
  selectedProviderId?: string | null
  selectedModelName?: string | null
  modelReason?: string | null
  skippedModels?: string[]
  estimatedCostEuro?: string | number | null
  allowedFiles: string[]
  validationCommands: string[]
}

interface AgentRun {
  id: string
  taskId: string
  subtaskId?: string | null
  subtask?: Subtask | null
  agentName: string
  selectedModelClass: ModelClass
  selectedModelName?: string | null
  provider?: ModelProvider | null
  status: string
  startedAt?: string | null
  finishedAt?: string | null
  logs?: unknown
  currentStep?: string
  estimatedCostEuro: string | number
  actualCostEuro?: string | number | null
  diffSummary?: string | null
  validationStatus: string
  validationResults?: unknown
  patchStatus?: string
  errorMessage?: string | null
}

interface ModelProvider {
  id: string
  name: string
  modelClass: ModelClass
  providerType: string
  enabled: boolean
}

interface RunFeedback {
  id: string
  taskId: string
  runId?: string | null
  userFeedback: string
  requestedAction?: string | null
  createdAt: string
}

interface WorkspaceChatResult {
  task: Task
  messages: ChatMessage[]
}

const defaultRepoPath = 'D:\\Programmieren\\Multi-Agent-Vibe-Coding-Plattform'
const modelClasses: ModelClass[] = ['no_llm', 'local_llm', 'free_llm', 'cheap_api_llm', 'premium_llm']
const quickActions = [
  'Fix errors',
  'Improve UI',
  'Reduce complexity',
  'Add tests',
  'Use cheaper model',
  'Use stronger model',
  'Restrict to selected files',
  'Continue from last run',
]
const defaultQuickAction = 'Fix errors'

const sidebarItems: Array<{ Icon: LucideIcon; href: string; label: string; view?: WorkspaceView }> = [
  { Icon: MessageSquare, href: '/workspace', label: 'Chat', view: 'chat' },
  { Icon: LayoutDashboard, href: '/dashboard', label: 'Dashboard' },
  { Icon: LayoutDashboard, href: '/projects', label: 'Projects', view: 'projects' },
  { Icon: ListChecks, href: '/tasks', label: 'Tasks', view: 'tasks' },
  { Icon: Route, href: '/plan', label: 'Plan', view: 'plan' },
  { Icon: History, href: '/runs', label: 'Runs', view: 'runs' },
  { Icon: Cpu, href: '/models', label: 'Models', view: 'models' },
  { Icon: CircleDollarSign, href: '/costs', label: 'Costs', view: 'costs' },
  { Icon: ShieldCheck, href: '/safety', label: 'Safety', view: 'safety' },
  { Icon: Settings, href: '/settings', label: 'Settings', view: 'settings' },
]

export function WorkspaceCockpit({ view = 'chat' }: { view?: WorkspaceView }) {
  const pathname = usePathname()
  const [projects, setProjects] = useState<Project[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [models, setModels] = useState<ModelProvider[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const [taskDetail, setTaskDetail] = useState<Task | null>(null)
  const [operation, setOperation] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [projectForm, setProjectForm] = useState({ name: 'Multi-Agent-Vibe-Coding-Plattform', repoPath: defaultRepoPath })
  const [linkProjectOpen, setLinkProjectOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [costMode, setCostMode] = useState<CostMode>('balanced')
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('confirm')
  const [maxCostEuro, setMaxCostEuro] = useState('0.50')
  const [premiumAllowed, setPremiumAllowed] = useState(false)
  const [allowedModelClasses, setAllowedModelClasses] = useState(new Set<ModelClass>(modelClasses))
  const [feedback, setFeedback] = useState({ requestedAction: defaultQuickAction, userFeedback: '' })
  const chatEndRef = useRef<HTMLDivElement>(null)

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0]
  const selectedTask =
    (taskDetail?.id === selectedTaskId ? taskDetail : null) ?? tasks.find((task) => task.id === selectedTaskId) ?? null
  const subtasks = selectedTask?.subtasks ?? []
  const runs = selectedTask?.runs ?? []
  const latestRun = runs[0]
  const consoleLines = runs.flatMap((run) => normalizeLogs(run.logs, run))
  const totalEstimated = selectedTask?.plans?.[0]?.estimatedCostEuro ?? subtasks.reduce((sum, subtask) => sum + numeric(subtask.estimatedCostEuro), 0)
  const changedFiles = useMemo(() => {
    const files = new Set<string>()
    subtasks.forEach((subtask) => subtask.allowedFiles.slice(0, 12).forEach((file) => files.add(file)))
    return [...files]
  }, [subtasks])
  const messages = selectedTask?.chatMessages ?? []
  const projectTasks = selectedProject ? tasks.filter((task) => task.projectId === selectedProject.id).slice(0, 6) : tasks.slice(0, 6)
  const activeModelCount = models.filter((model) => model.enabled).length
  const taskTitle = selectedTask?.normalizedGoal ?? selectedTask?.userPrompt ?? 'New workspace task'
  const taskStatus = operation ? 'running' : selectedTask?.status ?? 'ready'

  useEffect(() => {
    void refreshAll()
  }, [])

  useEffect(() => {
    if (!selectedProjectId && projects[0]) setSelectedProjectId(projects[0].id)
  }, [projects, selectedProjectId])

  useEffect(() => {
    if (!selectedTaskId && tasks[0]) setSelectedTaskId(tasks[0].id)
  }, [tasks, selectedTaskId])

  useEffect(() => {
    if (selectedTaskId) void loadTask(selectedTaskId)
  }, [selectedTaskId])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, operation])

  async function refreshAll() {
    setError(null)
    try {
      const [projectData, taskData, modelData] = await Promise.all([
        apiRequest<Project[]>('/projects'),
        apiRequest<Task[]>('/tasks'),
        apiRequest<ModelProvider[]>('/models'),
      ])
      setProjects(projectData)
      setTasks(taskData)
      setModels(modelData)
    } catch (requestError) {
      setError(formatError(requestError))
    }
  }

  async function loadTask(taskId: string) {
    try {
      const data = await apiRequest<Task>(`/tasks/${taskId}`)
      setTaskDetail(data)
      setCostMode((data.mode as CostMode) ?? 'balanced')
      setPremiumAllowed(Boolean(data.premiumAllowed))
    } catch (requestError) {
      setError(formatError(requestError))
    }
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await runOperation('Linking project', async () => {
      const project = await apiRequest<Project>('/projects/link', {
        method: 'POST',
        body: JSON.stringify(projectForm),
      })
      setSelectedProjectId(project.id)
      setLinkProjectOpen(false)
      setNotice('Project linked and ready for chat tasks.')
      await refreshAll()
    })
  }

  async function submitChat(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    const content = chatInput.trim()
    const projectId = selectedProjectId || selectedProject?.id
    if (!content || !projectId) {
      setError(projectId ? 'Enter a task message first.' : 'Create or select a project before chatting.')
      return
    }

    await runOperation(executionMode === 'auto' ? 'Planning and running' : 'Planning from chat', async () => {
      setChatInput('')
      const result = await apiRequest<WorkspaceChatResult>('/workspace/chat', {
        method: 'POST',
        body: JSON.stringify({
          projectId,
          taskId: selectedTaskId || undefined,
          content,
          costMode,
          maxCostEuro: Number(maxCostEuro || 0),
          premiumAllowed,
          allowedModelClasses: [...allowedModelClasses],
          autoRun: executionMode === 'auto',
        }),
      })
      setSelectedTaskId(result.task.id)
      setTaskDetail(result.task)
      setNotice(executionMode === 'auto' ? 'Chat task planned and dry-run executed.' : 'Plan is ready in chat.')
      await refreshAll()
    })
  }

  function handleChatKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submitChat()
    }
  }

  async function retryFailed() {
    if (!selectedTask) return
    await runOperation('Retrying failed work', async () => {
      await apiRequest(`/tasks/${selectedTask.id}/retry`, { method: 'POST' })
      setNotice('Retry run persisted.')
      await loadTask(selectedTask.id)
    })
  }

  async function applyPatch() {
    if (!selectedTask) return
    await runOperation('Applying patch', async () => {
      const result = await apiRequest<{ ok: boolean; status: string }>(`/tasks/${selectedTask.id}/apply`, { method: 'POST' })
      setNotice(`Apply result: ${result.status}.`)
      await loadTask(selectedTask.id)
    })
  }

  async function discard() {
    if (!selectedTask) return
    await runOperation('Discarding artifacts', async () => {
      await apiRequest(`/tasks/${selectedTask.id}/discard`, { method: 'POST' })
      setNotice('Run artifacts discarded.')
      await loadTask(selectedTask.id)
    })
  }

  async function submitFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedTask) return
    await runOperation('Saving feedback', async () => {
      await apiRequest(`/tasks/${selectedTask.id}/feedback`, {
        method: 'POST',
        body: JSON.stringify({
          runId: latestRun?.id,
          requestedAction: feedback.requestedAction,
          userFeedback: feedback.userFeedback || feedback.requestedAction,
        }),
      })
      setFeedback({ requestedAction: defaultQuickAction, userFeedback: '' })
      setNotice('Feedback saved for a follow-up run.')
      await loadTask(selectedTask.id)
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

  function updateAllowed(modelClass: ModelClass, allowed: boolean) {
    setAllowedModelClasses((current) => {
      const next = new Set(current)
      if (allowed) next.add(modelClass)
      else next.delete(modelClass)
      return next
    })
  }

  return (
    <main className={`workspace-shell ${view === 'chat' ? 'chat-route' : 'section-route'}`}>
      <aside className="workspace-sidebar">
        <div className="workspace-brand">
          <Code2 size={25} />
          <div>
            <strong>Multi-AI Coder</strong>
            <span>AI Coding Cockpit</span>
          </div>
        </div>

        <nav className="workspace-nav-rail" aria-label="Workspace navigation">
          {sidebarItems.map(({ Icon, href, label }) => (
            <Link className={pathname === href ? 'active' : ''} href={href} key={href}>
              <Icon size={17} /> {label}
            </Link>
          ))}
        </nav>

        <section className="sidebar-block">
          <div className="sidebar-block-head">
            <span>Projects</span>
            <button type="button" onClick={() => setLinkProjectOpen(!linkProjectOpen)} title="Link project">
              <FolderPlus size={15} />
            </button>
          </div>
          <div className="sidebar-list">
            {projects.length ? (
              projects.map((project) => (
                <button
                  className={`sidebar-row ${project.id === selectedProject?.id ? 'selected' : ''}`}
                  key={project.id}
                  type="button"
                  onClick={() => setSelectedProjectId(project.id)}
                >
                  <span>
                    <strong>{project.name}</strong>
                    <small>{project.packageManager ?? 'main'}</small>
                  </span>
                  <i className="state-dot online" />
                </button>
              ))
            ) : (
              <p className="sidebar-empty">No projects linked.</p>
            )}
          </div>
        </section>

        <section className="sidebar-block">
          <div className="sidebar-block-head">
            <span>Tasks</span>
            <small>{projectTasks.length}</small>
          </div>
          <div className="sidebar-list">
            {projectTasks.length ? (
              projectTasks.map((task) => (
                <button
                  className={`sidebar-row task ${task.id === selectedTask?.id ? 'selected' : ''}`}
                  key={task.id}
                  type="button"
                  onClick={() => setSelectedTaskId(task.id)}
                >
                  <span>
                    <strong>{task.normalizedGoal ?? task.userPrompt}</strong>
                    <small>#{task.id.slice(0, 8)}</small>
                  </span>
                  <Status value={task.status} />
                </button>
              ))
            ) : (
              <p className="sidebar-empty">No tasks for this project.</p>
            )}
          </div>
        </section>

        <div className="workspace-api">
          <span className={error ? 'api-dot offline' : 'api-dot online'} />
          <div>
            <strong>{error ? 'API attention' : 'API connected'}</strong>
            <small>{API_BASE_URL}</small>
          </div>
        </div>
      </aside>

      <section className={`workspace-main ${view === 'chat' ? 'chat-first' : 'section-first'}`}>
        <header className="workspace-command-bar">
          <div className="command-project">
            <GitCompare size={18} />
            <span>
              <strong>{selectedProject?.name ?? 'No project selected'}</strong>
              <small>{selectedProject?.repoPath ?? defaultRepoPath}</small>
            </span>
          </div>
          <div className="command-task">
            <ListChecks size={18} />
            <span>
              <strong>{taskTitle}</strong>
              <small>{selectedTask ? `#${selectedTask.id.slice(0, 8)} / ${selectedTask.currentStep ?? 'waiting'}` : 'Start a new chat task'}</small>
            </span>
          </div>
          <div className="command-status">
            <Status value={taskStatus} />
            <span>{formatEuro(totalEstimated)}</span>
            <small>{activeModelCount} models enabled</small>
          </div>
          <div className="workspace-header-actions">
            <ThemeToggle />
            <button type="button" onClick={() => void refreshAll()} disabled={Boolean(operation)}>
              <RefreshCw size={16} /> Refresh
            </button>
            <LogoutButton disabled={Boolean(operation)} />
          </div>
        </header>

        {(notice || error || operation) && (
          <div className={`workspace-notice ${error ? 'error' : ''}`}>
            {operation ? <Loader2 className="spin" size={16} /> : error ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
            {operation ?? error ?? notice}
          </div>
        )}

        {view === 'chat' ? (
          <section className="workspace-chat-layout">
            <WorkspaceChat
              messages={messages}
              operation={operation}
              selectedTask={selectedTask}
              subtasks={subtasks}
              chatInput={chatInput}
              setChatInput={setChatInput}
              onSubmit={(event) => void submitChat(event)}
              onKeyDown={handleChatKeyDown}
              disabled={Boolean(operation) || projects.length === 0}
              chatEndRef={chatEndRef}
            />

            <aside className="workspace-inspector-column">
              <TaskInspector
                projects={projects}
                selectedProjectId={selectedProjectId}
                setSelectedProjectId={setSelectedProjectId}
                projectForm={projectForm}
                setProjectForm={setProjectForm}
                createProject={createProject}
                linkProjectOpen={linkProjectOpen}
                setLinkProjectOpen={setLinkProjectOpen}
                selectedTask={selectedTask}
                tasks={tasks}
                setSelectedTaskId={setSelectedTaskId}
                costMode={costMode}
                setCostMode={setCostMode}
                executionMode={executionMode}
                setExecutionMode={setExecutionMode}
                maxCostEuro={maxCostEuro}
                setMaxCostEuro={setMaxCostEuro}
                premiumAllowed={premiumAllowed}
                setPremiumAllowed={setPremiumAllowed}
                allowedModelClasses={allowedModelClasses}
                updateAllowed={updateAllowed}
                subtasks={subtasks}
                totalEstimated={totalEstimated}
                operation={operation}
              />
            </aside>
          </section>
        ) : (
          <WorkspaceSectionView
            view={view}
            projects={projects}
            tasks={tasks}
            models={models}
            selectedProject={selectedProject}
            selectedProjectId={selectedProjectId}
            setSelectedProjectId={setSelectedProjectId}
            selectedTask={selectedTask}
            setSelectedTaskId={setSelectedTaskId}
            projectForm={projectForm}
            setProjectForm={setProjectForm}
            createProject={createProject}
            linkProjectOpen={linkProjectOpen}
            setLinkProjectOpen={setLinkProjectOpen}
            costMode={costMode}
            setCostMode={setCostMode}
            executionMode={executionMode}
            setExecutionMode={setExecutionMode}
            maxCostEuro={maxCostEuro}
            setMaxCostEuro={setMaxCostEuro}
            premiumAllowed={premiumAllowed}
            setPremiumAllowed={setPremiumAllowed}
            allowedModelClasses={allowedModelClasses}
            updateAllowed={updateAllowed}
            subtasks={subtasks}
            runs={runs}
            consoleLines={consoleLines}
            changedFiles={changedFiles}
            totalEstimated={totalEstimated}
            operation={operation}
            retryFailed={retryFailed}
            applyPatch={applyPatch}
            discard={discard}
            feedback={feedback}
            setFeedback={setFeedback}
            submitFeedback={submitFeedback}
          />
        )}
      </section>
    </main>
  )
}

function WorkspaceSectionView(props: {
  view: Exclude<WorkspaceView, 'chat'>
  projects: Project[]
  tasks: Task[]
  models: ModelProvider[]
  selectedProject?: Project
  selectedProjectId: string
  setSelectedProjectId: (value: string) => void
  selectedTask: Task | null
  setSelectedTaskId: (value: string) => void
  projectForm: { name: string; repoPath: string }
  setProjectForm: (value: { name: string; repoPath: string }) => void
  createProject: (event: FormEvent<HTMLFormElement>) => void
  linkProjectOpen: boolean
  setLinkProjectOpen: (value: boolean) => void
  costMode: CostMode
  setCostMode: (value: CostMode) => void
  executionMode: ExecutionMode
  setExecutionMode: (value: ExecutionMode) => void
  maxCostEuro: string
  setMaxCostEuro: (value: string) => void
  premiumAllowed: boolean
  setPremiumAllowed: (value: boolean) => void
  allowedModelClasses: Set<ModelClass>
  updateAllowed: (modelClass: ModelClass, allowed: boolean) => void
  subtasks: Subtask[]
  runs: AgentRun[]
  consoleLines: string[]
  changedFiles: string[]
  totalEstimated: string | number | null | undefined
  operation: string | null
  retryFailed: () => Promise<void>
  applyPatch: () => Promise<void>
  discard: () => Promise<void>
  feedback: { requestedAction: string; userFeedback: string }
  setFeedback: (value: { requestedAction: string; userFeedback: string }) => void
  submitFeedback: (event: FormEvent<HTMLFormElement>) => void
}) {
  const pageMeta: Record<Exclude<WorkspaceView, 'chat'>, { title: string; text: string }> = {
    projects: {
      title: 'Projects',
      text: 'Link repositories, switch active workspaces, and keep local project context separate from chat execution.',
    },
    tasks: {
      title: 'Tasks',
      text: 'Inspect current task state, select task history, and review generated subtasks without crowding the chat.',
    },
    plan: {
      title: 'Plan',
      text: 'Review decomposition, model routing, approval requirements, and planned validation before execution.',
    },
    runs: {
      title: 'Runs',
      text: 'Follow agent logs, validation output, changed files, patch status, retry, apply, discard, and feedback.',
    },
    models: {
      title: 'Models',
      text: 'Audit enabled providers and model classes used by the routing policy.',
    },
    costs: {
      title: 'Costs',
      text: 'Keep the selected task budget, estimated spend, and allowed model classes visible.',
    },
    safety: {
      title: 'Safety',
      text: 'Guardrails for approvals, secret handling, validation, and patch review boundaries.',
    },
    settings: {
      title: 'Settings',
      text: 'Control workspace theme, execution mode, premium access, cost ceiling, and project linking defaults.',
    },
  }
  const meta = pageMeta[props.view]

  return (
    <section className="workspace-page">
      <header className="workspace-page-header">
        <div>
          <h1>{meta.title}</h1>
          <p>{meta.text}</p>
        </div>
        <Link className="page-primary-link" href="/workspace">
          <MessageSquare size={16} /> Open chat
        </Link>
      </header>

      {props.view === 'projects' && (
        <div className="workspace-page-grid two">
          <Panel id="projects" title="Linked Projects" icon={<LayoutDashboard size={18} />}>
            <div className="section-list">
              {props.projects.length ? (
                props.projects.map((project) => (
                  <button
                    className={`section-row ${project.id === props.selectedProject?.id ? 'selected' : ''}`}
                    key={project.id}
                    type="button"
                    onClick={() => props.setSelectedProjectId(project.id)}
                  >
                    <span>
                      <strong>{project.name}</strong>
                      <small>{project.repoPath}</small>
                    </span>
                    <Badge value={project.packageManager ?? 'local'} />
                  </button>
                ))
              ) : (
                <EmptyState title="No projects linked" text="Link a local repository to enable planning and model routing." />
              )}
            </div>
          </Panel>

          <Panel title="Link Project" icon={<FolderPlus size={18} />}>
            <form className="project-create-stack standalone" onSubmit={props.createProject}>
              <label>
                <span>Project Name</span>
                <input value={props.projectForm.name} onChange={(event) => props.setProjectForm({ ...props.projectForm, name: event.target.value })} />
              </label>
              <label>
                <span>Repository Path</span>
                <input value={props.projectForm.repoPath} onChange={(event) => props.setProjectForm({ ...props.projectForm, repoPath: event.target.value })} />
              </label>
              <button type="submit" disabled={Boolean(props.operation)}>
                <FolderPlus size={16} /> Link project
              </button>
            </form>
          </Panel>
        </div>
      )}

      {props.view === 'tasks' && (
        <div className="workspace-page-grid two">
          <Panel id="tasks" title="Task Queue" icon={<ListChecks size={18} />}>
            <div className="section-list">
              {props.tasks.length ? (
                props.tasks.map((task) => (
                  <button
                    className={`section-row ${task.id === props.selectedTask?.id ? 'selected' : ''}`}
                    key={task.id}
                    type="button"
                    onClick={() => props.setSelectedTaskId(task.id)}
                  >
                    <span>
                      <strong>{task.normalizedGoal ?? task.userPrompt}</strong>
                      <small>#{task.id.slice(0, 8)} / {task.currentStep ?? 'waiting'}</small>
                    </span>
                    <Status value={task.status} />
                  </button>
                ))
              ) : (
                <EmptyState title="No tasks yet" text="Create the next task from the chat page." />
              )}
            </div>
          </Panel>

          <Panel title="Selected Task" icon={<ShieldCheck size={18} />}>
            <div className="current-task standalone">
              <strong>{props.selectedTask?.normalizedGoal ?? props.selectedTask?.userPrompt ?? 'No active task yet'}</strong>
              <div className="task-meta">
                <Status value={props.selectedTask?.status ?? 'draft'} />
                <span>{props.selectedTask?.currentStep ?? 'waiting'}</span>
                <span>{formatEuro(props.totalEstimated)}</span>
              </div>
            </div>
            <div className="inspector-subtasks">
              {props.subtasks.length ? (
                props.subtasks.map((subtask) => (
                  <article key={subtask.id}>
                    <div>
                      <strong>{subtask.title}</strong>
                      <Status value={subtask.status} />
                    </div>
                    <p>{subtask.goal}</p>
                    <div>
                      <Badge value={subtask.selectedModelClass} />
                      <span>{formatEuro(subtask.estimatedCostEuro)}</span>
                    </div>
                  </article>
                ))
              ) : (
                <EmptyState title="No subtasks" text="Task planning has not produced subtasks yet." />
              )}
            </div>
          </Panel>
        </div>
      )}

      {props.view === 'plan' && (
        <div className="workspace-page-grid two">
          <Panel title="Plan Summary" icon={<Route size={18} />}>
            <div className="plan-list">
              {props.selectedTask?.plans?.length ? (
                props.selectedTask.plans.map((plan) => (
                  <article className="plan-item" key={plan.id}>
                    <div className="step-index">{plan.requiresApproval ? '!' : 'OK'}</div>
                    <div>
                      <h3>{plan.summary}</h3>
                      <p>{plan.nextAction}</p>
                      <div className="chip-row">
                        <span className="mini-chip">{formatEuro(plan.estimatedCostEuro)}</span>
                        <Status value={plan.requiresApproval ? 'approval only' : 'planned'} />
                      </div>
                    </div>
                  </article>
                ))
              ) : (
                <EmptyState title="No plan yet" text="Use chat to create or update the current task plan." />
              )}
            </div>
          </Panel>

          <Panel title="Model Assignment" icon={<Cpu size={18} />}>
            <div className="inspector-subtasks">
              {props.subtasks.length ? (
                props.subtasks.map((subtask) => (
                  <article key={subtask.id}>
                    <div>
                      <strong>{subtask.assignedAgentType}</strong>
                      <Badge value={subtask.selectedModelClass} />
                    </div>
                    <p>{subtask.modelReason ?? subtask.goal}</p>
                  </article>
                ))
              ) : (
                <EmptyState title="No assignments" text="Model routing appears after task planning." />
              )}
            </div>
          </Panel>
        </div>
      )}

      {props.view === 'runs' && (
        <div className="workspace-page-grid two">
          <RunConsole consoleLines={props.consoleLines} runs={props.runs} />
          <PatchReview
            runs={props.runs}
            changedFiles={props.changedFiles}
            selectedTask={props.selectedTask}
            operation={props.operation}
            retryFailed={props.retryFailed}
            applyPatch={props.applyPatch}
            discard={props.discard}
            feedback={props.feedback}
            setFeedback={props.setFeedback}
            submitFeedback={props.submitFeedback}
          />
        </div>
      )}

      {props.view === 'models' && (
        <div className="workspace-page-grid">
          <Panel id="models" title="Model Providers" icon={<Cpu size={18} />}>
            <div className="market-list">
              {props.models.length ? (
                props.models.map((model) => (
                  <div className="market-row" key={model.id}>
                    <div>
                      <strong>{model.name}</strong>
                      <span>{model.providerType}</span>
                    </div>
                    <Badge value={model.modelClass} />
                    <Status value={model.enabled ? 'enabled' : 'disabled'} />
                  </div>
                ))
              ) : (
                <EmptyState title="No models loaded" text="Model provider data will appear when the API responds." />
              )}
            </div>
          </Panel>
        </div>
      )}

      {props.view === 'costs' && (
        <div className="workspace-page-grid two">
          <Panel id="costs" title="Cost Policy" icon={<CircleDollarSign size={18} />}>
            <div className="cost-matrix">
              <article>
                <span>Selected Task Estimate</span>
                <strong>{formatEuro(props.totalEstimated)}</strong>
              </article>
              <article>
                <span>Cost Limit</span>
                <strong>{Number(props.maxCostEuro || 0).toFixed(2)} EUR</strong>
              </article>
              <article>
                <span>Premium</span>
                <strong>{props.premiumAllowed ? 'Allowed' : 'Blocked'}</strong>
              </article>
            </div>
          </Panel>

          <Panel title="Allowed Model Classes" icon={<Cpu size={18} />}>
            <div className="model-class-strip compact standalone">
              {modelClasses.map((modelClass) => (
                <label key={modelClass}>
                  <input type="checkbox" checked={props.allowedModelClasses.has(modelClass)} onChange={(event) => props.updateAllowed(modelClass, event.target.checked)} />
                  <Badge value={modelClass} />
                </label>
              ))}
            </div>
          </Panel>
        </div>
      )}

      {props.view === 'safety' && (
        <div className="workspace-page-grid">
          <Panel id="safety" title="Safety Boundaries" icon={<ShieldCheck size={18} />}>
            <div className="safety-grid">
              {[
                'Secret-like files stay out of agent context.',
                'Provider credentials remain server-side through environment variables.',
                'Patch application is a separate review action, not part of chat submission.',
                'Premium, security-sensitive, database, auth, payment, and infrastructure work remains approval gated.',
              ].map((item) => (
                <article key={item}>
                  <ShieldCheck size={18} />
                  <span>{item}</span>
                </article>
              ))}
            </div>
          </Panel>
        </div>
      )}

      {props.view === 'settings' && (
        <div className="workspace-page-grid two">
          <Panel id="settings" title="Run Policy" icon={<Settings size={18} />}>
            <RunPolicyControls
              costMode={props.costMode}
              setCostMode={props.setCostMode}
              executionMode={props.executionMode}
              setExecutionMode={props.setExecutionMode}
              maxCostEuro={props.maxCostEuro}
              setMaxCostEuro={props.setMaxCostEuro}
              premiumAllowed={props.premiumAllowed}
              setPremiumAllowed={props.setPremiumAllowed}
              allowedModelClasses={props.allowedModelClasses}
              updateAllowed={props.updateAllowed}
            />
          </Panel>

          <Panel title="Interface" icon={<Settings size={18} />}>
            <div className="settings-stack">
              <ThemeToggle />
              <button type="button" onClick={() => props.setLinkProjectOpen(!props.linkProjectOpen)}>
                <FolderPlus size={16} /> {props.linkProjectOpen ? 'Hide project form' : 'Show project form'}
              </button>
              {props.linkProjectOpen ? (
                <form className="project-create-stack standalone" onSubmit={props.createProject}>
                  <label>
                    <span>Project Name</span>
                    <input value={props.projectForm.name} onChange={(event) => props.setProjectForm({ ...props.projectForm, name: event.target.value })} />
                  </label>
                  <label>
                    <span>Repository Path</span>
                    <input value={props.projectForm.repoPath} onChange={(event) => props.setProjectForm({ ...props.projectForm, repoPath: event.target.value })} />
                  </label>
                  <button type="submit" disabled={Boolean(props.operation)}>
                    <FolderPlus size={16} /> Link project
                  </button>
                </form>
              ) : null}
            </div>
          </Panel>
        </div>
      )}
    </section>
  )
}

function WorkspaceChat(props: {
  messages: ChatMessage[]
  operation: string | null
  selectedTask: Task | null
  subtasks: Subtask[]
  chatInput: string
  setChatInput: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  disabled: boolean
  chatEndRef: RefObject<HTMLDivElement | null>
}) {
  return (
    <section className="workspace-chat-panel">
      <header>
        <h2><MessageSquare size={18} /> Workspace Chat</h2>
        <div className="chat-agent-strip">
          <span>{props.subtasks.length || 0} agents active</span>
          <i className={props.operation ? 'state-dot running' : 'state-dot online'} />
        </div>
      </header>
      <div className="task-focus-row">
        <span>Task</span>
        <strong>{props.selectedTask?.normalizedGoal ?? props.selectedTask?.userPrompt ?? 'Describe the change you want to make.'}</strong>
      </div>
      <div className="chat-transcript">
        {props.messages.length === 0 ? (
          <div className="chat-empty">
            <Bot size={22} />
            <strong>What should the agents work on?</strong>
            <p>The next message creates a task, analyzes scope and risk, assigns models, and returns a plan here.</p>
          </div>
        ) : (
          props.messages.map((message) => <ChatBubble message={message} key={message.id} />)
        )}
        {props.operation ? (
          <div className="chat-bubble assistant">
            <div className="chat-avatar"><Loader2 className="spin" size={15} /></div>
            <div className="chat-copy">{props.operation}...</div>
          </div>
        ) : null}
        <div ref={props.chatEndRef} />
      </div>
      <form className="workspace-chat-input" onSubmit={props.onSubmit}>
        <div className="context-strip">
          <span>@ context</span>
          <span>&lt;/&gt; code</span>
          <span>files attached</span>
          <small>Enter to send</small>
        </div>
        <div className="chat-compose-row">
          <textarea
            value={props.chatInput}
            onChange={(event) => props.setChatInput(event.target.value)}
            onKeyDown={props.onKeyDown}
            placeholder="Build a chat-first workspace cockpit that plans, routes models, estimates cost, and waits for approval..."
            disabled={props.disabled}
          />
          <button type="submit" disabled={props.disabled || !props.chatInput.trim()} title="Send message">
            <Send size={18} />
          </button>
        </div>
      </form>
    </section>
  )
}

function ChatBubble({ message }: { message: ChatMessage }) {
  return (
    <article className={`chat-bubble ${message.role}`}>
      <div className="chat-avatar">{message.role === 'user' ? 'U' : message.role === 'agent' ? <Bot size={15} /> : 'AI'}</div>
      <div className="chat-copy">
        <span>{message.role}</span>
        <p>{message.content}</p>
        <small>{formatTime(message.createdAt)}</small>
      </div>
    </article>
  )
}

function RunPolicyControls(props: {
  costMode: CostMode
  setCostMode: (value: CostMode) => void
  executionMode: ExecutionMode
  setExecutionMode: (value: ExecutionMode) => void
  maxCostEuro: string
  setMaxCostEuro: (value: string) => void
  premiumAllowed: boolean
  setPremiumAllowed: (value: boolean) => void
  allowedModelClasses: Set<ModelClass>
  updateAllowed: (modelClass: ModelClass, allowed: boolean) => void
}) {
  return (
    <>
      <div className="inspector-settings">
        <label>
          <span>Mode</span>
          <select value={props.costMode} onChange={(event) => props.setCostMode(event.target.value as CostMode)}>
            <option value="cheapest">cheapest</option>
            <option value="balanced">balanced</option>
            <option value="quality">quality</option>
          </select>
        </label>
        <span id="costs" className="scroll-anchor" />
        <label>
          <span>Cost Limit</span>
          <input type="number" step="0.01" min="0" value={props.maxCostEuro} onChange={(event) => props.setMaxCostEuro(event.target.value)} />
        </label>
      </div>
      <div className="segmented-control">
        <button className={props.executionMode === 'confirm' ? 'active' : ''} type="button" onClick={() => props.setExecutionMode('confirm')}>Confirm</button>
        <button className={props.executionMode === 'auto' ? 'active' : ''} type="button" onClick={() => props.setExecutionMode('auto')}>Auto dry-run</button>
      </div>
      <label className="premium-switch">
        <input type="checkbox" checked={props.premiumAllowed} onChange={(event) => props.setPremiumAllowed(event.target.checked)} />
        Premium allowed
      </label>
      <div className="model-class-strip compact">
        {modelClasses.map((modelClass) => (
          <label key={modelClass}>
            <input type="checkbox" checked={props.allowedModelClasses.has(modelClass)} onChange={(event) => props.updateAllowed(modelClass, event.target.checked)} />
            <Badge value={modelClass} />
          </label>
        ))}
      </div>
    </>
  )
}

function TaskInspector(props: {
  projects: Project[]
  selectedProjectId: string
  setSelectedProjectId: (value: string) => void
  projectForm: { name: string; repoPath: string }
  setProjectForm: (value: { name: string; repoPath: string }) => void
  createProject: (event: FormEvent<HTMLFormElement>) => void
  linkProjectOpen: boolean
  setLinkProjectOpen: (value: boolean) => void
  selectedTask: Task | null
  tasks: Task[]
  setSelectedTaskId: (value: string) => void
  costMode: CostMode
  setCostMode: (value: CostMode) => void
  executionMode: ExecutionMode
  setExecutionMode: (value: ExecutionMode) => void
  maxCostEuro: string
  setMaxCostEuro: (value: string) => void
  premiumAllowed: boolean
  setPremiumAllowed: (value: boolean) => void
  allowedModelClasses: Set<ModelClass>
  updateAllowed: (modelClass: ModelClass, allowed: boolean) => void
  subtasks: Subtask[]
  totalEstimated: string | number | null | undefined
  operation: string | null
}) {
  const [activeTab, setActiveTab] = useState<'task' | 'context' | 'history'>('task')
  const contexts = props.selectedTask?.contexts ?? []
  const runs = props.selectedTask?.runs ?? []
  const chatMessages = props.selectedTask?.chatMessages ?? []
  const feedback = props.selectedTask?.feedback ?? []
  const latestContext = contexts[0]

  return (
    <>
      <div className="inspector-tabs" aria-label="Inspector sections">
        <button className={activeTab === 'task' ? 'active' : ''} type="button" onClick={() => setActiveTab('task')} aria-selected={activeTab === 'task'}>Task</button>
        <button className={activeTab === 'context' ? 'active' : ''} type="button" onClick={() => setActiveTab('context')} aria-selected={activeTab === 'context'}>Context</button>
        <button className={activeTab === 'history' ? 'active' : ''} type="button" onClick={() => setActiveTab('history')} aria-selected={activeTab === 'history'}>History</button>
      </div>

      {activeTab === 'task' && (
        <>
          <Panel id="tasks" title="TaskInspector" icon={<ListChecks size={18} />}>
            <span id="projects" className="scroll-anchor" />
            {props.projects.length > 0 ? (
              <div className="inspector-settings">
                <label>
                  <span>Selected Project</span>
                  <select value={props.selectedProjectId} onChange={(event) => props.setSelectedProjectId(event.target.value)}>
                    {props.projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
                  </select>
                </label>
                <label>
                  <span>Current Task</span>
                  <select value={props.selectedTask?.id ?? ''} onChange={(event) => props.setSelectedTaskId(event.target.value)}>
                    <option value="">New chat task</option>
                    {props.tasks.map((task) => <option value={task.id} key={task.id}>{task.normalizedGoal ?? task.userPrompt.slice(0, 80)}</option>)}
                  </select>
                </label>
                <button className="link-project-button" type="button" onClick={() => props.setLinkProjectOpen(!props.linkProjectOpen)}>
                  <FolderPlus size={16} /> Link project
                </button>
              </div>
            ) : null}

            {props.projects.length === 0 || props.linkProjectOpen ? (
              <form className="project-create-stack" onSubmit={props.createProject}>
                <div className="link-project-header">
                  <strong>Link local project</strong>
                  {props.projects.length > 0 ? (
                    <button type="button" onClick={() => props.setLinkProjectOpen(false)}>Cancel</button>
                  ) : null}
                </div>
                <label>
                  <span>Project Name</span>
                  <input value={props.projectForm.name} onChange={(event) => props.setProjectForm({ ...props.projectForm, name: event.target.value })} />
                </label>
                <label>
                  <span>Repository Path</span>
                  <input value={props.projectForm.repoPath} onChange={(event) => props.setProjectForm({ ...props.projectForm, repoPath: event.target.value })} />
                </label>
                <button type="submit" disabled={Boolean(props.operation)}>
                  <FolderPlus size={16} /> Link project
                </button>
              </form>
            ) : null}

            <div className="current-task">
              <strong>{props.selectedTask?.normalizedGoal ?? props.selectedTask?.userPrompt ?? 'No active task yet'}</strong>
              <div className="task-meta">
                <Status value={props.selectedTask?.status ?? 'draft'} />
                <span>{props.selectedTask?.currentStep ?? 'waiting'}</span>
                <span>{formatEuro(props.totalEstimated)}</span>
              </div>
            </div>
          </Panel>

          <Panel id="settings" title="Run Policy" icon={<ShieldCheck size={18} />}>
            <RunPolicyControls
              costMode={props.costMode}
              setCostMode={props.setCostMode}
              executionMode={props.executionMode}
              setExecutionMode={props.setExecutionMode}
              maxCostEuro={props.maxCostEuro}
              setMaxCostEuro={props.setMaxCostEuro}
              premiumAllowed={props.premiumAllowed}
              setPremiumAllowed={props.setPremiumAllowed}
              allowedModelClasses={props.allowedModelClasses}
              updateAllowed={props.updateAllowed}
            />
          </Panel>

          <Panel id="models" title="Subtasks & Models" icon={<Cpu size={18} />}>
            {props.subtasks.length === 0 ? (
              <EmptyState title="No subtasks yet" text="The next chat submit will generate subtasks and assignments." />
            ) : (
              <div className="inspector-subtasks">
                {props.subtasks.map((subtask) => (
                  <article key={subtask.id}>
                    <div>
                      <strong>{subtask.title}</strong>
                      <Status value={subtask.status} />
                    </div>
                    <p>{subtask.assignedAgentType}</p>
                    <div>
                      <Badge value={subtask.selectedModelClass} />
                      <span>{formatEuro(subtask.estimatedCostEuro)}</span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Panel>
        </>
      )}

      {activeTab === 'context' && (
        <>
          <Panel id="context" title="ContextSnapshot" icon={<FileCode2 size={18} />}>
            {latestContext ? (
              <div className="inspector-context">
                <div className="context-stats">
                  <span>{latestContext.tokenEstimate.toLocaleString()} tokens</span>
                  <span>{latestContext.relevantFiles.length} files</span>
                  <span>{formatTime(latestContext.createdAt)}</span>
                </div>
                <pre>{latestContext.summary}</pre>
              </div>
            ) : (
              <EmptyState title="No context snapshot" text="Analyze or submit a chat task to build repository context." />
            )}
          </Panel>

          <Panel title="Relevant Files" icon={<FileCode2 size={18} />}>
            {latestContext?.relevantFiles.length ? (
              <div className="context-file-list">
                {latestContext.relevantFiles.map((file) => <code key={file}>{file}</code>)}
              </div>
            ) : (
              <EmptyState title="No files selected" text="Context files appear after analysis." />
            )}
          </Panel>
        </>
      )}

      {activeTab === 'history' && (
        <>
          <Panel id="history" title="Task History" icon={<History size={18} />}>
            <div className="history-timeline">
              {chatMessages.length ? chatMessages.map((message) => (
                <article key={message.id}>
                  <div>
                    <Badge value={message.role} />
                    <span>{formatTime(message.createdAt)}</span>
                  </div>
                  <p>{message.content}</p>
                </article>
              )) : <EmptyState title="No chat history" text="Messages for the selected task will appear here." />}
            </div>
          </Panel>

          <Panel title="Runs & Feedback" icon={<TerminalSquare size={18} />}>
            <div className="history-timeline compact">
              {runs.length ? runs.map((run) => (
                <article key={run.id}>
                  <div>
                    <strong>{run.agentName}</strong>
                    <Status value={run.status} />
                  </div>
                  <p>{run.selectedModelName ?? run.selectedModelClass} / {run.currentStep ?? 'queued'} / {formatEuro(run.estimatedCostEuro)}</p>
                </article>
              )) : null}
              {feedback.length ? feedback.map((item) => (
                <article key={item.id}>
                  <div>
                    <strong>{item.requestedAction ?? 'Feedback'}</strong>
                    <span>{formatTime(item.createdAt)}</span>
                  </div>
                  <p>{item.userFeedback}</p>
                </article>
              )) : null}
              {!runs.length && !feedback.length ? <EmptyState title="No run history" text="Dry-runs and saved feedback will appear here." /> : null}
            </div>
          </Panel>
        </>
      )}
    </>
  )
}

function RunConsole({ consoleLines, runs }: { consoleLines: string[]; runs: AgentRun[] }) {
  return (
    <Panel id="runs" title="RunConsole" icon={<TerminalSquare size={18} />}>
      <div className="workbench-tabs">
        <button className="active" type="button">Run console</button>
        <button type="button">Validation</button>
      </div>
      <div className="console">
        {consoleLines.length ? consoleLines.map((line, index) => <code key={`${line}-${index}`}>{line}</code>) : <code>No run logs yet.</code>}
      </div>
      <div className="validation-summary">
        {runs.length ? runs.map((run) => (
          <span key={run.id}><Status value={run.validationStatus} /> {run.agentName}</span>
        )) : <span>Validation results will appear after a dry-run.</span>}
      </div>
    </Panel>
  )
}

function PatchReview(props: {
  runs: AgentRun[]
  changedFiles: string[]
  selectedTask: Task | null
  operation: string | null
  retryFailed: () => Promise<void>
  applyPatch: () => Promise<void>
  discard: () => Promise<void>
  feedback: { requestedAction: string; userFeedback: string }
  setFeedback: (value: { requestedAction: string; userFeedback: string }) => void
  submitFeedback: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <Panel title="PatchReview" icon={<GitCompare size={18} />}>
      <div className="workbench-tabs">
        <button className="active" type="button">Patch review</button>
        <button type="button">Changed files ({props.changedFiles.length})</button>
        <button type="button">Feedback</button>
      </div>
      <div className="patch-actions">
        <button type="button" onClick={() => void props.retryFailed()} disabled={Boolean(props.operation) || !props.selectedTask}><RotateCcw size={16} /> Retry</button>
        <button type="button" onClick={() => void props.applyPatch()} disabled={Boolean(props.operation) || !props.selectedTask}><FileCode2 size={16} /> Apply</button>
        <button type="button" onClick={() => void props.discard()} disabled={Boolean(props.operation) || !props.selectedTask}><XCircle size={16} /> Discard</button>
      </div>
      <div className="changed-files">
        {props.changedFiles.length ? props.changedFiles.map((file) => <code key={file}>{file}</code>) : <code>No changed files or patch artifacts yet.</code>}
      </div>
      <div className="run-artifacts">
        {props.runs.length ? props.runs.map((run) => (
          <article key={run.id}>
            <div>
              <strong>{run.subtask?.title ?? run.agentName}</strong>
              <Status value={run.patchStatus ?? 'no_patch_artifact'} />
            </div>
            <p>{run.diffSummary ?? 'No diff summary persisted.'}</p>
            <div className="validation-results">
              {normalizeValidation(run.validationResults).map((item) => (
                <code key={`${run.id}-${item.command}`}>{item.command}: {item.status}</code>
              ))}
            </div>
          </article>
        )) : <EmptyState title="No review artifacts" text="Dry-run agents persist logs, validation status, and patch safety state here." />}
      </div>
      <form className="feedback-form compact" onSubmit={props.submitFeedback}>
        <select value={props.feedback.requestedAction} onChange={(event) => props.setFeedback({ ...props.feedback, requestedAction: event.target.value })}>
          {quickActions.map((action) => <option value={action} key={action}>{action}</option>)}
        </select>
        <textarea placeholder="Follow-up feedback for the next chat turn" value={props.feedback.userFeedback} onChange={(event) => props.setFeedback({ ...props.feedback, userFeedback: event.target.value })} />
        <button type="submit" disabled={!props.selectedTask || Boolean(props.operation)}>Save feedback</button>
      </form>
    </Panel>
  )
}

function Panel({ id, title, icon, children }: { id?: string; title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="workspace-panel" id={id}>
      <header>
        <h2>{icon}{title}</h2>
      </header>
      {children}
    </section>
  )
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="workspace-empty">
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  )
}

function Badge({ value }: { value: string }) {
  return <span className={`badge ${value.replaceAll('_', '-').toLowerCase()}`}>{value}</span>
}

function Status({ value }: { value: string }) {
  return <span className={`status ${value.replaceAll('_', '-').replaceAll(' ', '-').toLowerCase()}`}>{value}</span>
}

function formatError(error: unknown): string {
  if (error instanceof ApiError) return error.status ? `${error.message} (HTTP ${error.status})` : error.message
  if (error instanceof Error) return error.message
  return String(error)
}

function numeric(value: string | number | null | undefined): number {
  return typeof value === 'string' ? Number(value) : value ?? 0
}

function formatEuro(value: string | number | null | undefined): string {
  return `${numeric(value).toFixed(4)} EUR`
}

function normalizeLogs(logs: unknown, run: AgentRun): string[] {
  if (Array.isArray(logs)) return logs.map(String)
  return [`Run ${run.id}: ${run.status} (${run.currentStep ?? 'unknown step'})`]
}

function normalizeValidation(value: unknown): Array<{ command: string; status: string }> {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const candidate = item as { command?: unknown; status?: unknown }
      return { command: String(candidate.command ?? 'validation'), status: String(candidate.status ?? 'unknown') }
    })
    .filter((item): item is { command: string; status: string } => Boolean(item))
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
}
