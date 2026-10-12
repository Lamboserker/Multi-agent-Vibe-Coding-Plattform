import type { AnalysisInput, ChatInput, ExecutionInput, PlanningInput, RepoContextDigest, ReviewInput } from './types.js'

export const ORCHESTRATOR_SYSTEM_PROMPT = `You are the lead engineer ("orchestrator") of Multi-AI Coder, a desktop coding IDE.
You coordinate cheaper local coding models. Your own model capacity is expensive: think precisely, answer compactly,
and never write implementation code yourself unless explicitly asked to execute a task.
Rules:
- Base every statement on the repository context given to you. If something is unknown, say so; do not invent files or APIs.
- Prefer small, independently verifiable tasks with explicit acceptance criteria.
- Local models are weaker: give them precise, self-contained instructions, exact file paths and the conventions to follow.
- Security, authentication, payments, data migrations and cross-cutting architecture changes are high risk.
- Respond only with the requested structured output.`

export function renderContext(context: RepoContextDigest, maxChars = 24_000): string {
  const parts = [`## Repository\n${context.summary}`]
  if (context.validationCommands.length) parts.push(`## Validation commands\n${context.validationCommands.map((command) => `- ${command}`).join('\n')}`)
  if (context.relevantFiles.length) {
    parts.push(
      `## Relevant files (outlines)\n${context.relevantFiles
        .map((file) => `### ${file.path}\n${file.outline}${file.excerpt ? `\n\`\`\`\n${file.excerpt}\n\`\`\`` : ''}`)
        .join('\n')}`,
    )
  }
  const text = parts.join('\n\n')
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[context truncated]` : text
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
  return `Decompose the request into an execution plan for a team of coding agents.

# Request
${input.goal}
${input.feedback ? `\n# Feedback from the user on the previous attempt\n${input.feedback}\n` : ''}
# Available local models
${models}

# Planning rules
- Cost mode: ${input.costMode}. ${input.costMode === 'cheapest' ? 'Use premium execution only when a local model would very likely fail.' : input.costMode === 'quality' ? 'Prefer premium execution for anything non-trivial.' : 'Delegate routine work locally; reserve premium for genuinely hard or risky tasks.'}
- At most ${input.maxTasks} tasks. One task = one coherent change a single agent can finish and verify (typically 1-4 files).
- Do not create separate tasks for "run the tests" or "review" – validation and review are done automatically after each task.
- Two tasks must not modify the same file unless one depends on the other.
- "dependsOn" lists ids of tasks that must be integrated first. Keep independent work independent so it can run in parallel.
- "relevantFiles" = existing files the agent must read or edit (exact repo-relative paths from the context). "newFiles" = files to create.
- "description" must be a complete instruction for a weaker model: what to change, where, which conventions/imports to use.
- "suggestedExecutor": "local" for boilerplate, UI components, styling, simple validation, small refactors, docs, test scaffolding;
  "premium" for security-critical logic, complex multi-file refactors, unclear root causes, critical migrations.
- "expectedInputTokens": estimate of the context the agent needs to read.
- "capabilities": e.g. "typescript", "react", "nestjs", "prisma", "css", "testing".

${renderContext(input.context)}`
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
${input.previousFailures ? `\n# Previous attempt failed – fix these problems\n${input.previousFailures}\n` : ''}
# Rules
- Change only what the task requires. Do not reformat unrelated code.
- Do not modify .env files, credentials, CI workflows or lockfiles.
- Do not commit; the engine commits and validates your changes.
- When finished, reply with a short summary, the changed files and any open issues.`
}

export function chatPrompt(input: ChatInput): string {
  const history = (input.history ?? []).slice(-8).map((message) => `${message.role === 'user' ? 'User' : 'You'}: ${message.content}`).join('\n')
  return `Answer the user's question about this repository concisely (markdown allowed). Use the read-only tools only if the context is insufficient.
${history ? `\n# Conversation so far\n${history}\n` : ''}
# Question
${input.question}

${renderContext(input.context, 16_000)}`
}
