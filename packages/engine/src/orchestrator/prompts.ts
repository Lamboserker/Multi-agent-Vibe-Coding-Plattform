import type { AnalysisInput, ChatInput, ExecutionInput, ExecutionPlan, PlanningInput, RepairHint, RepairHintInput, RepoContextDigest, ReviewInput } from './types.js'

export const ORCHESTRATOR_SYSTEM_PROMPT = `You are the lead engineer ("orchestrator") of Multi-AI Coder, a desktop coding IDE.
You coordinate cheaper local coding models. Your own model capacity is expensive: think precisely, answer compactly,
and never write implementation code yourself unless explicitly asked to execute a task.
Rules:
- Base every statement on the repository context given to you. If something is unknown, say so; do not invent files or APIs.
- Prefer small, independently verifiable tasks with explicit acceptance criteria.
- Decompose finely so small local models can solve each task and several agents can work in parallel: one task = one file, or one component, page or documentation file including its test. Bundle only trivial edits of the same file. Plan a setup task first when the work needs new dependencies or configuration. Give independent tasks no dependency, so they run in parallel.
- Local models are weaker: give them precise, self-contained instructions, exact file paths and the conventions to follow.
- Security, authentication, payments, data migrations and destructive data operations are high risk; cross-cutting architecture changes are high complexity.
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
  const design = input.design
  const designSection = design
    ? `\n# Design draft (approved by the user)
Summary: ${clip(design.summary, 400)}
Direction: ${clip(design.direction, 300)}
Type: ${design.designType}
Tokens (defined in design/tokens.css): ${design.tokens.map((token) => token.name).join(', ') || '(none)'}
Components:
${design.components.map((component) => `- ${component.name} (${component.file || 'file: choose'}): ${clip(component.purpose, 160)} — ${clip(component.spec, 300)}`).join('\n') || '- (none)'}
Screens:
${design.screens.map((screen) => `- ${screen.name} (${screen.route}): ${clip(screen.layout, 200)}; components: ${screen.components.join(', ') || '(none)'}`).join('\n') || '- (none)'}
`
    : ''
  const designRules = design
    ? `
- Design rules (an approved design draft is given above):
  - A deterministic task already writes design/tokens.css, design/DESIGN.md and design/mockup.html before your tasks run; do not plan tasks for these files.
  - First plan one task that imports design/tokens.css into the project's global stylesheet or entry file (one existing file, or in an empty repository the entry file created by the setup task), and a second task for the app shell/layout (separate from the import task).
  - Then plan one task per design component, named after the component, in the component's file; use the exact component names; each task references only tokens via var(--…).
  - If there are more components than tasks allowed, group closely related small components into one task: at most 2 new files per task, and at most one existing file per local task.
  - Finally compose the screens (a screen task that edits a file of the shell depends on the shell task) and add loading/empty/error states.`
    : ''
  return `Decompose the request into an execution plan for a team of coding agents.

# Request
${input.goal}
${input.feedback ? `\n# Feedback from the user on the previous attempt\n${input.feedback}\n` : ''}${designSection}
# Available local models
${models}
${agentCatalog}${skillCatalog}
# Planning rules
- Cost mode: ${input.costMode}. ${input.costMode === 'cheapest' ? 'Use premium execution only when a local model would very likely fail.' : input.costMode === 'quality' ? 'Use premium execution for work that cannot be made precise enough for a local model (unclear root cause, security, cross-cutting design decisions); decompose everything else into precise local tasks.' : 'Delegate routine work locally; reserve premium for genuinely hard or risky tasks.'}
- At most ${input.maxTasks} tasks. One task = one file (or one component, page or documentation file with its test) that a single
  agent can finish and verify. Bundle only trivial edits of the same file. Only if there are more files than tasks allowed, group
  the smallest files of one kind.
- Never return zero tasks without questions: if the request truly cannot be planned, return no tasks and put concrete questions
  into "analysis.openQuestions".
- Local models are small, so every "local" task is narrow: it edits at most ONE existing source file (plus its own test file) and/or creates a few small new files
  (ideally one, at most three). Its description lists the concrete content: for an edit, which element/function/selector and what to
  replace with what (e.g. the exact class or API mapping); for a new file, its exports, props, imports, CSS classes and the markup or
  data to write. Never just restate the overall goal. Only "premium" tasks may edit several existing files at once.
- New projects, empty or nearly empty repositories and requests for a basic structure ("Grundstruktur", scaffold) are no reason for
  premium: plan a local setup task first (package.json with the exact scripts and dependency versions, framework config such as
  vite.config, index.html, the entry file), then one local task per file or per component/page with its test – style files and
  documentation files (README, docs/*.md) alike – each depending on the setup task${agents.length ? ' and each with the fitting agent from "Available agents"' : ''}.
  Use premium only for genuinely hard logic within it.
- Large conversions (a CSS framework, a library, a language feature across the project): first one setup task (dependencies, configuration,
  global entry), then one task per file that depends on it.${designRules}
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
- Never name a model or executor in "title" or "description" (e.g. "with devstral"): the executor is chosen later from
  "suggestedExecutor" and the agent would otherwise try to call that model itself.
- "complexity" (score each task, not the whole request):
  1–2 = one file with a clear "old → new" instruction;
  3 = a new component plus its test, or one file with non-trivial logic;
  4 = several existing files must change together;
  5 = architecture or cross-cutting change.
  Splitting work into precise one-file tasks keeps their complexity at 1–3.
- "risk": 4–5 only for authentication/security, data migrations, destructive data operations (deleting or overwriting
  stored data) and payment; 3 for changes to shared logic other tasks rely on; otherwise 1–2. UI and styling tasks are risk 1–2.
- "suggestedExecutor": "local" for boilerplate, UI components, styling, simple validation, small refactors, docs, test scaffolding;
  "premium" only for tasks with complexity 4–5 that cannot be split further into precise local tasks (e.g. complex multi-file
  refactors, unclear root causes). High-risk work reaches premium through its "risk" score anyway.
- "expectedInputTokens": estimate of the context the agent needs to read.
- "capabilities": e.g. "typescript", "react", "nestjs", "prisma", "css", "testing".
${catalogRules}
- Plan from the repository context below. Read files only to resolve a concrete doubt (a few targeted reads at most);
  do not explore the repository broadly – the executing agents read the files themselves. Answer quickly.

${renderContext(input.context, 80_000)}`
}

function truncated(text: string, maxChars: number, what: string): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[${what} truncated, ${text.length - maxChars} chars omitted]` : text
}

/** A proposal of one orchestrator as compact JSON for a reconcile prompt (ids kept, so dependencies stay readable). */
function planJson(plan: ExecutionPlan, maxChars: number): string {
  return truncated(JSON.stringify(plan, null, 1), maxChars, 'plan')
}

/**
 * Duo mode: the lead merges both orchestrators' plans. The full planning prompt is repeated so every
 * planning rule (one file per local task, "old → new" lines, scoring rubric, task limit) applies to the result.
 */
export function reconcilePlanPrompt(input: PlanningInput, proposals: Array<{ label: string; plan: ExecutionPlan }>, maxPlanChars = 30_000): string {
  const sections = proposals.map((proposal, index) => `## Proposal ${String.fromCharCode(65 + index)} (${proposal.label})\n\`\`\`json\n${planJson(proposal.plan, maxPlanChars)}\n\`\`\``).join('\n\n')
  return `${planningPrompt(input)}

# Two independent proposals for this plan
Two lead engineers planned this request independently. Merge their proposals into ONE plan that follows every planning
rule above; the result goes into "plan".

${sections}

# Reconciliation rules
- Take the best tasks of both proposals. Drop duplicates (the same file or the same work); keep the more precise
  description with the concrete "old → new" lines.
- Where the proposals cut the same work differently, prefer the finer decomposition (more, smaller one-file tasks) as long
  as the plan stays within ${input.maxTasks} tasks.
- Prefer "local": a task one proposal marks "premium" and the other "local" stays "local" when its description is precise
  enough for a small model; keep "premium" only for work that cannot be made that precise.
- Assign fresh ids and keep "dependsOn" consistent with them; independent tasks stay independent.
- Keep a task that only one proposal has when it is needed for the request; never drop work the request asks for.
- "analysis.openQuestions": only questions neither proposal can answer. "warnings": those of both that still apply.
- "notes": 1–5 short sentences in German for the user: what was taken from which proposal and why.
- Do not read files: everything you need is above. Return only the structured output.`
}

/** Duo mode: two premium executions passed the same checks; the lead picks the better change. */
export function chooseExecutionPrompt(input: { taskId: string; title: string; instructions: string; acceptanceCriteria: string[] }, candidates: Array<{ label: string; diff: string; summary: string; validation: string }>, maxDiffChars = 20_000): string {
  const sections = candidates
    .map((candidate, index) => `## Change ${String.fromCharCode(65 + index)} (${candidate.label})
Summary: ${clip(candidate.summary, 600) || '(none)'}
Validation: ${clip(candidate.validation, 400) || '(none)'}
\`\`\`diff
${truncated(candidate.diff, maxDiffChars, 'diff')}
\`\`\``)
    .join('\n\n')
  return `Two engineers implemented the same task in separate worktrees. Both changes passed the same automated checks.
Pick the change that fulfils the task better: correct and complete, consistent with the codebase, no unnecessary changes.

# Task ${input.taskId}: ${input.title}
${input.instructions}

# Acceptance criteria
${input.acceptanceCriteria.length ? input.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n') : '- The change compiles and fulfils the task.'}

${sections}

# Rules for your answer
- "winner": "A" or "B". "reason": one or two sentences in German (shown to the user).
- Judge only the diffs above; do not read files.`
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

/**
 * "Premium advises, local executes": the orchestrator diagnoses a failed local attempt and returns exact
 * "old → new" edits that the strongest local model then applies. No implementation by the orchestrator.
 */
export function repairHintPrompt(input: RepairHintInput, maxDiffChars = 20_000, maxFailureChars = 6_000): string {
  const diff = input.diff.length > maxDiffChars ? `${input.diff.slice(0, maxDiffChars)}\n[diff truncated, ${input.diff.length - maxDiffChars} chars omitted]` : input.diff
  const failures = input.failures.length > maxFailureChars ? `${input.failures.slice(0, maxFailureChars)}\n[output truncated]` : input.failures
  return `A small local coding model attempted the task below and failed. Do NOT implement the task yourself and do not
modify files. Diagnose the failure and give precise repair instructions that the local model will apply literally.

# Task ${input.taskId}: ${input.title}
${input.instructions}

# Acceptance criteria
${input.acceptanceCriteria.length ? input.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n') : '- The change compiles and fulfils the task.'}

# Files of the task
${input.files.length ? input.files.map((file) => `- ${file}`).join('\n') : '- (none listed)'}

# Diff of the failed attempt (already applied in the working directory)
${diff.trim() ? `\`\`\`diff\n${diff}\n\`\`\`` : '(the attempt wrote no files)'}

# Failure (checks or rejection reason)
${failures.trim() || '(no output)'}

# Rules for your answer
- "diagnosis": the root cause in one or two sentences, in German (it is shown to the user).
- "edits": the smallest set of "old → new" edits that fixes the failure, applied to the files as they are now (base + diff above).
  - "file": exact repo-relative path of a file of the task or of a file in the same folder (the local model cannot write elsewhere).
  - "find": text copied exactly from the current file (whitespace included), long enough to be unique in it;
    "" only for a file that does not exist yet (then "replace" is its complete content).
  - "replace": the exact new text. "note": a short reason for the edit.
  - Prefer several small edits over one large block; at most 12 edits.
- "confidence": "high" if you are sure the edits fix the failure, "medium" if they probably do, "low" if the root cause is
  unclear or a few precise edits cannot repair the task (then "edits" may be empty; the task goes to premium execution).
- Read files only to copy exact "find" text or to confirm the root cause (a few targeted reads at most).`
}

/** The orchestrator's repair hint as "old → new" instructions for the local repair round. */
export function renderRepairHint(hint: RepairHint, failures = ''): string {
  const edits = hint.edits.map((edit, index) => {
    const header = `${index + 1}. ${edit.file}${edit.note ? ` – ${edit.note}` : ''}`
    return edit.find
      ? `${header}\nold:\n\`\`\`\n${edit.find}\n\`\`\`\nnew:\n\`\`\`\n${edit.replace}\n\`\`\``
      : `${header}\nCreate the file with exactly this content:\n\`\`\`\n${edit.replace}\n\`\`\``
  })
  return `The lead engineer reviewed your previous attempt (its changes are still in the files).
Diagnosis: ${hint.diagnosis || '(none)'}
Apply exactly these edits, in this order, and nothing else. Replace each "old" text with the "new" text; if an "old" text is not
found verbatim, read the file and apply the same change to the matching lines. Then finish.

${edits.join('\n\n')}${failures.trim() ? `\n\n# Failure of the previous attempt\n${failures.slice(0, 3000)}` : ''}`
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
