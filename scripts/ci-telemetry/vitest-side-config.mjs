// What a config that builds on vitest.config.ts must do by hand when the A3 trial key makes
// the suite two projects: vitest.stress.config.ts and the three flag-off configs. Which file runs in which project
// stays where it is, in ./vitest-node-project.mjs by way of vitest.config.ts; nothing here names a test file, and
// nothing here reads the key: both functions go by whether `test.projects` is there.
// scripts/ci-telemetry/vitest-side-configs.test.js holds the four configs to both shapes.
//
// Two things a spread of `base.test` gets wrong with the key set, both measured on vitest 4.1.11:
//   - `--dir` stops at the root project. vitest hands its projects a fixed list of command-line options
//     (`cliOverrides` in its resolveProjects) and `dir` is not one of them, so `--dir src/__tests__ seed …` collected
//     196 files where the one-project run collects 175: the 21 more were every lambda/ test with "seed" in its path.
//   - a `setupFiles` beside `projects` loads in every project (arrays concatenate under `extends: true`), the node
//     project included, where src/__tests__/setup.ts reads `document` in an afterEach and every test fails.
// Re-read the first on a vitest upgrade: if `dir` joins that list, withCliDir is a no-op that can go.

// The value of `--dir` on the command line that started this process, or undefined. Both spellings cac accepts.
export const cliDir = (argv = process.argv) => {
  for (let at = 0; at < argv.length; at += 1) {
    if (argv[at] === '--dir') return argv[at + 1]
    if (argv[at].startsWith('--dir=')) return argv[at].slice('--dir='.length)
  }
  return undefined
}

// `test` with the command line's `--dir` given to each project, so the two-project run looks for files where the
// one-project run does. Without projects, or without `--dir`, `test` as it came: vitest applies the option itself.
export const withCliDir = (test, dir = cliDir()) =>
  dir && test.projects
    ? { ...test, projects: test.projects.map((project) => ({ ...project, test: { ...project.test, dir } })) }
    : test

// `test` with the setup file `from` replaced by `to` wherever it is listed: at the root in the one-project shape, in
// the project that lists it in the two-project shape. A project that does not list `from` (node: no DOM, no setup
// file) is left alone. Throws when nothing lists `from`, so a moved setup file cannot leave a run without `to`.
export const withSetupReplaced = (test, from, to) => {
  let replaced = 0
  const swap = (block) => {
    if (!block || !Array.isArray(block.setupFiles) || !block.setupFiles.includes(from)) return block
    replaced += 1
    return { ...block, setupFiles: block.setupFiles.map((file) => (file === from ? to : file)) }
  }
  const out = swap(test)
  const projects = out.projects && out.projects.map((project) => ({ ...project, test: swap(project.test) }))
  if (!replaced) throw new Error(`no setupFiles entry is ${from}: nothing to replace with ${to}`)
  return projects ? { ...out, projects } : out
}
