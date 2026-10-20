import type { AnalysisInput, ChatInput, ExecutionInput, PlanningInput, RepoContextDigest, ReviewInput } from './types.js'

export const ORCHESTRATOR_SYSTEM_PROMPT = `You are the lead engineer ("orchestrator") of Multi-AI Coder, a desktop coding IDE.
You coordinate cheaper local coding models. Your own model capacity is expensive: think precisely, answer compactly,
and never write implementation code yourself unless explicitly asked to execute a task.
Rules:
- Base every statement on the repository context given to you. If something is unknown, say so; do not invent files or APIs.
- Prefer small, independently verifiable tasks with explicit acceptance criteria.
- Minimize time to a validated change: keep a small cohesive change in ONE task, including its tests. Split only for independent work or real complexity; each task costs a model call, worktree and validation.
- Local models are weaker: give them precise, self-contained instructions, exact file paths and the conventions to follow.
- Security, authentication, payments, data migrations and cross-cutting architecture changes are high risk.
- Respond only with the requested structured output.`

export function renderContext(context: RepoContextDigest, maxChars = 24_000): string {
  const parts = [`## Repository\n${context.summary}`]
  if (context.validationCommands.length) parts.push(`## Validation commands\n${context.validationCommands.map((command) => `- ${command}`).join('\n')}`)
  if (context.relevantFiles.length) {
    parts.push(
      `## Relevant files (outlines)\n${context.relevantFiles
        .map((file) => `### ${file.path}${file.complete ? ' (complete content below – no need to read it)' : ''}\n${file.outline}${file.excerpt ? `\n\`\`\`\n${file.excerpt}\n\`\`\`` : ''}`)
        .join('\n')}`,
    )
  }
  const text = parts.join('\n\n')
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[context truncated]` : text
}

function clip(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1).trimEnd()}…` : flat
}

export function analysisPrompt(input: AnalysisInput): string {
  return `Analyse this coding request against the repository. Rate complexity and risk from 1 (trivial/none) to 5 (critical).

# Request
${input.goal}

${renderContext(input.context)}`
}

export function planningPrompt(input: PlanningInput): string {
  const models = input.localModels.length
    ? input.localModels.map((model) => `- ${model.role}: ${model.model}${model.toolCalling ? ' (tool calling)' : ' (structured file output only)'}${model.strengths.length ? ` — strengths: ${model.strengths.join(', ')}` : ''}`).join('\n')
    : '- none installed (every task will need premium execution or will be blocked)'
  // bounded so a large agent/skill setup cannot crowd out the repository context
  const agents = (input.agents ?? []).slice(0, 20)
  const skills = (input.skills ?? []).slice(0, 40)
  const agentCatalog = agents.length
    ? `\n# Available agents\n${agents.map((agent) => `- ${agent.name}: ${clip(agent.description, 200)}${agent.categories.length ? ` — categories: ${agent.categories.slice(0, 12).join(', ')}` : ''}${agent.skills.length ? ` — skills: ${agent.skills.slice(0, 12).join(', ')}` : ''}`).join('\n')}\n`
    : ''
  const skillCatalog = skills.length
    ? `\n# Available skills\n${skills.map((skill) => `- ${skill.name}${skill.requested ? ' (requested by the user)' : ''}: ${clip(skill.description, 200)}`).join('\n')}\n`
    : ''
  const catalogRules = [
    agents.length ? '- "agent": the exact name of one agent from "Available agents" that fits the task best, or "" to let the system choose.' : '- "agent": always "".',
    skills.length
      ? `- "skills": exact names from "Available skills" the executing agent needs for this task (usually 0–2), else [].${skills.some((skill) => skill.requested) ? ' Every skill marked "(requested by the user)" must appear on at least one task.' : ''}
- Skills are instructions for the executing agents. Never apply a skill yourself, never wait for one and never return an empty plan because of one – plan the work and attach the skill to the tasks that need it.`
      : '- "skills": always [].',
  ].join('\n')
  return `Decompose the request into an execution plan for a team of coding agents.

# Request
${input.goal}
${input.feedback ? `\n# Feedback from the user on the previous attempt\n${input.feedback}\n` : ''}
# Available local models
${models}
${agentCatalog}${skillCatalog}
# Planning rules
- Cost mode: ${input.costMode}. ${input.costMode === 'cheapest' ? 'Use premium execution only when a local model would very likely fail.' : input.costMode === 'quality' ? 'Use premium execution for work that cannot be made precise enough for a local model (unclear root cause, security, cross-cutting design decisions); decompose everything else into precise local tasks.' : 'Delegate routine work locally; reserve premium for genuinely hard or risky tasks.'}
- At most ${input.maxTasks} tasks. One task = one coherent change a single agent can finish and verify.
- Local models are small, so every "local" task is narrow: it edits at most ONE existing file and/or creates a few small new files
  (ideally one, at most three). Its description lists the concrete content: for an edit, which element/function/selector and what to
  replace with what (e.g. the exact class or API mapping); for a new file, its exports, props, imports, CSS classes and the markup or
  data to write. Never just restate the overall goal. Only "premium" tasks may edit several existing files at once.
- New projects and empty or nearly empty repositories are no reason for premium: plan a local setup task first (package.json with the
  exact scripts and dependency versions, framework config such as vite.config, index.html, the entry file), then one local task per
  component, page, style file or test, each depending on the setup task. Use premium only for genuinely hard logic within it.
- Large conversions (a CSS framework, a library, a language feature across the project): first one setup task (dependencies, configuration,
  global entry), then one task per file that depends on it. If there are more files than tasks allowed, group the smallest files of one kind.
- Every description must say what replaces removed code; a task must never only delete code.
- Write compactly: a description is at most ~150 words – one sentence of intent, then the concrete edits as short
  "old → new" lines. No prose, no repetition of the goal, no code blocks longer than a few lines.
- The files marked "complete content" below are the full files: do not read them again.
- Return the plan only as the structured output. Do not write it out as text first – that doubles the answer time.
- Do not create separate tasks for "run the tests" or "review" – validation and review are done automatically after each task.
- Two tasks must not modify the same file unless one depends on the other.
- "dependsOn" lists ids of tasks that must be integrated first. Keep independent work independent so it can run in parallel.
- "relevantFiles" = existing files the agent must read or edit (exact repo-relative paths from the context). "newFiles" = files to create.
- "description" must be a complete instruction for a weaker model: what to change, where, which conventions/imports to use.
- "suggestedExecutor": "local" for boilerplate, UI components, styling, simple validation, small refactors, docs, test scaffolding;
  "premium" for security-critical logic, complex multi-file refactors, unclear root causes, critical migrations.
- "expectedInputTokens": estimate of the context the agent needs to read.
- "capabilities": e.g. "typescript", "react", "nestjs", "prisma", "css", "testing".
${catalogRules}
- Plan from the repository context below. Read files only to resolve a concrete doubt (a few targeted reads at most);
  do not explore the repository broadly – the executing agents read the files themselves. Answer quickly.

${renderContext(input.context, 80_000)}`
}

export function reviewPrompt(input: ReviewInput, maxDiffChars = 40_000): string {
  const diff = input.diff.length > maxDiffChars ? `${input.diff.slice(0, maxDiffChars)}\n[diff truncated, ${input.diff.length - maxDiffChars} chars omitted]` : input.diff
  return `Review the integrated result of a multi-agent change set before it is offered to the user.
Judge: does it fulfil the request, is it correct, safe, consistent with the codebase, and free of unnecessary changes?
Blockers are only real defects (bugs, security problems, broken behaviour), not style preferences.

# Request
${input.goal}

# Tasks
${input.tasks.map((task) => `- ${task.id} ${task.title}: ${task.status} by ${task.executor}; tests passed ${task.testsPassed}, failed ${task.testsFailed}`).join('\n')}

# Automated validation
${input.validationSummary}

# Risk flags
${input.riskFlags.length ? input.riskFlags.map((flag) => `- ${flag}`).join('\n') : '- none'}

# Diff
\`\`\`diff
${diff}
\`\`\``
}

export function executionPrompt(input: ExecutionInput): string {
  return `Implement the following task directly in this working directory (an isolated git worktree).

# Task ${input.taskId}: ${input.title}
${input.instructions}

# Acceptance criteria
${input.acceptanceCriteria.length ? input.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n') : '- The change compiles and fulfils the task.'}

# Relevant files
${input.relevantFiles.length ? input.relevantFiles.map((file) => `- ${file}`).join('\n') : '- (find them yourself; keep reads minimal)'}
${input.guidance ? `\n# Guidance (follow it)\n${input.guidance}\n` : ''}${input.previousFailures ? `\n# Previous attempt failed – fix these problems\n${input.previousFailures}\n` : ''}
# Rules
- Change only what the task requires. Do not reformat unrelated code.
- Do not modify .env files, credentials, CI workflows or lockfiles.
- Do not commit; the engine commits and validates your changes.
- When finished, reply with a short summary, the changed files and any open issues.`
}

/** Follow-up in a resumed CLI session: context and earlier turns are already part of the session. */
export function chatFollowUpPrompt(input: ChatInput): string {
  return `Follow-up question in this conversation about the same repository (answer concisely, markdown allowed; use the read-only tools only if needed):

${input.question}`
}

export function chatPrompt(input: ChatInput): string {
  const history = (input.history ?? []).slice(-8).map((message) => `${message.role === 'user' ? 'User' : 'You'}: ${message.content}`).join('\n')
  return `Answer the user's question about this repository concisely (markdown allowed). Use the read-only tools only if the context is insufficient.
${history ? `\n# Conversation so far\n${history}\n` : ''}
# Question
${input.question}

${renderContext(input.context, 16_000)}`
}
