// Prints the commit subjects since the last git tag (or the last 50 commits) of the current folder.
// Read-only: runs `git describe` and `git log` only.
import { execFileSync } from 'node:child_process'

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

let range = ['-n', '50']
let since = 'the last 50 commits'
try {
  const tag = git(['describe', '--tags', '--abbrev=0'])
  range = [`${tag}..HEAD`]
  since = `tag ${tag}`
} catch {
  // no tags yet
}
const log = git(['log', '--no-merges', '--pretty=format:%h %s', ...range])
console.log(`Commits since ${since}:`)
console.log(log || '(none)')
