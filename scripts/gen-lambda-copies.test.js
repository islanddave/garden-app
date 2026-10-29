// new-file: new subject, scripts/gen-lambda-copies.mjs
// OPS-CODEREVIEW-001 D1: the generator on throwaway git repos. --check reds on every poison; --write updates
// copies that were in sync when only the committed master moved, and on any drift refuses and writes nothing.
// Trap: the generator finds its repo from its own path, so each repo gets its own copy of the script.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, unlinkSync, appendFileSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GEN = join(dirname(fileURLToPath(import.meta.url)), 'gen-lambda-copies.mjs')
const V1 = 'export const v = 1\n'
const V2 = 'export const v = 2\n'
const repos = []

const git = (repo, ...args) =>
  execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { stdio: 'pipe' })

// lambda/a.js is the master; lambda/f1/a.js and lambda/f2/a.js are its listed copies, all committed at V1.
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'gen-lambda-copies-'))
  repos.push(repo)
  for (const d of ['scripts', 'lambda/f1', 'lambda/f2', 'lambda/f3']) mkdirSync(join(repo, d), { recursive: true })
  copyFileSync(GEN, join(repo, 'scripts', 'gen-lambda-copies.mjs'))
  writeFileSync(join(repo, 'scripts', 'lambda-copies.json'),
    JSON.stringify({ copies: { 'lambda/a.js': ['lambda/f1/a.js', 'lambda/f2/a.js'] } }))
  for (const f of ['lambda/a.js', 'lambda/f1/a.js', 'lambda/f2/a.js']) writeFileSync(join(repo, f), V1)
  git(repo, 'init', '-q')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'v1')
  return repo
}

const run = (repo, ...args) =>
  spawnSync(process.execPath, [join(repo, 'scripts', 'gen-lambda-copies.mjs'), ...args], { encoding: 'utf8' })
const text = (repo, f) => readFileSync(join(repo, f), 'utf8')

afterEach(() => {
  while (repos.length) rmSync(repos.pop(), { recursive: true, force: true })
})

describe('gen-lambda-copies --check', () => {
  it('OPS-CODEREVIEW-001 D1: passes on an in-sync tree and writes nothing', () => {
    const repo = makeRepo()
    const r = run(repo, '--check')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('checked 2 copies of 1 masters')
    expect(git(repo, 'status', '--porcelain').toString()).toBe('')
  })

  it.each([
    ['a copy differs', (repo) => appendFileSync(join(repo, 'lambda/f2/a.js'), ' '), 'lambda/f2/a.js: differs'],
    ['a listed copy is missing', (repo) => unlinkSync(join(repo, 'lambda/f1/a.js')), 'lambda/f1/a.js: missing'],
    ['an unlisted copy exists', (repo) => writeFileSync(join(repo, 'lambda/f3/a.js'), V1), 'lambda/f3/a.js: named like a master but not listed'],
    ['only the master moved', (repo) => writeFileSync(join(repo, 'lambda/a.js'), V2), 'lambda/f1/a.js: differs'],
  ])('OPS-CODEREVIEW-001 D1: exits 1 naming the file when %s', (_name, poison, problem) => {
    const repo = makeRepo()
    poison(repo)
    const r = run(repo)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(problem)
  })
})

describe('gen-lambda-copies --write', () => {
  it('OPS-CODEREVIEW-001 D1: after a committed master edit, in-sync copies take the new master', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'lambda/a.js'), V2)
    git(repo, 'commit', '-q', '-am', 'v2')
    const r = run(repo, '--write')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('updated 2 copies')
    expect([text(repo, 'lambda/f1/a.js'), text(repo, 'lambda/f2/a.js')]).toEqual([V2, V2])
    expect(run(repo, '--check').status).toBe(0)
  })

  it('OPS-CODEREVIEW-001 D1: a hand-edited copy is drift: exits 1 and changes no file, not even the updatable copy', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'lambda/a.js'), V2)
    git(repo, 'commit', '-q', '-am', 'v2')
    writeFileSync(join(repo, 'lambda/f2/a.js'), 'export const v = 99\n')
    const r = run(repo, '--write')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('lambda/f2/a.js: drifted')
    expect([text(repo, 'lambda/f1/a.js'), text(repo, 'lambda/f2/a.js')]).toEqual([V1, 'export const v = 99\n'])
  })

  it('OPS-CODEREVIEW-001 D1: an uncommitted master edit is refused, never copied', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'lambda/a.js'), V2)
    const r = run(repo, '--write')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('lambda/a.js: working tree differs from HEAD')
    expect([text(repo, 'lambda/f1/a.js'), text(repo, 'lambda/f2/a.js')]).toEqual([V1, V1])
  })
})
