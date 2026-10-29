// new-file: new subject: the comment-only checker
// A false accept (code change waved through as "just comments") is the failure that matters. POISON pairs must be
// refused; ACCEPT pairs must pass (else a checker that refuses everything looks perfect). Cases are
// `<name>.old.<ext>` / `<name>.new.<ext>` under scripts/fixtures/check-comment-only/{poison,accept}.
import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareFile } from './check-comment-only.mjs'

const ROOT = process.cwd()
const TOOL = join(ROOT, 'scripts', 'check-comment-only.mjs')
const CORPUS = join(ROOT, 'scripts', 'fixtures', 'check-comment-only')

function pairs(kind) {
  const dir = join(CORPUS, kind)
  const files = readdirSync(dir)
  return files
    .filter((f) => f.includes('.old.'))
    .sort()
    .map((oldName) => {
      const newName = oldName.replace('.old.', '.new.')
      expect(files, `${kind}/${oldName} has no ${newName}`).toContain(newName)
      return { name: oldName.replace('.old.', '.'), oldPath: join(dir, oldName), newPath: join(dir, newName) }
    })
}

// Shell files and YAML run: bodies need shfmt on PATH: every ci.yml unit leg installs it, and a run without it
// fails those cases rather than skipping them.
const run = (args, opts = {}) =>
  spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', ...opts })

// Names the corpus must keep. Deleting a case to make a failing checker green fails here instead.
const REQUIRED_POISON = [
  'string-slashes.js',
  'regex-slashes.js',
  'jsx-inline-text.jsx',
  'sql-dashes.js',
  'shebang-deleted.mjs',
  'eslint-disable-deleted.js',
  'hidden-code-change.js',
  'yaml-run-code.yml',
]
const REQUIRED_ACCEPT = [
  'jsx-container-own-line.jsx',
  'trailing-line-comment.js',
  'block-comment.js',
  'typescript-types.ts',
  'yaml-comment-outside-run.yml',
  'shell-comment-line.sh',
  'yaml-expression-unchanged.yml',
]

describe('check-comment-only corpora', () => {
  const poison = pairs('poison')
  const accept = pairs('accept')

  it('keeps the required cases', () => {
    expect(poison.map((p) => p.name)).toEqual(expect.arrayContaining(REQUIRED_POISON))
    expect(accept.map((p) => p.name)).toEqual(expect.arrayContaining(REQUIRED_ACCEPT))
  })

  it.for(poison.map((p) => [p.name, p]))('refuses poison: %s', ([_n, p]) => {
    const r = compareFile(p.newPath, readFileSync(p.oldPath, 'utf8'), readFileSync(p.newPath, 'utf8'))
    expect(r.ok, `${p.name} was accepted`).toBe(false)
    expect(r.reason).toBeTruthy()
  })

  it.for(accept.map((p) => [p.name, p]))('accepts comment-only edit: %s', ([_n, p]) => {
    const r = compareFile(p.newPath, readFileSync(p.oldPath, 'utf8'), readFileSync(p.newPath, 'utf8'))
    expect(r, `${p.name}: ${r.reason}`).toEqual({ ok: true })
  })

  const fixtureFiles = [...poison, ...accept].flatMap((p) => [p.oldPath, p.newPath]).filter((f) => !f.endsWith('.py'))
  // The .py case is refused even against itself (unknown type), so it is left out here.
  it.for(fixtureFiles.map((f) => [f.slice(CORPUS.length + 1), f]))('accepts fixture against itself: %s', ([_n, path]) => {
    const text = readFileSync(path, 'utf8')
    expect(compareFile(path, text, text), path).toEqual({ ok: true })
  })
})

describe('check-comment-only refusals name the cause', () => {
  const reason = (name) => {
    const p = pairs('poison').find((x) => x.name === name)
    return compareFile(p.newPath, readFileSync(p.oldPath, 'utf8'), readFileSync(p.newPath, 'utf8')).reason
  }
  it('flags directives as directives, not as code', () => {
    expect(reason('eslint-disable-deleted.js')).toMatch(/directive comment changed/)
    expect(reason('shebang-deleted.mjs')).toMatch(/directive comment changed/)
    expect(reason('eslint-disable-moved.js')).toMatch(/directive comment changed/)
  })
  it('fails closed on unknown types and parse errors', () => {
    expect(reason('unknown-type.py')).toMatch(/unknown file type/)
    expect(compareFile('x.js', 'const a = 1 // ok', 'const a = = 1').reason).toMatch(/cannot parse/)
  })
})

describe('check-comment-only CLI', () => {
  it('exits 0 for an accepted pair and 1 for a refused pair', () => {
    const ok = pairs('accept').find((p) => p.name === 'block-comment.js')
    const bad = pairs('poison').find((p) => p.name === 'hidden-code-change.js')
    expect(run([ok.oldPath, ok.newPath]).status).toBe(0)
    const r = run([bad.oldPath, bad.newPath])
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/REFUSE/)
  })

  it('aborts with exit 2 and a clear message when shfmt is missing', () => {
    const p = pairs('accept').find((x) => x.name === 'shell-comment-line.sh')
    const r = run([p.oldPath, p.newPath], { env: { PATH: '/nonexistent' } })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/shfmt not found/)
  })

  it('--git compares each path at REV with the working tree and fails on any refusal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cco-git-'))
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' })
    git('init', '-q')
    git('config', 'user.email', 't@example.com')
    git('config', 'user.name', 't')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(join(dir, 'a.js'), '// note\nconst a = 1\n')
    writeFileSync(join(dir, 'b.js'), '// note\nconst b = 1\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    writeFileSync(join(dir, 'a.js'), 'const a = 1\n')
    const clean = run(['--git', 'HEAD', 'a.js'], { cwd: dir })
    expect(clean.status).toBe(0)
    writeFileSync(join(dir, 'b.js'), 'const b = 2\n')
    const mixed = run(['--git', 'HEAD', 'a.js', 'b.js'], { cwd: dir })
    expect(mixed.status).toBe(1)
    expect(mixed.stdout).toMatch(/OK +a\.js/)
    expect(mixed.stdout).toMatch(/REFUSE +b\.js/)
    const added = run(['--git', 'HEAD', 'missing.js'], { cwd: dir })
    expect(added.status).toBe(1)
  })

  it('--report counts dated, ticket, history lines and blocks over 3 lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cco-report-'))
    const f = join(dir, 'r.js')
    writeFileSync(
      f,
      [
        '// fixed on 2026-10-12',
        'const a = 1 // OPS-FOO-001 follows',
        '// this used to differ',
        '// one',
        '// two',
        '// three',
        '// four',
        'const b = 2',
        '/* clean */',
        '',
      ].join('\n'),
    )
    const r = run(['--report', f])
    expect(r.status).toBe(0)
    const row = r.stdout.split('\n').find((l) => l.startsWith(f)).split('\t')
    // comment_lines dated ticket history flagged blocks_over_3
    expect(row.slice(1)).toEqual(['8', '1', '1', '1', '3', '1'])
  })

  it('--readers lists files that read the target as text, not mere mentions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cco-readers-'))
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' })
    git('init', '-q')
    mkdirSync(join(dir, 'scripts'))
    writeFileSync(join(dir, 'scripts', 'target.mjs'), 'export const x = 1\n')
    writeFileSync(
      join(dir, 'scripts', 'reads.test.js'),
      "import { readFileSync } from 'node:fs'\nconst s = readFileSync('scripts/target.mjs', 'utf8')\n",
    )
    writeFileSync(join(dir, 'scripts', 'mentions.test.js'), '// target.mjs is documented elsewhere\nexport const y = 2\n')
    git('add', '.')
    const r = run(['--readers', join(dir, 'scripts', 'target.mjs')], { cwd: dir })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/near\tscripts\/reads\.test\.js/)
    expect(r.stdout).not.toMatch(/mentions\.test\.js/)
  })
})
