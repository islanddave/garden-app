// The two vitest projects of the unit run (vitest.config.ts), held to the tree.
//
// The unit suite runs as two projects. `node` takes the test files whose code under test is server-side: those under
// lambda/, scripts/, migrations/ and tests/parity/ that load nothing under src/, run with no jsdom and no
// src/__tests__/setup.ts. `dom` takes every other file, and that includes the node-root tests that do load SPA code
// (LOADS_SRC in ./vitest-node-project.mjs). This began as the A3 trial, behind an env key that switched it on; the
// key is gone (OPS-A3TRIALKEYREMOVE-001) and two projects are the only shape.
//
// This file holds six things:
//   1. the projects are there. This file has no DOM and runs in `node`, and the installed vitest lists the two
//      projects;
//   2. every test-named file outside tests/integration is in exactly one project. A file in no project is never run;
//      a file in two runs twice and doubles its test IDs;
//   3. the node project is exactly the *.test.* files under its four roots that are not in LOADS_SRC;
//   4. no node-project file picks its own environment with a docblock (vitest's or jest's `-environment` tag).
//      vitest lets the docblock override the project's `environment`, so such a file would run under jsdom in
//      `node`, without src/__tests__/setup.ts, and every other guard here would stay green;
//   5. no node-project file loads anything under src/, itself or through what it imports. The test-ID digest and the
//      coverage report are both blind to a test that passes under node on the no-browser branches of SPA code;
//   6. every file in LOADS_SRC still does load something under src/, so the list stays only as long as it is true.
// 1 to 3 ask the installed vitest which project each file is in (`vitest list --filesOnly --json` in a child process,
// as vitest-test-ids-reporter.test.js asks it for its default reporters) and do not re-implement its globs.
//
// The trial's text scan for plain uses of browser globals in node-project files went with the key: a DOM test under
// a node root now fails by itself in every run (`document is not defined`), unless it switches its own environment by
// docblock, which 4 refuses. 4 is the one part of that scan kept: it reads each line as written, so a comment that
// names the tag counts too (split the token).
//
// 4 reads text with its own pattern (ENV_DOCBLOCK). 5 and 6 read text with one pattern (SPECIFIER): a quoted
// specifier after `from`, `import`, `import(`, `require(`, `require.resolve(`, or a vi.mock / doMock / unmock /
// doUnmock / importActual / importMock call. That covers static and side-effect imports, re-exports, literal dynamic
// imports and mocks. Relative specifiers, a leading-slash one that names a file, and the aliases of vitest.config.ts
// are followed through every file they reach; packages are not. A mock of a src/ module counts as loading it: the
// code under test imports that module.
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
//   - a child process: a test that spawns `node` on a file runs that file outside vitest in either project.
//   - vite's glob import (the glob method of import.meta): no file under the node roots used one.
// A test that loads SPA code by one of those routes belongs in LOADS_SRC by hand; 6 would then ask for its removal,
// so say so in a line of this header first.
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix as slashed, relative, resolve, sep } from 'node:path'
import { LOADS_SRC, NODE_ROOTS as ROOTS_OF_THE_CONFIG, NODE_TEST_NAMED, nodeProjectFiles } from './vitest-node-project.mjs'

const ROOT = process.cwd()
const NODE_ROOTS = ['lambda/', 'scripts/', 'migrations/', 'tests/parity/']
const ROOTS_SAID = 'lambda/, scripts/, migrations/ and tests/parity/'
const LIST = 'LOADS_SRC in scripts/vitest/vitest-node-project.mjs'
// An environment docblock, read on the line as written (a docblock is a comment, so comments are not taken off). Built
// from parts, so that this file, which sits under a node root, does not match itself.
const ENV_DOCBLOCK = new RegExp('@(?:vitest|jest)' + '-environment\\b')
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

// One `{ file, project }` per collected file, from a child that has a shell's PATH and HOME and nothing else of this
// run's environment. A project with no name reads as ''.
const list = () => {
  const vitest = resolve(ROOT, 'node_modules/vitest/vitest.mjs')
  const out = execFileSync(process.execPath, [vitest, 'list', '--filesOnly', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  })
  return JSON.parse(out).map(({ file, projectName }) => ({
    file: posix(relative(ROOT, file)),
    project: projectName || '',
  }))
}

const projectsOf = (listing) => [...new Set(listing.map((entry) => entry.project))].sort()
const sorted = (files) => [...new Set(files)].sort()

// vitest.config.ts as vitest is given it: `{ test, alias }`, read by vite's own config loader in a child `node` and
// handed back as JSON. Not imported here: under jsdom a module's import.meta.url is not a file URL, and the config
// finds the repository by it. The child has PATH and HOME only, so the config is the same on a runner as on a laptop
// (with GITHUB_ACTIONS it also builds its reporters).
const CONFIG_READER = `
  import { loadConfigFromFile } from 'vite'
  const { config } = await loadConfigFromFile({ command: 'serve', mode: 'test' }, 'vitest.config.ts')
  process.stdout.write(JSON.stringify({ test: config.test, alias: (config.resolve && config.resolve.alias) || {} }))`
let configRead
const config = () => {
  configRead ??= JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', CONFIG_READER], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  }))
  return configRead
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

// The keys of vitest.config.ts's `test` block beside `projects`, which both projects inherit (`extends: true`). Off
// a runner: GITHUB_ACTIONS adds `reporters`, which the child does not have.
const BESIDE = ['coverage', 'env', 'exclude', 'globals', 'testTimeout']

describe('the projects of vitest.config.ts', () => {
  let read

  beforeAll(() => {
    read = config()
  }, 300000)

  it('runs this file in the node project, with no DOM', ({ task }) => {
    const here = 'scripts/vitest/vitest-projects.test.js'
    expect(typeof document, `${here} has a DOM: the projects in vitest.config.ts are not there, or this file is no ` +
      'longer a node-project file, and every server-side test runs under jsdom. Restore `projects: twoProjects()` in ' +
      'vitest.config.ts.').toBe('undefined')
    expect(task.file.projectName || '', `${here} runs in the node project`).toBe('node')
  })

  it('makes the two projects differ in environment, setup file and files, and in nothing else', () => {
    // Read as the object vitest is given, not as text: an option that reaches a project through a variable or a
    // spread is seen here too. The test IDs cannot see an option that changes what the files mean (retry, isolate,
    // pool, sequence, a timeout of the node project's own), so a project that gains one reds here instead.
    const { test } = read
    expect(test.projects, 'vitest.config.ts builds no projects: `projects: twoProjects()` is gone').toHaveLength(2)
    const where = 'vitest.config.ts: '
    const change = ' Change it here in the same commit.'
    expect(test.projects.map((project) => [Object.keys(project).sort(), project.extends, project.test.name,
      project.test.environment, Object.keys(project.test).sort()]), where + 'the projects are dom then node, each ' +
      '`extends: true`, and each sets these keys and no others. An option added to one changes what its files run ' +
      'under while every test ID stays equal.' + change).toEqual([
      [['extends', 'test'], true, 'dom', 'jsdom', ['environment', 'exclude', 'name', 'setupFiles']],
      [['extends', 'test'], true, 'node', 'node', ['environment', 'include', 'name']],
    ])
    const [dom, node] = test.projects.map((project) => project.test)
    expect(dom.setupFiles, where + 'the dom project loads the repo setup file and nothing else')
      .toEqual(['./src/__tests__/setup.ts'])
    expect(node.include, where + "the node project's `include` is nodeProjectFiles() of " +
      'scripts/vitest/vitest-node-project.mjs, the files themselves').toEqual(nodeProjectFiles(ROOT))
    expect(dom.exclude, where + "the dom project's `exclude` is the node project's `include`, the same list: a " +
      'file in one and not the other runs in both projects or in neither').toEqual(node.include)
    // A project with `extends: true` inherits the root `test` block and arrays concatenate: a setupFiles beside the
    // projects would load in the node project too, where src/__tests__/setup.ts throws on its first afterEach.
    expect(Object.keys(test).sort(), where + 'beside `projects` the `test` block holds these keys and no others, ' +
      'which both projects inherit. `environment` and `setupFiles` live inside the projects, never beside them: ' +
      'beside them they reach the node project too. A key added here reaches both projects.' + change)
      .toEqual([...BESIDE, 'projects'].sort())
  })
})

describe('the projects, asked of the installed vitest', () => {
  let walked, on, tree, inNode

  beforeAll(() => {
    walked = new Set(walk())
    on = list()
    inNode = sorted(on.filter((entry) => entry.project === 'node').map((entry) => entry.file))
    tree = repository(Object.fromEntries(Object.entries(config().alias)
      .map(([specifier, path]) => [specifier, posix(relative(ROOT, path))])))
  }, 300000)

  it('is two projects, dom and node', () => {
    expect(projectsOf(on), 'the installed vitest must list the projects dom and node; with anything else the ' +
      'projects in vitest.config.ts are gone or have grown one nothing here accounts for').toEqual(['dom', 'node'])
  })

  it('puts every test file outside tests/integration in exactly one project', () => {
    const projectsByFile = new Map()
    for (const { file, project } of on) projectsByFile.set(file, [...(projectsByFile.get(file) || []), project])
    const problems = []
    for (const file of sorted([...walked, ...projectsByFile.keys()])) {
      const projects = projectsByFile.get(file) || []
      if (!walked.has(file)) {
        problems.push(`vitest projects: ${file} is collected, and the walk in ` +
          'scripts/vitest/vitest-projects.test.js does not reach it: bring SKIPPED_DIRS / SKIPPED_PATHS there ' +
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

  it(`makes the node project exactly the files under ${ROOTS_SAID} that are not in LOADS_SRC`, () => {
    expect(ROOTS_OF_THE_CONFIG.map((root) => `${root}/`), 'NODE_ROOTS in scripts/vitest/vitest-node-project.mjs ' +
      'and NODE_ROOTS in scripts/vitest/vitest-projects.test.js name the same roots: change both in one ' +
      'commit').toEqual(NODE_ROOTS)
    const kept = new Set(LOADS_SRC)
    const problems = on
      .filter(({ file, project }) => (project === 'node') !== (underNodeRoot(file) && !kept.has(file)))
      .map(({ file, project }) => `vitest projects: ${file} runs in '${project}'. 'node' takes the *.test.* files ` +
        `under ${ROOTS_SAID} that are not in ${LIST}, and no others; 'dom' takes the rest. A *.spec.* file under a ` +
        'node root is not picked by NODE_TEST_NAMED: rename the file. A name with a glob character in it ([, (, *) ' +
        'matches nothing when vitest reads the list: rename the file. Otherwise fix nodeProjectFiles() in ' +
        'scripts/vitest/vitest-node-project.mjs, or move the file. If the roots themselves are meant to ' +
        'change, change NODE_ROOTS there and in scripts/vitest/vitest-projects.test.js in the same commit.')
    expect(problems, problems.join('\n')).toEqual([])
    for (const root of NODE_ROOTS) {
      const any = on.some(({ file, project }) => project === 'node' && file.startsWith(root))
      expect(any, `the node project holds no file under ${root}`).toBe(true)
    }
    expect(on.some(({ project }) => project === 'dom')).toBe(true)
  })

  it('finds no node-project file that picks its own environment by docblock', () => {
    const problems = []
    for (const file of inNode) {
      readFileSync(resolve(ROOT, file), 'utf8').split('\n').forEach((line, index) => {
        const hit = line.match(ENV_DOCBLOCK)
        if (hit) {
          problems.push(`${file}:${index + 1} names ${hit[0]}, and this file runs in vitest's node project, where ` +
            "the docblock overrides the project's environment: the file would run with a DOM and without " +
            'src/__tests__/setup.ts. Move the test under src/__tests__/ (the dom project), or take the docblock out. ' +
            "If the line is prose, split the token ('@vitest' + '-environment').")
        }
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
        `'${file}' to ${LIST} (kept sorted): it then runs in 'dom', with jsdom and src/__tests__/setup.ts, like ` +
        'every test of SPA code. Or take the src/ dependency out of the test. The scan reads text: an ' +
        'import-shaped line inside a comment or a string counts, so reword that or split the token.')
    }
    expect(problems, problems.join('\n')).toEqual([])
    const gaps = sorted(unfollowed)
    expect(gaps, 'vitest projects: the import scan of scripts/vitest/vitest-projects.test.js cannot follow ' +
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
    const collected = new Set(on.map((entry) => entry.file))
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
    // The node project picks its files by the same ending, *.test.* only: a wider one has it collect a file that
    // vitest's own include never would, and a file that is not a test runs as one.
    expect(others.filter((name) => NODE_TEST_NAMED.test(name))).toEqual([])
    expect(['a.test.js', 'a.int.test.mjs', 'a.test.tsx', 'a.spec.js'].map((name) => NODE_TEST_NAMED.test(name)))
      .toEqual([true, true, true, false])
  })
})

describe('what counts as an environment docblock', () => {
  const tag = (tool) => '@' + tool + '-environment'

  it('is either spelling, in a block comment or a line comment, with or without a value', () => {
    const lines = [`/** ${tag('vitest')} jsdom */`, ` * ${tag('vitest')} happy-dom`, `// ${tag('jest')} jsdom`,
      `/* ${tag('vitest')} */`]
    expect(lines.filter((line) => !ENV_DOCBLOCK.test(line))).toEqual([])
  })

  it('is not the words around it', () => {
    const lines = ['@vitest/coverage-v8', "environment: 'node'", '@vitest-environments-guide', 'vitest environment']
    expect(lines.filter((line) => ENV_DOCBLOCK.test(line))).toEqual([])
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
