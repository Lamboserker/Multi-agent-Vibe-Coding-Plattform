/** Keep planning focused; execution agents can read further files in their worktree. */
export function planningContextOptions(goal: string) {
  const broad = /\b(entire|whole|architecture|migration|migrate|gesamt\w*|komplett\w*|architektur|migrier\w*)\b/i.test(goal)
  return {
    budgetTokens: broad ? 10_000 : 6000,
    maxFiles: broad ? 18 : 10,
    excerptFiles: broad ? 8 : 5,
    excerptChars: 10_000,
    excerptMaxLines: 500,
    fillUnranked: true,
    minRelativeScore: 0.2,
    unrankedManifestsOnly: true,
  }
}
