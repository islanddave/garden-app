#!/usr/bin/env node
// Keeps the hand-copied Lambda helpers byte-identical to their masters. A function zip holds only its own folder
// (scripts/package-lambda.sh), so a shared helper ships as a committed copy in every folder that imports it.
// scripts/lambda-copies.json lists master -> copies. Copies carry no header: they are the master's bytes.
//
//   --check (default)  Reads the working tree and writes nothing. Exit 1, naming each problem, when a listed copy
//                      is missing or differs from its master, or a lambda/<fn>/ file has a master's file name but
//                      is not listed. Asserted in lambda/crop-derive-copies-sync.test.js; the GUARD
//                      lambda/*-copies-sync.test.js files check the same copies on their own and stay.
//   --write            Copies each master as committed (the HEAD blob, never the working tree) over a copy only
//                      when that copy equals some committed version of the master: it was in sync and only the
//                      master moved. Any other difference is drift for a human to resolve; it then exits 1 and
//                      writes no file at all, because every copy is checked before any is written.
//
// After any rebase run --check, never --write: --write would lay this branch's master over dev's copies and hide
// a conflict a human must see. Never run at deploy time; it is deliberately not a redeploy input
// (scripts/check-lambda-current.py PATHS). Behaviour tests: scripts/gen-lambda-copies.test.js.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = 'scripts/lambda-copies.json'
const COPY_PATH = /^lambda\/[^/]+\/[^/]+$/

const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel)) : null)
const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] })
// Git's object id for these bytes. Valid because the repo has no .gitattributes, so no clean filter rewrites a blob.
const blobId = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')

function loadManifest() {
  const { copies } = JSON.parse(readFileSync(join(ROOT, MANIFEST), 'utf8'))
  const entries = Object.entries(copies).filter(([master]) => !master.startsWith('_'))
  const problems = entries.length ? [] : [`${MANIFEST}: lists no master`]
  const seen = new Set(entries.map(([master]) => master))
  for (const [master, list] of entries) {
    for (const copy of list) {
      if (!COPY_PATH.test(copy) || basename(copy) !== basename(master)) {
        problems.push(`${MANIFEST}: ${copy} is not of the form lambda/<fn>/${basename(master)}`)
      }
      if (seen.has(copy)) problems.push(`${MANIFEST}: ${copy} is listed twice`)
      seen.add(copy)
    }
  }
  return { entries, problems }
}

// A copy nobody listed is never compared, so it can drift in a green suite: every lambda/<fn>/ file named like
// a master must be the master itself or a listed copy.
function unlistedCopies(entries) {
  const listed = new Set(entries.flatMap(([master, list]) => [master, ...list]))
  const names = [...new Set(entries.map(([master]) => basename(master)))]
  const problems = []
  for (const dir of readdirSync(join(ROOT, 'lambda'), { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name === 'node_modules') continue
    for (const name of names) {
      const rel = `lambda/${dir.name}/${name}`
      if (!listed.has(rel) && existsSync(join(ROOT, rel))) {
        problems.push(`${rel}: named like a master but not listed in ${MANIFEST}`)
      }
    }
  }
  return problems
}

function check() {
  const { entries, problems } = loadManifest()
  let checked = 0
  for (const [master, list] of entries) {
    const want = read(master)
    if (!want) {
      problems.push(`${master}: master is missing`)
      continue
    }
    for (const copy of list) {
      checked += 1
      const got = read(copy)
      if (!got) problems.push(`${copy}: missing (a listed copy of ${master})`)
      else if (!got.equals(want)) problems.push(`${copy}: differs from its master ${master}`)
    }
  }
  problems.push(...unlistedCopies(entries))
  return { problems, summary: `checked ${checked} copies of ${entries.length} masters` }
}

function committedVersions(master) {
  // --raw lines read ":<mode> <mode> <old blob> <new blob> <status>\t<path>"; field 3 is the version committed.
  const raw = git('log', '--no-abbrev', '--format=', '--raw', 'HEAD', '--', master).toString()
  return new Set(raw.split('\n').map((line) => line.split(/\s+/)[3]).filter(Boolean))
}

function write() {
  const { entries, problems } = loadManifest()
  problems.push(...unlistedCopies(entries))
  const updates = []
  for (const [master, list] of entries) {
    let head
    try {
      head = git('show', `HEAD:${master}`)
    } catch {
      problems.push(`${master}: master is not committed at HEAD`)
      continue
    }
    const work = read(master)
    if (!work || !work.equals(head)) {
      problems.push(`${master}: working tree differs from HEAD; commit the master first (--write copies only the committed master)`)
      continue
    }
    const versions = committedVersions(master)
    for (const copy of list) {
      const got = read(copy)
      if (!got) problems.push(`${copy}: missing; create it from ${master} by hand and review it`)
      else if (got.equals(head)) continue
      else if (versions.has(blobId(got))) updates.push([copy, head])
      else problems.push(`${copy}: drifted (matches no committed version of ${master}); resolve it by hand`)
    }
  }
  if (problems.length) return { problems, summary: 'wrote nothing' }
  for (const [copy, bytes] of updates) writeFileSync(join(ROOT, copy), bytes)
  return { problems, summary: `updated ${updates.length} copies${updates.map(([copy]) => `\n  ${copy}`).join('')}` }
}

const args = process.argv.slice(2)
const mode = args.length === 0 ? '--check' : args[0]
if (args.length > 1 || !['--check', '--write'].includes(mode)) {
  process.stderr.write('usage: node scripts/gen-lambda-copies.mjs [--check|--write]\n')
  process.exit(2)
}
const { problems, summary } = mode === '--write' ? write() : check()
if (problems.length) {
  process.stderr.write(`gen-lambda-copies ${mode}: ${problems.length} problem(s), ${summary}\n${problems.map((p) => `  ${p}\n`).join('')}`)
  process.exit(1)
}
process.stdout.write(`gen-lambda-copies ${mode}: ${summary}\n`)
