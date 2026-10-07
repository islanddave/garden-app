// The two vitest projects of the A3 trial (vitest.config.ts, VITEST_NODE_PROJECT=1), held to the tree.
//
// With the key set the unit suite runs as two projects: `node` takes the test files under lambda/, scripts/,
// migrations/ and tests/parity/ and runs them with no jsdom and no src/__tests__/setup.ts; `dom` takes every other
// file as before. Without the key there is one project and every file gets jsdom. Only ci-next.yml's two unit legs
// set the key, so each dev push compares the two shapes by test ID (scripts/ci-telemetry/shadow-agree.py).
//
// This file is collected in both shapes, so it runs in the gating job and in the legs, and it holds four things:
//   1. the switch takes. With the key this file has no DOM, without it it has one, and the installed vitest lists
//      two projects or one to match. A leg whose key did nothing would run jsdom-everything like ci.yml and read
//      TEST-IDS-EQUAL for the wrong reason;
//   2. every test-named file outside tests/integration is in exactly one project, and the two shapes collect the
//      same files. A file in no project is never run; a file in two runs twice and doubles its test IDs;
//   3. the node project is exactly the files under its four roots;
//   4. no file under those roots reaches for the DOM, so a DOM test dropped under scripts/ or lambda/ reds the
//      gating job with a sentence instead of redding only the shadow.
// It asks the installed vitest which project each file is in (`vitest list --filesOnly --json` in a child process,
// as vitest-test-ids-reporter.test.js asks it for its default reporters) and does not re-implement its globs.
// 4 reads text, so it has false positives (a local named like a browser global) and misses (a DOM reached through
// an imported helper, or by a spelling it does not know). It is gating during the trial for one reason: without it a
// DOM test dropped under a node root reds only the legs, reads DISAGREE, and blocks the shadow's 10-push window,
// which costs far more than the rename it asks for.
// When the trial ends and the projects are unconditional, 1 loses its "without the key" half and 4 goes: from then
// on such a file fails by itself in every run (`document is not defined`) and the scan would keep only its false
// positives. 2 and 3 stay.
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const ROOT = process.cwd()
const KEY = 'VITEST_NODE_PROJECT'
const NODE_ROOTS = ['lambda/', 'scripts/', 'migrations/', 'tests/parity/']
const ROOTS_SAID = 'lambda/, scripts/, migrations/ and tests/parity/'
// A test file as vitest's own default `include` has it (**/*.{test,spec}.?(c|m)[jt]s?(x)), and nothing wider: a
// snapshot (x.test.jsx.snap) or a parked draft (x.int.test.js.txt) is named like a test and is not one. NODE_GLOBS
// in vitest.config.ts ends the same way, so neither shape collects such a file and neither does this walk.
const TEST_NAMED = /\.(?:test|spec)\.[cm]?[jt]sx?$/
// What the walk leaves out, which is what the config's `exclude` leaves out: vitest's own defaults (node_modules,
// .git), tests/integration and agent worktrees under .claude; plus coverage/ and dist/, which are build output.
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.claude', 'coverage', 'dist'])
const SKIPPED_PATHS = new Set(['tests/integration'])

const posix = (path) => path.split(sep).join('/')
const underNodeRoot = (file) => NODE_ROOTS.some((root) => file.startsWith(root))

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

// A line that reaches for the DOM: a property read off one of the browser's globals, a stub of one, a
// testing-library import, or an environment docblock. Read as text, so a member that merely shares a name
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

describe('the switch (VITEST_NODE_PROJECT)', () => {
  it('gives this file a DOM exactly when the key is not 1', () => {
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
  })

  it('keeps environment and setupFiles inside the fork, the same for dom as with the key unset', () => {
    // A project with `extends: true` inherits the root `test` block and arrays concatenate: a setupFiles beside the
    // fork would load in the node project too, where src/__tests__/setup.ts throws on its first afterEach.
    // Read without its comment lines, so prose that quotes one of these forms is not counted.
    const config = readFileSync(resolve(ROOT, 'vitest.config.ts'), 'utf8')
      .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
    const where = 'vitest.config.ts, the fork on the key: '
    expect(config.match(/process\.env\.VITEST_NODE_PROJECT === '1'/g), where + 'the key is read once, as ' +
      "`process.env.VITEST_NODE_PROJECT === '1'`").toHaveLength(1)
    const setups = [...config.matchAll(/setupFiles: (\[[^\]]*\])/g)].map((found) => found[1])
    expect(setups, where + '`setupFiles` is written twice, both inside it (the dom project and the key-unset ' +
      'branch), never beside it').toHaveLength(2)
    expect(setups[0], where + 'the dom project loads the setup files the key-unset branch loads').toBe(setups[1])
    const environments = [...config.matchAll(/environment: '([a-z-]+)'/g)].map((found) => found[1])
    expect(environments, where + 'the environments are dom jsdom, node node, and jsdom with the key unset')
      .toEqual(['jsdom', 'node', 'jsdom'])
    expect(config, where + "NODE_GLOBS is the four roots with vitest's own test-file extension. A wider one " +
      '(`*.test.*`) has the node project collect files the one-project run never does')
      .toContain("const NODE_EXT = '?(c|m)[jt]s?(x)';\n" +
        "const NODE_GLOBS = ['lambda', 'scripts', 'migrations', 'tests/parity'].map((root) => `${root}/**/*.test.${NODE_EXT}`);")
    // The two projects whole. Their test IDs cannot see an option that changes what the files mean (isolate, pool,
    // sequence, globals, a timeout of the node project's own), so a project that gains one reds here instead.
    for (const project of [
      "{ extends: true, test: { name: 'dom', environment: 'jsdom', setupFiles: ['./src/__tests__/setup.ts'], exclude: NODE_GLOBS } },",
      "{ extends: true, test: { name: 'node', environment: 'node', include: NODE_GLOBS } },",
    ]) {
      expect(config, where + 'each project is this line and no more. An option added to one changes what its ' +
        'files run under while every test ID stays equal: change it here in the same commit, and restart the ' +
        `shadow's count (.github/workflows/ci-next.yml, THE A3 TRIAL). Want: ${project}`).toContain(project)
    }
  })
})

describe('the projects, asked of the installed vitest', () => {
  let walked, on, off

  beforeAll(() => {
    walked = new Set(walk())
    on = list(true)
    off = list(false)
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
          "exactly one. 'node' takes lambda/**, scripts/**, migrations/** and tests/parity/**: no DOM and no " +
          "src/__tests__/setup.ts. 'dom' takes everything else. A file in no project is never run; a file in two " +
          'runs twice and doubles its test IDs. Fix NODE_GLOBS in vitest.config.ts, or move the file.')
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
      "Fix NODE_GLOBS, or a project's include / exclude, in vitest.config.ts.").toEqual({ missing: [], extra: [] })
  })

  it(`makes the node project exactly the files under ${ROOTS_SAID}`, () => {
    const problems = on
      .filter(({ file, project }) => (project === 'node') !== underNodeRoot(file))
      .map(({ file, project }) => `vitest projects: ${file} runs in '${project}'. 'node' takes the test files ` +
        `under ${ROOTS_SAID} and no others; 'dom' takes the rest. Fix NODE_GLOBS in vitest.config.ts (a *.spec.* ` +
        'file under a node root is outside its *.test.* globs: rename the file), or move the file. If the roots ' +
        'themselves are meant to change, change NODE_ROOTS in scripts/ci-telemetry/vitest-projects.test.js in the ' +
        'same commit.')
    expect(problems, problems.join('\n')).toEqual([])
    for (const root of NODE_ROOTS) {
      const any = on.some(({ file, project }) => project === 'node' && file.startsWith(root))
      expect(any, `the node project holds no file under ${root}`).toBe(true)
    }
    expect(on.some(({ project }) => project === 'dom')).toBe(true)
  })

  it('finds no file under the node roots that uses the DOM', () => {
    const files = sorted(off.map((entry) => entry.file).filter(underNodeRoot))
    const problems = []
    for (const file of files) {
      readFileSync(resolve(ROOT, file), 'utf8').split('\n').forEach((line, index) => {
        const token = domUse(line)
        if (token === null) return
        problems.push(`${file}:${index + 1} uses ${token}, and files under ${ROOTS_SAID} run without a DOM in ` +
          "vitest's node project (ci-next.yml's unit legs during the A3 trial; every run after it). Move the test " +
          'under src/__tests__/ (the dom project), or take the DOM out of it. The check reads text, not scope: if ' +
          "that name is a local of the test's own, rename the local.")
      })
    }
    expect(problems, problems.join('\n')).toEqual([])
    expect(files.length).toBeGreaterThan(100)
  })
})

describe('what counts as a test file', () => {
  it("is vitest's own *.test.* / *.spec.* with a js or ts extension, as the walk reads the tree", () => {
    const named = ['a.test.js', 'a.test.jsx', 'a.spec.ts', 'a.spec.tsx', 'a.test.mjs', 'a.test.cjs', 'a.test.mts',
      'a.int.test.js', 'household-columns.test.js']
    expect(named.filter((name) => !TEST_NAMED.test(name))).toEqual([])
  })

  it('is not a file merely named like one, which vitest never collects', () => {
    // Each of these would otherwise red the gating pass as "collected by 0 project(s)" and blame NODE_GLOBS.
    // The first is a name this repo has carried (migrations/v4-parentprojfk-001, 2026-08-13).
    const others = ['PROPOSED-TEST-parent-proj-fk.int.test.js.txt', 'a.test.jsx.snap', 'a.test.js.orig',
      'a.test.json', 'a.test.md', 'a.spec.yaml', 'a.test.js~', 'test.js', 'a.tests.js', 'atest.js']
    expect(others.filter((name) => TEST_NAMED.test(name))).toEqual([])
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
