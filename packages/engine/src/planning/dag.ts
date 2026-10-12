export interface DagNode {
  id: string
  dependsOn: string[]
  /** Files the task is expected to modify or create (used for conflict edges). */
  writes: string[]
  priority?: number
}

export interface DagAnalysis {
  order: string[]
  levels: string[][]
  /** Edges added because two otherwise independent tasks write the same file. */
  conflictEdges: Array<{ from: string; to: string; files: string[] }>
  removedEdges: Array<{ from: string; to: string; reason: string }>
}

export class DagCycleError extends Error {
  constructor(readonly cycle: string[]) {
    super(`Dependency cycle: ${cycle.join(' -> ')}`)
    this.name = 'DagCycleError'
  }
}

/** Finds one cycle (as a node path) or returns undefined. */
export function findCycle(nodes: Map<string, string[]>): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  const visit = (id: string): string[] | undefined => {
    state.set(id, 1)
    stack.push(id)
    for (const dependency of nodes.get(id) ?? []) {
      if (!nodes.has(dependency)) continue
      const current = state.get(dependency) ?? 0
      if (current === 1) return [...stack.slice(stack.indexOf(dependency)), dependency]
      if (current === 0) {
        const cycle = visit(dependency)
        if (cycle) return cycle
      }
    }
    stack.pop()
    state.set(id, 2)
    return undefined
  }
  for (const id of nodes.keys()) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id)
      if (cycle) return cycle
    }
  }
  return undefined
}

function reachable(edges: Map<string, string[]>, from: string, to: string): boolean {
  const seen = new Set<string>()
  const queue = [from]
  while (queue.length) {
    const current = queue.shift()!
    if (current === to) return true
    if (seen.has(current)) continue
    seen.add(current)
    queue.push(...(edges.get(current) ?? []))
  }
  return false
}

/**
 * Normalizes the dependency graph:
 * 1. drops unknown dependencies,
 * 2. breaks cycles deterministically (removing the edge that closes the cycle),
 * 3. serializes tasks that write the same file but have no ordering between them,
 * 4. returns a topological order and parallel levels.
 */
export function analyzeDag(input: DagNode[]): DagAnalysis {
  const ids = new Set(input.map((node) => node.id))
  const edges = new Map<string, string[]>(input.map((node) => [node.id, [...new Set(node.dependsOn.filter((dependency) => ids.has(dependency) && dependency !== node.id))]]))
  const removedEdges: DagAnalysis['removedEdges'] = []

  for (let guard = 0; guard < input.length * input.length + 1; guard += 1) {
    const cycle = findCycle(edges)
    if (!cycle) break
    // remove the last edge of the cycle (closing edge)
    const from = cycle[cycle.length - 2]!
    const to = cycle[cycle.length - 1]!
    edges.set(from, (edges.get(from) ?? []).filter((dependency) => dependency !== to))
    removedEdges.push({ from, to, reason: `cycle ${cycle.join(' -> ')}` })
  }

  const conflictEdges: DagAnalysis['conflictEdges'] = []
  const ordered = [...input].sort((a, b) => input.indexOf(a) - input.indexOf(b))
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const a = ordered[i]!
      const b = ordered[j]!
      const shared = a.writes.filter((file) => b.writes.includes(file))
      if (!shared.length) continue
      // b depends on a (dependency = runs first) unless an ordering already exists
      if (reachable(edges, b.id, a.id) || reachable(edges, a.id, b.id)) continue
      edges.set(b.id, [...(edges.get(b.id) ?? []), a.id])
      conflictEdges.push({ from: b.id, to: a.id, files: shared })
    }
  }

  // Kahn's algorithm with priority (higher first), then input order.
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const [id, dependencies] of edges) {
    indegree.set(id, dependencies.length)
    for (const dependency of dependencies) dependents.set(dependency, [...(dependents.get(dependency) ?? []), id])
  }
  const priority = new Map(input.map((node, index) => [node.id, [node.priority ?? 0, -index] as const]))
  const compare = (a: string, b: string) => {
    const [pa, ia] = priority.get(a)!
    const [pb, ib] = priority.get(b)!
    return pb - pa || ib - ia
  }
  const order: string[] = []
  const levels: string[][] = []
  let frontier = [...edges.keys()].filter((id) => indegree.get(id) === 0).sort(compare)
  while (frontier.length) {
    levels.push(frontier)
    const next: string[] = []
    for (const id of frontier) {
      order.push(id)
      for (const dependent of dependents.get(id) ?? []) {
        const remaining = (indegree.get(dependent) ?? 0) - 1
        indegree.set(dependent, remaining)
        if (remaining === 0) next.push(dependent)
      }
    }
    frontier = next.sort(compare)
  }
  if (order.length !== edges.size) {
    const cycle = findCycle(edges) ?? [...edges.keys()].filter((id) => !order.includes(id))
    throw new DagCycleError(cycle)
  }

  // write normalized dependencies back
  for (const node of input) node.dependsOn = edges.get(node.id) ?? []
  return { order, levels, conflictEdges, removedEdges }
}

/** All transitive dependents of a node (used to cancel/skip downstream work after a failure). */
export function transitiveDependents(nodes: DagNode[], id: string): string[] {
  const result = new Set<string>()
  const queue = [id]
  while (queue.length) {
    const current = queue.shift()!
    for (const node of nodes) {
      if (node.dependsOn.includes(current) && !result.has(node.id)) {
        result.add(node.id)
        queue.push(node.id)
      }
    }
  }
  return [...result]
}
