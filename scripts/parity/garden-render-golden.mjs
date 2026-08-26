#!/usr/bin/env node
// V4-GARDENIA-001 / DESIGNSYS Pass A §7 — the Garden-render golden guard.
//
//   node scripts/parity/garden-render-golden.mjs           # npm run parity:garden-render
//   node scripts/parity/garden-render-golden.mjs --update  # reseed after an INTENTIONAL change
//
// ASSERTS: the legacy by-project Garden render — buildDisplayList + buildGardenTree, which is
// GroupByControl's `none` path — still reproduces the behaviour captured at prod v2.16.0,
// before the buildTagGroupedList rewrite. Contract §3 names this as GroupByControl's
// regression oracle and §7 requires it green in CI.
//
// WHY THIS FILE EXISTS AT ALL. The oracle was real but unrunnable: golden-harness.mjs and
// garden-render-golden-20260624.json lived in the gardening-docs repo, so garden-app CI could
// not reach them, and the docs harness hardcoded a Cowork sandbox path
// (/sessions/<slug>/mnt/...) for both its import and its output. It was also WRITE-ONLY — no
// --check mode — so it could only ever reseed the baseline, never fail on drift. Meanwhile
// projectTree.js carried a comment asserting the code "remain[s] golden-gated to parity hash
// 8a3d78f0", which nothing executed. A comment claiming a gate that does not exist is worse
// than no comment: it retires the question. The harness is vendored here, given a real check
// mode, and wired into ci.yml.
//
// The golden and fixture are copies of the docs-repo artifacts, byte-identical at vendoring
// (2026-08-26); the docs originals stay as the historical record of how they were captured.
//
// WHAT IT CANNOT SEE: this is a pure behaviour hash over grouping and ORDER — ids, names,
// depth and placement. It says nothing about rendering, styling or tokens. It is the guard
// for "the by-project tree still comes out in the same shape", not for "the Garden looks the
// same".
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  buildDisplayList, buildGardenTree, groupPlantingsByProjectId, SORT_ALPHA, SORT_RECENCY,
} from '../../src/lib/projectTree.js'

const HERE = fileURLToPath(new URL('./garden-render/', import.meta.url))
const FIXTURE = HERE + 'fixture-20260624.json'
const GOLDEN = HERE + 'golden-20260624.json'
const update = process.argv.includes('--update')

const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'))
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
const P = fx.projects
const PL = fx.plants

// Slimming shapes are lifted verbatim from the original harness — change either and the hash
// changes for a reason that has nothing to do with the code under test.
const slimDL = list => list.map(({ project, depth }) => ({ id: project.id, name: project.name, depth }))
const slimTree = nodes => nodes.map(n => ({
  id: n.project.id, name: n.project.name, depth: n.depth,
  plantings: n.plantings.map(p => ({ id: p.id, name: p.name })), children: slimTree(n.children),
}))

const arms = {
  displayList_alpha: slimDL(buildDisplayList(P, SORT_ALPHA)),
  displayList_recency: slimDL(buildDisplayList(P, SORT_RECENCY)),
  gardenTree_alpha: slimTree(buildGardenTree(P, PL, SORT_ALPHA)),
  gardenTree_recency: slimTree(buildGardenTree(P, PL, SORT_RECENCY)),
}
const ORDER = ['displayList_alpha', 'displayList_recency', 'gardenTree_alpha', 'gardenTree_recency']
const hash = createHash('sha256').update(JSON.stringify(ORDER.map(k => arms[k]))).digest('hex').slice(0, 16)

const placed = (function count(ns) { return ns.reduce((a, n) => a + n.plantings.length + count(n.children), 0) })(arms.gardenTree_alpha)
const invariants = {
  displayList_covers_all_projects: arms.displayList_alpha.length === P.length,
  tree_places_all_non_null_plantings:
    placed === PL.filter(p => p.project_id != null && P.some(x => x.id === p.project_id)).length,
  plantings_placed: placed,
  distinct_project_keys_with_plantings: Object.keys(groupPlantingsByProjectId(PL)).length,
  max_depth: Math.max(...arms.displayList_alpha.map(r => r.depth)),
}

if (update) {
  const next = { ...golden, ...arms, invariants, _meta: { ...golden._meta, parity_hash: hash, reseeded: new Date().toISOString().slice(0, 10) } }
  writeFileSync(GOLDEN, JSON.stringify(next, null, 1))
  console.log(`[garden-render-golden] reseeded — parity_hash ${golden._meta.parity_hash} -> ${hash}`)
  console.log('[garden-render-golden] REVIEW THE DIFF: a reseed accepts whatever the code now does.')
  process.exit(0)
}

// Report the per-arm diff BEFORE the hash verdict. A bare hash mismatch tells you something
// moved and nothing about what, which on a 61-project / 171-planting fixture is not a
// debuggable signal.
let bad = 0
for (const k of ORDER) {
  if (JSON.stringify(arms[k]) === JSON.stringify(golden[k])) {
    console.log(`ok  ${k} (${arms[k].length} rows)`)
    continue
  }
  bad++
  console.error(`DRIFT ${k}: golden ${golden[k].length} rows, current ${arms[k].length} rows`)
  const g = JSON.stringify(golden[k], null, 1).split('\n')
  const c = JSON.stringify(arms[k], null, 1).split('\n')
  for (let i = 0, shown = 0; i < Math.max(g.length, c.length) && shown < 6; i++) {
    if (g[i] === c[i]) continue
    console.error(`  line ${i + 1}\n    golden : ${g[i] ?? '<absent>'}\n    current: ${c[i] ?? '<absent>'}`)
    shown++
  }
}
for (const [k, v] of Object.entries(invariants)) {
  if (golden.invariants[k] !== v) { console.error(`DRIFT invariant ${k}: golden ${golden.invariants[k]}, current ${v}`); bad++ }
}
if (hash !== golden._meta.parity_hash) {
  console.error(`DRIFT parity_hash: golden ${golden._meta.parity_hash}, current ${hash}`)
  bad++
}
if (bad) {
  console.error(`\n${bad} drift(s). The legacy by-project Garden render changed shape or order.`)
  console.error('If that is INTENTIONAL, rerun with --update and review the golden diff in the same commit.')
  process.exit(1)
}
console.log(`[garden-render-golden] PASS — parity_hash ${hash}, ${invariants.plantings_placed} plantings placed across ${P.length} projects`)
