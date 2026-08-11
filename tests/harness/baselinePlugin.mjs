// Serve src/** from a git object instead of the working tree.
//
// WHY THIS EXISTS: this checkout is shared by concurrent sessions. While the harness was being
// built, another session already had src/pages/EventNew.jsx modified — so a run against the working
// tree would silently have measured somebody's in-flight edit and reported it as the baseline. A
// baseline that cannot name its SHA is not a baseline.
//
// Enable with HARNESS_BASELINE_SHA=<full-or-short-sha>. The plugin intercepts the LOAD of any file
// under src/ and returns `git show <sha>:<relpath>`. Because vite still believes the module lives at
// its real path, every relative import inside it resolves exactly as it normally would — no
// specifier rewriting, no alias games, and nothing is written to the working tree (git show is
// read-only).
//
// Paths that do not exist at that SHA fall through to disk, so files added since the SHA (including
// the harness itself) still load.
import { execFileSync } from 'child_process'
import { relative, resolve } from 'path'

export default function baselineFromGit({ sha, repoRoot }) {
  if (!sha) return { name: 'harness-baseline-disabled' }
  const cache = new Map()
  const missing = new Set()
  let resolvedSha = sha
  return {
    name: 'harness-baseline-from-git',
    enforce: 'pre',
    configResolved() {
      resolvedSha = execFileSync('git', ['rev-parse', sha], { cwd: repoRoot, encoding: 'utf8' }).trim()
      // eslint-disable-next-line no-console
      console.log(`[harness] serving src/** from git ${resolvedSha}`)
    },
    load(id) {
      const clean = id.split('?')[0]
      if (!/\.(jsx?|tsx?|css)$/.test(clean)) return null
      const rel = relative(repoRoot, resolve(clean))
      if (rel.startsWith('..') || !rel.startsWith('src/')) return null
      if (missing.has(rel)) return null
      if (cache.has(rel)) return cache.get(rel)
      try {
        const src = execFileSync('git', ['show', `${resolvedSha}:${rel}`], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
        cache.set(rel, src)
        return src
      } catch {
        missing.add(rel)
        return null
      }
    },
  }
}
