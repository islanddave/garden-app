// The two vitest projects of the A3 trial (vitest.config.ts, VITEST_NODE_PROJECT=1), held to the tree.
//
// With the key set the unit suite runs as two projects. `node` takes the test files whose code under test is
// server-side: those under lambda/, scripts/, migrations/ and tests/parity/ that load nothing under src/, run with no
// jsdom and no src/__tests__/setup.ts. `dom` takes every other file as before, and that includes the node-root tests
// that do load SPA code (LOADS_SRC in ./vitest-node-project.mjs). Without the key there is one project and every
// file gets jsdom. Only ci-next.yml's two unit legs set the key, so each dev push compares the two shapes by test ID
// (scripts/ci-telemetry/shadow-agree.py).
//
// This file is collected in both shapes, so it runs in the gating job and in the legs, and it holds six things:
//   1. the switch takes. With the key this file has no DOM, without it it has one, and the installed vitest lists
//      two projects or one to match. A leg whose key did nothing would run jsdom-everything like ci.yml and read
//      TEST-IDS-EQUAL for the wrong reason;
//   2. every test-named file outside tests/integration is in exactly one project, and the two shapes collect the
//      same files. A file in no project is never run; a file in two runs twice and doubles its test IDs;
//   3. the node project is exactly the *.test.* files under its four roots that are not in LOADS_SRC;
//   4. no node-project file reads a member of the five browser globals by its plain spelling, so a DOM test dropped
//      under scripts/ or lambda/ reds the gating job with a sentence instead of redding only the shadow;
//   5. no node-project file loads anything under src/, itself or through what it imports. The test-ID digest and the
//      coverage report are both blind to a test that passes under node on the no-browser branches of SPA code;
//   6. every file in LOADS_SRC still does load something under src/, so the list stays only as long as it is true.
// 1 to 3 ask the installed vitest which project each file is in (`vitest list --filesOnly --json` in a child process,
// as vitest-test-ids-reporter.test.js asks it for its default reporters) and do not re-implement its globs.
//
// 4 reads text, so it has false positives (a local named like a browser global, a string) and misses (a DOM reached
// by a spelling it does not know). It is gating during the trial for one reason: without it a DOM test dropped under
// a node root reds only the legs, reads DISAGREE, and blocks the shadow's 10-push window, which costs far more than
// the rename it asks for.
//
// 5 and 6 read text too, with one pattern (SPECIFIER): a quoted specifier after `from`, `import`, `import(`,
// `require(`, `require.resolve(`, or a vi.mock / doMock / unmock / doUnmock / importActual / importMock call. That
// covers static and side-effect imports, re-exports, literal dynamic imports and mocks. Relative specifiers, a
// leading-slash one that names a file, and the aliases of vitest.config.ts are followed through every file they
// reach; packages are not. A mock of a src/ module counts as loading it: the code under test imports that module.
// The scan errs toward dom: an import-shaped line inside a comment or a string counts as an import.
// What it cannot see, and what the tree held of each when the rule was added (2026-10-07):
//   - a computed specifier: an import or require of a variable, of a call, or of a template with a placeholder.
//     Three files in the node project's closure had one, and none leads to src/:
//     lambda/imageMetadataStrip-copies-sync.test.js (in a script it hands to a child `node`, for a Lambda's copy),
//     scripts/putup-postdeploy-refile.mjs and scripts/seed-recipes.mjs (lambda/_test-stubs, lambda/preservation and
//     that Lambda's own driver package). The samples at the foot of this file are strings.
//   - source that is read and not loaded. 46 node-project test files named a src/ path in a string, nearly all to
//     readFileSync it (source pins, copy-parity checks). Reading text runs none of it, so the environment cannot
//     change what such a test means and it is rightly a node test. None of the 46 evaluated what it read (no eval,
//     Function constructor, vm or transform call).
//   - a child process: a test that spawns `node` on a file runs that file outside vitest in both shapes.
//   - vite's glob import (the glob method of import.meta): no file under the node roots used one.
// A test that loads SPA code by one of those routes belongs in LOADS_SRC by hand; 6 would then ask for its removal,
// so say so in a line of this header first.
//
// When the trial ends and the projects are unconditional, 1 loses its "without the key" half and 4 goes: from then
// on a DOM test under a node root fails by itself in every run (`document is not defined`) and the scan would keep
// only its false positives. 2, 3, 5 and 6 stay.
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix as slashed, relative, resolve, sep } from 'node:path'
import { LOADS_SRC, NODE_ROOTS as ROOTS_OF_THE_CONFIG, NODE_TEST_NAMED, nodeProjectFiles } from './vitest-node-project.mjs'

const ROOT = process.cwd()
const KEY = 'VITEST_NODE_PROJECT'
const NODE_ROOTS = ['lambda/', 'scripts/', 'migrations/', 'tests/parity/']
const ROOTS_SAID = 'lambda/, scripts/, migrations/ and tests/parity/'
const LIST = 'LOADS_SRC in scripts/ci-telemetry/vitest-node-project.mjs'
// A test file as vitest's own default `include` has it (**/*.{test,spec}.?(c|m)[jt]s?(x)), and nothing wider: a
// snapshot (x.test.jsx.snap) or a parked draft (x.int.test.js.txt) is named like a test and is not one.
// NODE_TEST_NAMED, which picks the node project's files, ends the same way, so neither shape collects such a file
// and neither does this walk.
const TEST_NAMED = /\.(?:test|spec)\.[cm]?[jt]sx?$/
// What the walk leaves out, which is what the config's `exclude` leaves out: vitest's own defaults (node_modules,
// .git), tests/integration and agent worktrees under .claude; plus coverage/ and dist/, which are build output.
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.claude', 'coverage', 'dist'])
const SKIPPED_PATHS = new Set(['tests/integration'])

const posix = (path) => path.split(sep).join('/')
const underNodeRoot = (file) => NODE_ROOTS.some((root) => file.startsWith(root))
const underSrc = (file) => file.startsWith('src/')

const walk = (dir = ROOT, found = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = posix(relative(ROOT, join(dir, entry.name)))
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name) && !SKIPPED_PATHS.has(rel)) walk(join(dir, entry.name), found)
    } else if (TEST_NAMED.test(entry.name)) {
      found.push(rel)
    }
  }
  return found
}

// One `{ file, project }` per collected file, from a child that has a shell's PATH and HOME, the key or not, and
// nothing else of this run's environment. The root project of the one-project shape has no name: ''.
const list = (switched) => {
  const vitest = resolve(ROOT, 'node_modules/vitest/vitest.mjs')
  const out = execFileSync(process.execPath, [vitest, 'list', '--filesOnly', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...(switched ? { [KEY]: '1' } : {}) },
  })
  return JSON.parse(out).map(({ file, projectName }) => ({
    file: posix(relative(ROOT, file)),
    project: projectName || '',
  }))
}

const projectsOf = (listing) => [...new Set(listing.map((entry) => entry.project))].sort()
const sorted = (files) => [...new Set(files)].sort()

// vitest.config.ts as vitest is given it, once per value of the key (null: unset): `{ test, alias }` of each, read
// by vite's own config loader in a child `node` and handed back as JSON. Not imported here: under jsdom a module's
// import.meta.url is not a file URL, and the config finds the repository by it. The child has PATH and HOME only, so
// the config is the same on a runner as on a laptop (with GITHUB_ACTIONS it also builds its reporters).
const KEY_VALUES = [null, '', '0', 'true', '1 ', '1']
const CONFIG_READER = `
  import { loadConfigFromFile } from 'vite'
  const read = []
  for (const value of ${JSON.stringify(KEY_VALUES)}) {
    if (value === null) delete process.env.${KEY}
    else process.env.${KEY} = value
    const { config } = await loadConfigFromFile({ command: 'serve', mode: 'test' }, 'vitest.config.ts')
    read.push({ test: config.test, alias: (config.resolve && config.resolve.alias) || {} })
  }
  process.stdout.write(JSON.stringify(read))`
let configsRead
const configs = () => {
  configsRead ??= JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', CONFIG_READER], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  }))
  return configsRead
}

// A line that reads a member of a browser global by its plain spelling: a property read off one of the five, a stub
// of one, a testing-library import, or an environment docblock. Read as text, so a member that merely shares a name
// (`plan` + `.window.start`) is not one, and a test's own local named like a global is. The patterns and the samples
// in this file are assembled from parts, so that this file, which sits under a node root, does not match itself.
// Comments are prose and are not read for the first two: a whole-line `//`, a block-comment line (` * `, `/*`) and a
// trailing ` // ...` are taken off first. The docblock and the import are read on the line as written.
const GLOBALS = 'document|window|navigator|localStorage|sessionStorage'
const DOM_USE = [
  new RegExp(`(?<![.\\w$])(?:globalThis\\.|self\\.)?(?:${GLOBALS})(?:\\?\\.|\\.)[A-Za-z_$][\\w$]*`),
  new RegExp(`stubGlobal\\(\\s*['"\`](?:${GLOBALS})['"\`]`),
  new RegExp('@testing' + '-library/'),
  new RegExp('@(?:vitest|jest)' + '-environment'),
]
const withoutComment = (line) => (/^\s*(?:\/\/|\/\*|\*)/.test(line) ? '' : line.replace(/\s\/\/\s.*$/, ''))
const domUse = (line) => {
  const code = withoutComment(line)
  for (const [index, pattern] of DOM_USE.entries()) {
    const hit = (index < 2 ? code : line).match(pattern)
    if (hit) return hit[0]
  }
  return null
}

// What a file loads, read from its text: every quoted specifier that follows one of these. A specifier with a
// placeholder in it is computed and is not one (the `$` is left out of what a specifier may hold).
// A `tree` is where the files are: `read(file)`, `isFile(path)` and `aliases` (specifier -> repo-relative path), so
// the same code reads the repository and the small made-up trees at the foot of this file.
const LOADERS = [
  '\\bfrom\\s*',
  '\\bimport\\s*\\(?\\s*',
  '\\brequire(?:\\.resolve)?\\s*\\(\\s*',
  '\\bvi\\s*\\.\\s*(?:mock|doMock|unmock|doUnmock|importActual|importMock)\\s*\\(\\s*',
]
const SPECIFIER = new RegExp(`(?:${LOADERS.join('|')})(['"\`])([^'"\`\\n$]+)\\1`, 'g')
const CODE = /\.[cm]?[jt]sx?$/
// vite's own order of extensions, then a directory's index; and the .ts a .js specifier may stand for.
const SUFFIXES = ['', '.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json', '.cjs', '.cts',
  '/index.mjs', '/index.js', '/index.mts', '/index.ts', '/index.jsx', '/index.tsx', '/index.cjs']
const TYPED = [[/\.js$/, '.ts'], [/\.js$/, '.tsx'], [/\.jsx$/, '.tsx'], [/\.mjs$/, '.mts'], [/\.cjs$/, '.cts']]

const specifiersOf = (tree, file) => {
  if (!tree.seen.has(file)) {
    const text = CODE.test(file) ? tree.read(file) : ''
    tree.seen.set(file, [...text.matchAll(SPECIFIER)].map((found) => ({
      specifier: found[2],
      line: text.slice(0, found.index).split('\n').length,
    })))
  }
  return tree.seen.get(file)
}

// Where a specifier written in `from` points: `{ path, found }`, repo-relative, or null for what is not followed (a
// package, node_modules, a path outside the repository). A path under src/ is returned whether or not a file is
// there: a mock of a module that has since moved still says the test is about SPA code.
const target = (tree, from, specifier) => {
  const plain = specifier.replace(/[?#].*$/, '')
  const alias = Object.keys(tree.aliases).find((key) => plain === key || plain.startsWith(key + '/'))
  const rooted = alias === undefined && plain.startsWith('/')
  let path
  if (alias !== undefined) path = tree.aliases[alias] + plain.slice(alias.length)
  else if (/^\.\.?(?:\/|$)/.test(plain)) path = slashed.join(slashed.dirname(from), plain)
  else if (rooted) path = plain.slice(1)
  else return null
  path = slashed.normalize(path).replace(/\/$/, '')
  if (path === '..' || path.startsWith('../') || path.split('/').includes('node_modules')) return null
  const named = [...SUFFIXES.map((suffix) => path + suffix),
    ...TYPED.filter(([js]) => js.test(path)).map(([js, ts]) => path.replace(js, ts))].find(tree.isFile)
  if (named === undefined && rooted && !underSrc(path)) return null
  return { path: named === undefined ? path : named, found: named !== undefined }
}

// The shortest chain of loads from `start` to something under src/, one line per hop, or null when there is none.
// `unfollowed` collects the relative and alias specifiers met on the way that name no file.
const chainToSrc = (tree, start, unfollowed = []) => {
  const cameFrom = new Map([[start, null]])
  const queue = [start]
  while (queue.length > 0) {
    const file = queue.shift()
    for (const { specifier, line } of specifiersOf(tree, file)) {
      const to = target(tree, file, specifier)
      if (to === null || cameFrom.has(to.path)) continue
      cameFrom.set(to.path, { file, line })
      if (underSrc(to.path)) {
        const chain = []
        for (let at = to.path; cameFrom.get(at); at = cameFrom.get(at).file) {
          chain.unshift(`${cameFrom.get(at).file}:${cameFrom.get(at).line} loads ${at}`)
        }
        return chain
      }
      if (to.found) queue.push(to.path)
      else unfollowed.push(`${file}:${line} names ${specifier}, and no file is at ${to.path}`)
    }
  }
  return null
}

const repository = (aliases) => ({
  aliases,
  seen: new Map(),
  read: (file) => readFileSync(resolve(ROOT, file), 'utf8'),
  isFile: (path) => {
    try {
      return statSync(resolve(ROOT, path)).isFile()
    } catch {
      return false
    }
  },
})

describe('the switch (VITEST_NODE_PROJECT)', () => {
  let read

  beforeAll(() => {
    read = configs()
  }, 300000)

  it('gives this file a DOM exactly when the key is not 1', ({ task }) => {
    // The name is the same in both shapes, so the test-ID digest is too; what it asserts follows the key.
    const switched = process.env[KEY] === '1'
    const here = 'scripts/ci-telemetry/vitest-projects.test.js'
    const why = switched
      ? `${KEY}=1 and ${here} still has a DOM: the switch in vitest.config.ts did not take, this run is ` +
        'jsdom-everything, and a TEST-IDS-EQUAL against ci.yml would prove nothing. Restore the `projects` fork in ' +
        'vitest.config.ts (this file belongs to the node project).'
      : `${KEY} is not 1 and ${here} has no DOM: the node project is on without its key, so ci.yml is no longer ` +
        'the jsdom-everything side of the shadow comparison. The fork in vitest.config.ts must build the projects ' +
        `only when process.env.${KEY} === '1'.`
    expect(typeof document, why).toBe(switched ? 'undefined' : 'object')
    expect(task.file.projectName || '', `${here} runs in the project the key gives it: 'node' with ${KEY}=1, the ` +
      'one unnamed project without').toBe(switched ? 'node' : '')
  })

  it('builds the projects only when the key is exactly 1', () => {
    expect(KEY_VALUES.at(-1)).toBe('1')
    for (const [index, value] of KEY_VALUES.slice(0, -1).entries()) {
      const { test } = read[index]
      const said = value === null ? `${KEY} unset` : `${KEY}=${JSON.stringify(value)}`
      expect(test.projects, `vitest.config.ts with ${said} must be the one-project config: only the string '1' ` +
        'builds the projects, or a run that is not a ci-next leg stops being jsdom-everything').toBeUndefined()
      expect([test.environment, test.setupFiles], `vitest.config.ts with ${said}: every file gets jsdom and the ` +
        'setup file').toEqual(['jsdom', ['./src/__tests__/setup.ts']])
    }
  })

  it('makes the two projects differ in environment, setup file and files, and in nothing else', () => {
    // Read as the object vitest is given, not as text: an option that reaches a project through a variable or a
    // spread is seen here too. The test IDs cannot see an option that changes what the files mean (retry, isolate,
    // pool, sequence, a timeout of the node project's own), so a project that gains one reds here instead.
    const one = read[0].test
    const two = read.at(-1).test
    expect(two.projects, `vitest.config.ts with ${KEY}=1 builds no projects: the fork on the key is gone`)
      .toHaveLength(2)
    const where = `vitest.config.ts with ${KEY}=1: `
    const restart = " Change it here in the same commit, and restart the shadow's count " +
      '(.github/workflows/ci-next.yml, THE A3 TRIAL).'
    expect(two.projects.map((project) => [Object.keys(project).sort(), project.extends, project.test.name,
      project.test.environment, Object.keys(project.test).sort()]), where + 'the projects are dom then node, each ' +
      '`extends: true`, and each sets these keys and no others. An option added to one changes what its files run ' +
      'under while every test ID stays equal.' + restart).toEqual([
      [['extends', 'test'], true, 'dom', 'jsdom', ['environment', 'exclude', 'name', 'setupFiles']],
      [['extends', 'test'], true, 'node', 'node', ['environment', 'include', 'name']],
    ])
    const [dom, node] = two.projects.map((project) => project.test)
    expect(dom.setupFiles, where + 'the dom project loads the setup files the one-project config loads')
      .toEqual(one.setupFiles)
    expect(node.include, where + "the node project's `include` is nodeProjectFiles() of " +
      'scripts/ci-telemetry/vitest-node-project.mjs, the files themselves').toEqual(nodeProjectFiles(ROOT))
    expect(dom.exclude, where + "the dom project's `exclude` is the node project's `include`, the same list: a " +
      'file in one and not the other runs in both projects or in neither').toEqual(node.include)
    // A project with `extends: true` inherits the root `test` block and arrays concatenate: a setupFiles beside the
    // fork would load in the node project too, where src/__tests__/setup.ts throws on its first afterEach.
    const INSIDE = ['projects', 'environment', 'setupFiles']
    const beside = (test) => Object.fromEntries(Object.entries(test).filter(([key]) => !INSIDE.includes(key)))
    expect(Object.keys(two).filter((key) => key === 'environment' || key === 'setupFiles'), where + '`environment` ' +
      'and `setupFiles` live inside the fork, never beside it: beside it they reach the node project too')
      .toEqual([])
    expect(beside(two), where + 'everything beside the fork is what the one-project config has, so both projects ' +
      'inherit it unchanged.' + restart).toEqual(beside(one))
  })
})

describe('the projects, asked of the installed vitest', () => {
  let walked, on, off, tree, inNode

  beforeAll(() => {
    walked = new Set(walk())
    on = list(true)
    off = list(false)
    inNode = sorted(on.filter((entry) => entry.project === 'node').map((entry) => entry.file))
    tree = repository(Object.fromEntries(Object.entries(configs()[0].alias)
      .map(([specifier, path]) => [specifier, posix(relative(ROOT, path))])))
  }, 300000)

  it('is two projects with the key, dom and node, and one without', () => {
    expect(projectsOf(on), `with ${KEY}=1 the installed vitest must list the projects dom and node; with anything ` +
      'else the switch in vitest.config.ts is a no-op or has grown a project nothing here accounts for')
      .toEqual(['dom', 'node'])
    expect(projectsOf(off), `without ${KEY} the installed vitest must list one unnamed project: every file under ` +
      'jsdom, as ci.yml runs it').toEqual([''])
  })

  it('puts every test file outside tests/integration in exactly one project', () => {
    const projectsByFile = new Map()
    for (const { file, project } of on) projectsByFile.set(file, [...(projectsByFile.get(file) || []), project])
    const problems = []
    for (const file of sorted([...walked, ...projectsByFile.keys()])) {
      const projects = projectsByFile.get(file) || []
      if (!walked.has(file)) {
        problems.push(`vitest projects: ${file} is collected, and the walk in ` +
          'scripts/ci-telemetry/vitest-projects.test.js does not reach it: bring SKIPPED_DIRS / SKIPPED_PATHS there ' +
          'in line with `exclude` in vitest.config.ts.')
      } else if (projects.length !== 1) {
        problems.push(`vitest projects: ${file} is collected by ${projects.length} project(s) ` +
          `(${projects.join(', ') || 'none'}); every test file outside tests/integration must be in ` +
          `exactly one. 'node' takes the *.test.* files under ${ROOTS_SAID} that load nothing under src/: no DOM ` +
          "and no src/__tests__/setup.ts. 'dom' takes everything else. A file in no project is never run; a file " +
          "in two runs twice and doubles its test IDs. The node project's `include` and the dom project's " +
          '`exclude` must be the one list nodeProjectFiles() returns (twoProjects in vitest.config.ts).')
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
    expect(walked.size).toBeGreaterThan(1000)
  })

  it('collects the same files with the key as without it, each once', () => {
    const offFiles = off.map((entry) => entry.file)
    const onFiles = new Set(on.map((entry) => entry.file))
    expect(offFiles).toHaveLength(new Set(offFiles).size)
    const missing = sorted(offFiles).filter((file) => !onFiles.has(file))
    const extra = sorted(onFiles).filter((file) => !offFiles.includes(file))
    expect({ missing, extra }, `with ${KEY}=1 the two projects must collect exactly the files the one-project run ` +
      'collects. `missing` are run by ci.yml and by no project; `extra` are run by a project and not by ci.yml. ' +
      'Fix nodeProjectFiles() in scripts/ci-telemetry/vitest-node-project.mjs, or twoProjects in vitest.config.ts.')
      .toEqual({ missing: [], extra: [] })
  })

  it(`makes the node project exactly the files under ${ROOTS_SAID} that are not in LOADS_SRC`, () => {
    expect(ROOTS_OF_THE_CONFIG.map((root) => `${root}/`), 'NODE_ROOTS in scripts/ci-telemetry/vitest-node-project.mjs ' +
      'and NODE_ROOTS in scripts/ci-telemetry/vitest-projects.test.js name the same roots: change both in one ' +
      'commit').toEqual(NODE_ROOTS)
    const kept = new Set(LOADS_SRC)
    const problems = on
      .filter(({ file, project }) => (project === 'node') !== (underNodeRoot(file) && !kept.has(file)))
      .map(({ file, project }) => `vitest projects: ${file} runs in '${project}'. 'node' takes the *.test.* files ` +
        `under ${ROOTS_SAID} that are not in ${LIST}, and no others; 'dom' takes the rest. A *.spec.* file under a ` +
        'node root is not picked by NODE_TEST_NAMED: rename the file. A name with a glob character in it ([, (, *) ' +
        'matches nothing when vitest reads the list: rename the file. Otherwise fix nodeProjectFiles() in ' +
        'scripts/ci-telemetry/vitest-node-project.mjs, or move the file. If the roots themselves are meant to ' +
        'change, change NODE_ROOTS there and in scripts/ci-telemetry/vitest-projects.test.js in the same commit.')
    expect(problems, problems.join('\n')).toEqual([])
    for (const root of NODE_ROOTS) {
      const any = on.some(({ file, project }) => project === 'node' && file.startsWith(root))
      expect(any, `the node project holds no file under ${root}`).toBe(true)
    }
    expect(on.some(({ project }) => project === 'dom')).toBe(true)
  })

  it('finds no node-project file that reads a member of the five browser globals by its plain spelling', () => {
    const problems = []
    for (const file of inNode) {
      readFileSync(resolve(ROOT, file), 'utf8').split('\n').forEach((line, index) => {
        const token = domUse(line)
        if (token === null) return
        problems.push(`${file}:${index + 1} uses ${token}, and this file runs without a DOM in vitest's node ` +
          "project (ci-next.yml's unit legs during the A3 trial; every run after it). Move the test under " +
          'src/__tests__/ (the dom project), or take the DOM out of it. The check reads text, not scope: if that ' +
          "name is a local of the test's own, rename the local; if it is inside a string, split the token " +
          "('docu' + 'ment.x'), as scripts/ci-telemetry/vitest-projects.test.js does.")
      })
    }
    expect(problems, problems.join('\n')).toEqual([])
    expect(inNode.length).toBeGreaterThan(100)
  })

  it('finds no node-project file that loads anything under src/, itself or through what it imports', () => {
    const problems = []
    const unfollowed = []
    for (const file of inNode) {
      const chain = chainToSrc(tree, file, unfollowed)
      if (chain === null) continue
      problems.push(`vitest projects: ${file} runs in 'node' and loads SPA code:\n    ${chain.join('\n    ')}\n` +
        '  For code under src/ the browser is production. Under node this test keeps its name and passes while ' +
        'that code takes its no-browser branches, and neither the test-ID digest nor coverage can see it. Add ' +
        `'${file}' to ${LIST} (kept sorted): it then runs in 'dom', with jsdom and src/__tests__/setup.ts, as the ` +
        'one-project run has it. Or take the src/ dependency out of the test. The scan reads text: an ' +
        'import-shaped line inside a comment or a string counts, so reword that or split the token.')
    }
    expect(problems, problems.join('\n')).toEqual([])
    const gaps = sorted(unfollowed)
    expect(gaps, 'vitest projects: the import scan of scripts/ci-telemetry/vitest-projects.test.js cannot follow ' +
      "these, so it cannot say whether the node project's files reach src/ through them:\n    " +
      gaps.join('\n    ') + '\n  If the line is a real import, teach `target` in that file how vite resolves it. ' +
      'If it is prose or a string that only looks like one, reword it or split the token.').toEqual([])
    // Not vacuous: the scan really walks past the test files, and really follows the aliases of the config.
    expect(tree.seen.size, 'the scan read no more files than the node project holds: it followed no import')
      .toBeGreaterThan(inNode.length + 100)
    const stubs = Object.values(tree.aliases)
    expect(stubs.some((stub) => tree.seen.has(stub)), 'no file of the node project reached a `resolve.alias` ' +
      `target of vitest.config.ts (${stubs.join(', ') || 'none read'}): the aliases are not being followed`)
      .toBe(true)
  })

  it('keeps LOADS_SRC to test files under the node roots that still load something under src/', () => {
    expect(LOADS_SRC, `${LIST} is sorted and names each file once`).toEqual(sorted(LOADS_SRC))
    const collected = new Set(off.map((entry) => entry.file))
    const problems = []
    for (const file of LOADS_SRC) {
      const entry = `vitest projects: '${file}' is in ${LIST}`
      if (!collected.has(file)) {
        problems.push(`${entry} and vitest collects no such test file (moved, renamed or deleted). Remove it from ` +
          'the list, or correct the path.')
      } else if (!underNodeRoot(file) || !NODE_TEST_NAMED.test(file)) {
        problems.push(`${entry} and is not a *.test.* file under ${ROOTS_SAID}: it runs in 'dom' whether listed ` +
          'or not. Remove it from the list.')
      } else if (chainToSrc(tree, file) === null) {
        problems.push(`${entry} and nothing it loads is under src/ any more. Remove it from the list: it then ` +
          "runs in 'node', with no jsdom and no setup file, like the other server-side tests. The list holds a " +
          'file only while that file loads SPA code.')
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
  })
})

describe('what counts as a test file', () => {
  it("is vitest's own *.test.* / *.spec.* with a js or ts extension, as the walk reads the tree", () => {
    const named = ['a.test.js', 'a.test.jsx', 'a.spec.ts', 'a.spec.tsx', 'a.test.mjs', 'a.test.cjs', 'a.test.mts',
      'a.int.test.js', 'household-columns.test.js']
    expect(named.filter((name) => !TEST_NAMED.test(name))).toEqual([])
  })

  it('is not a file merely named like one, which vitest never collects', () => {
    // Each of these would otherwise red the gating pass as "collected by 0 project(s)".
    // The first is a name this repo has carried (migrations/v4-parentprojfk-001, 2026-08-13).
    const others = ['PROPOSED-TEST-parent-proj-fk.int.test.js.txt', 'a.test.jsx.snap', 'a.test.js.orig',
      'a.test.json', 'a.test.md', 'a.spec.yaml', 'a.test.js~', 'test.js', 'a.tests.js', 'atest.js']
    expect(others.filter((name) => TEST_NAMED.test(name))).toEqual([])
    // The node project picks its files by the same ending, *.test.* only: a wider one has it collect a file the
    // one-project run never does, and the two shapes stop running the same files.
    expect(others.filter((name) => NODE_TEST_NAMED.test(name))).toEqual([])
    expect(['a.test.js', 'a.int.test.mjs', 'a.test.tsx', 'a.spec.js'].map((name) => NODE_TEST_NAMED.test(name)))
      .toEqual([true, true, true, false])
  })
})

describe('what counts as using the DOM', () => {
  const dot = (...parts) => parts.join('.')

  it('is a property of a browser global, a stub of one, a testing-library import or an environment docblock', () => {
    const uses = [
      dot('document', 'body', 'innerHTML'),
      `expect(${dot('window', 'innerWidth')}).toBe(426)`,
      dot('globalThis', 'navigator', 'userAgent'),
      dot('localStorage', "setItem('k', 'v')"),
      dot('sessionStorage', 'clear()'),
      ['window', 'matchMedia'].join('?.'),
      dot('vi', 'stub' + "Global('document', {})"),
      "import { render } from '" + '@testing' + "-library/react'",
      '// ' + '@vitest' + '-environment jsdom',
    ]
    expect(uses.filter((line) => domUse(line) === null)).toEqual([])
  })

  it('is not the garden vocabulary those names share', () => {
    const plain = [
      'a three-day weather window opens on the 14th',
      'const window = plan.windows[0]',
      dot('plan', 'window', 'start'),
      'the storage location of the document',
      "typeof document === 'undefined'",
      'navigator, document and window are absent here',
    ]
    expect(plain.filter((line) => domUse(line) !== null)).toEqual([])
  })

  it('is not a comment that names one, and still is the code before a trailing comment', () => {
    const title = dot('document', 'title')
    const prose = [`// sets ${title} in the browser`, `    // ${dot('window', 'start')} is the first day`,
      ` * reads ${dot('navigator', 'userAgent')}`, `/* ${title} */`, `const days = 3 // not ${title}`]
    expect(prose.filter((line) => domUse(line) !== null)).toEqual([])
    expect(domUse(`${title} = 'x' // sets the title`)).toBe(title)
    expect(domUse(`const page = 'https://example.test/a'; ${title} = page`)).toBe(title)
  })
})

describe('what counts as loading a file', () => {
  // The samples are written with <angle brackets> where the quotes go, so that this file, which the scan reads like
  // any other under a node root, holds no import of them.
  const quoted = (text, quote = "'") => text.replace(/<([^<>]*)>/g, `${quote}$1${quote}`)
  const made = (files, aliases = {}) => ({
    aliases,
    seen: new Map(),
    read: (file) => quoted(files[file]),
    isFile: (path) => Object.hasOwn(files, path),
  })
  const loads = (line, quote) => {
    const tree = { aliases: {}, seen: new Map(), read: () => quoted(line, quote), isFile: () => true }
    return specifiersOf(tree, 'lambda/a/x.test.js').map((found) => found.specifier)
  }

  it('is a static or side-effect import, a re-export, a literal dynamic import, a require, and a mock', () => {
    const forms = [
      'import a from <./b.js>',
      'import { a } from <./b.js>',
      'import * as a from <./b.js>',
      'import {\n  a,\n  b,\n} from <./b.js>',
      'import a, { b } from<./b.js>',
      'import <./b.js>',
      'export { a } from <./b.js>',
      'export * from <./b.js>',
      'const a = await import(<./b.js>)',
      'const a = await import( <./b.js> )',
      'const a = require(<./b.js>)',
      'const at = require.resolve(<./b.js>)',
      'vi.mock(<./b.js>)',
      'vi.mock(<./b.js>, () => ({ a: 1 }))',
      'vi.mock(import(<./b.js>), () => ({ a: 1 }))',
      'vi.doMock(<./b.js>, () => ({}))',
      'vi.unmock(<./b.js>)',
      'const real = await vi.importActual(<./b.js>)',
      'const mock = await vi.importMock(<./b.js>)',
    ]
    for (const quote of ["'", '"', '`']) {
      expect(forms.filter((line) => loads(line, quote).join() !== './b.js')).toEqual([])
    }
  })

  it('is not a computed specifier, which the scan cannot read', () => {
    const computed = ['const a = await import(name)', 'const a = require(join(dir, name))',
      'const a = await import(pathToFileURL(file).href)', 'const a = await import(<./${name}.js>)']
    expect(computed.filter((line) => loads(line, '`').length > 0)).toEqual([])
  })

  it('resolves a relative specifier as vite does, and leaves packages alone', () => {
    const tree = made({
      'lambda/a/x.test.js': '', 'lambda/a/b.js': '', 'lambda/a/c.mjs': '', 'lambda/a/d/index.js': '',
      'lambda/a/e.ts': '', 'lambda/a/data.json': '', 'lambda/shared/f.cjs': '', 'top.js': '',
      'lambda/a/node_modules/pkg/index.js': '',
    })
    const from = 'lambda/a/x.test.js'
    const at = (specifier) => target(tree, from, specifier)
    expect(['./b.js', './b', './c', './d', './e.js', './e', './data.json', '../shared/f', '../../top.js',
      './b.js?raw', '/top.js'].map((specifier) => at(specifier))).toEqual([
      'lambda/a/b.js', 'lambda/a/b.js', 'lambda/a/c.mjs', 'lambda/a/d/index.js', 'lambda/a/e.ts', 'lambda/a/e.ts',
      'lambda/a/data.json', 'lambda/shared/f.cjs', 'top.js', 'lambda/a/b.js', 'top.js',
    ].map((path) => ({ path, found: true })))
    expect(['vitest', 'node:fs', '@scope/pkg', './node_modules/pkg/index.js', '../../../outside.js', '/', '/nowhere']
      .map((specifier) => at(specifier))).toEqual([null, null, null, null, null, null, null])
    expect(at('./gone.js')).toEqual({ path: 'lambda/a/gone.js', found: false })
  })

  it('follows the aliases of the config, by the whole specifier and by its first part', () => {
    const tree = made({ 'lambda/_test-stubs/neon.js': '', 'lambda/_test-stubs/neon/extra.js': '' },
      { '@neon/serverless': 'lambda/_test-stubs/neon' })
    expect(target(tree, 'lambda/a/x.test.js', '@neon/serverless'))
      .toEqual({ path: 'lambda/_test-stubs/neon.js', found: true })
    expect(target(tree, 'lambda/a/x.test.js', '@neon/serverless/extra.js'))
      .toEqual({ path: 'lambda/_test-stubs/neon/extra.js', found: true })
    expect(target(tree, 'lambda/a/x.test.js', '@neon/serverless-http')).toBeNull()
  })

  it('reaches src/ directly, through two hops, a re-export, an alias, a mock and a moved file', () => {
    const tree = made({
      'lambda/a/direct.test.js': 'import { a } from <../../src/lib/a.js>',
      'lambda/a/twohops.test.js': '// a test\nimport { handler } from <./handler.js>',
      'lambda/a/handler.js': 'import { it } from <vitest>\nexport * from <../shared/rules.js>',
      'lambda/shared/rules.js': '\n\nconst { a } = require(<../../src/lib/a>)',
      'lambda/a/aliased.test.js': 'import { sql } from <@neon/serverless>',
      'lambda/_test-stubs/neon.js': 'import <../../src/lib/a.js>',
      'lambda/a/mocked.test.js': 'vi.mock(<../../src/lib/a.js>, () => ({ a: 1 }))',
      'lambda/a/moved.test.js': 'vi.mock(<../../src/lib/renamed.js>)',
      'lambda/a/table.test.js': 'import table from <../../src/data/table.json>',
      'src/lib/a.js': 'import <./b.js>', 'src/lib/b.js': '', 'src/data/table.json': '{}',
    }, { '@neon/serverless': 'lambda/_test-stubs/neon.js' })
    const chains = Object.fromEntries(['direct', 'twohops', 'aliased', 'mocked', 'moved', 'table']
      .map((name) => [name, chainToSrc(tree, `lambda/a/${name}.test.js`)]))
    expect(chains).toEqual({
      direct: ['lambda/a/direct.test.js:1 loads src/lib/a.js'],
      twohops: ['lambda/a/twohops.test.js:2 loads lambda/a/handler.js', 'lambda/a/handler.js:2 loads ' +
        'lambda/shared/rules.js', 'lambda/shared/rules.js:3 loads src/lib/a.js'],
      aliased: ['lambda/a/aliased.test.js:1 loads lambda/_test-stubs/neon.js', 'lambda/_test-stubs/neon.js:1 ' +
        'loads src/lib/a.js'],
      mocked: ['lambda/a/mocked.test.js:1 loads src/lib/a.js'],
      moved: ['lambda/a/moved.test.js:1 loads src/lib/renamed.js'],
      table: ['lambda/a/table.test.js:1 loads src/data/table.json'],
    })
  })

  it('finds nothing where there is nothing, and says which specifiers it could not follow', () => {
    const tree = made({
      'lambda/a/clean.test.js': 'import { handler } from <./handler.js>\nimport { it } from <vitest>\n' +
        'const text = readFileSync(<src/lib/a.js>)\nconst other = await import(<./lost.js>)',
      'lambda/a/handler.js': 'import rules from <../shared/rules.json>\nimport { handler } from <./handler.js>',
      'lambda/shared/rules.json': 'import <../../src/lib/a.js>',
      'src/lib/a.js': '',
    })
    const unfollowed = []
    expect(chainToSrc(tree, 'lambda/a/clean.test.js', unfollowed)).toBeNull()
    expect(unfollowed).toEqual(['lambda/a/clean.test.js:4 names ./lost.js, and no file is at lambda/a/lost.js'])
  })
})
