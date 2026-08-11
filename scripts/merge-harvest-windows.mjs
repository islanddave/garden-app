#!/usr/bin/env node
// V4-RIPENESSCUES-001 — merge sourced colour-window research batches into src/data/harvestWindows.json.
//
// The research arrives as one JSON array per batch (per crop group). This validates each record
// against the content rules from the design doc and merges it in, so the rules are enforced at the
// point of entry rather than discovered later on a phone card.
//
// Usage:  node scripts/merge-harvest-windows.mjs <batch.json> [batch2.json …]
//         node scripts/merge-harvest-windows.mjs --check      (validate the merged file, write nothing)
//
// Idempotent: re-merging the same batch overwrites those keys and changes nothing else. A record that
// fails validation is REJECTED and reported; it never lands half-written.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const TARGET = resolve(HERE, '../src/data/harvestWindows.json')

// A `gives` must be a CONSEQUENCE, never a permission. Dave rejected the shipped phrasing by name:
// "The 'and you never have to wait for red' on the harvest notes is not really useful. I know that."
// Scoped to permission about WAITING or PICKING. An earlier version matched any "no need to" and
// rejected "no need to peel" on Suyo Long — which is a consequence of thin skin, exactly the kind of
// payoff this dataset wants. The rejected phrasing is specifically "you don't have to wait for X".
const PERMISSION = new RegExp(
  String.raw`\b(?:never|don'?t|do not|no)\s+(?:have to|need to)\s+(?:wait|leave|hold|pick|harvest)\b`
  + String.raw`|\byou can always\b|\bfeel free to\b`, 'i')
// Crop-level records must not PRESCRIBE a colour — 16 of 41 live tomato cultivars here do not ripen
// red, so "pick it when it's red" is actively wrong for a large minority of the plants it renders on.
// Naming colours is fine and often necessary: the most useful crop-level sentence in the dataset is
// the ENUMERATION "green, yellow, orange, brown, purple and red are all legitimate final states",
// which is the anti-prescription. Same shape as the guard already shipped in ripenessCues.test.js:
// a colour close to a picking verb, unless negated or enumerated.
const COLOUR = 'red|orange|purple|black|brown|yellow|pink'
const PRESCRIBES_A_COLOUR = new RegExp(
  String.raw`\b(?:wait\s+(?:for|until)|pick|harvest)\b[^.]{0,30}\b(?:${COLOUR})\b`, 'i')
// "before" is a negation here: "harvest before yellow or orange appears" is a BOUNDARY, the opposite
// of prescribing a colour to wait for, and rejecting it cost a correct bitter-melon record once.
const NEGATED = /\b(?:never|not|no need|don'?t|without|before|any of|cultivar-specific)\b/i
// Three or more colour words in one sentence is an enumeration of possibilities, not a prescription.
const ENUMERATES = new RegExp(String.raw`\b(?:${COLOUR})\b[^.]*\b(?:${COLOUR})\b[^.]*\b(?:${COLOUR})\b`, 'i')

const REQUIRED = ['window_label', 'window', 'source', 'source_url', 'confidence']
const CONFIDENCES = new Set(['high', 'medium', 'low'])

function normKey(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function validate(rec, label, { cropLevel }) {
  const errs = []
  for (const f of REQUIRED) if (!rec[f]) errs.push(`missing ${f}`)
  if (!CONFIDENCES.has(rec.confidence)) errs.push(`confidence must be high|medium|low, got ${rec.confidence}`)
  // The whole safety argument for complete coverage is that a derived record is LABELLED and the
  // label renders. A low-confidence record with no caveat is a confident wrong claim wearing a tag
  // nobody sees.
  if (rec.confidence === 'low' && !rec.caveat) errs.push('confidence=low requires a caveat (it renders on screen)')
  if (!/^https?:\/\//.test(String(rec.source_url ?? ''))) errs.push('source_url must be a real fetched URL')
  if (!Array.isArray(rec.window) || rec.window.length < 1) errs.push('window must have at least one point')
  else {
    if (rec.window.length > 5) errs.push(`window has ${rec.window.length} points (max 5 — it has to read on a phone)`)
    rec.window.forEach((p, i) => {
      for (const f of ['at', 'look', 'gives']) {
        if (!p?.[f] || !String(p[f]).trim()) errs.push(`window[${i}] missing ${f}`)
      }
      if (PERMISSION.test(p?.gives ?? '')) errs.push(`window[${i}].gives is a permission, not a consequence: "${p.gives}"`)
      for (const f of ['look', 'gives']) {
        const text = String(p?.[f] ?? '')
        if (cropLevel && PRESCRIBES_A_COLOUR.test(text) && !NEGATED.test(text) && !ENUMERATES.test(text)) {
          errs.push(`window[${i}].${f} prescribes a colour on a CROP-level record: "${text}"`)
        }
      }
    })
  }
  if (rec.ripe_vs_unripe != null && !String(rec.ripe_vs_unripe).trim()) {
    errs.push('ripe_vs_unripe must be a real string or null, never empty')
  }
  return errs.map(e => `${label}: ${e}`)
}

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const files = args.filter(a => a !== '--check')

const doc = JSON.parse(readFileSync(TARGET, 'utf8'))
doc.by_cultivar ??= {}
doc.by_crop_type ??= {}

const errors = []
let added = 0, replaced = 0
const seenCrops = new Set()

for (const f of files) {
  let batch
  try {
    batch = JSON.parse(readFileSync(f, 'utf8'))
  } catch (e) {
    errors.push(`${f}: not parseable JSON — ${e.message}`)
    continue
  }
  if (!Array.isArray(batch)) { errors.push(`${f}: expected a JSON array`); continue }

  for (const raw of batch) {
    const isCrop = String(raw.key ?? '').startsWith('croptype:')
    const key = isCrop ? String(raw.key).slice('croptype:'.length) : normKey(raw.key || raw.display_name)
    if (!key) { errors.push(`${f}: record with no usable key`); continue }

    const label = `${f} [${isCrop ? 'croptype:' : ''}${key}]`
    const rec = {
      window_label: raw.window_label,
      window: raw.window,
      ripe_vs_unripe: raw.ripe_vs_unripe ?? null,
      source: raw.source,
      source_url: raw.source_url,
      confidence: raw.confidence,
      asserted_on: raw.asserted_on || '2026-08-11',
      ...(raw.caveat ? { caveat: raw.caveat } : {}),
      ...(raw.display_name ? { display_name: raw.display_name } : {}),
      ...(raw.crop ? { crop: raw.crop } : {}),
    }
    const errs = validate(rec, label, { cropLevel: isCrop })
    if (errs.length) { errors.push(...errs); continue }

    // Several research batches each produced their own crop-level record for the same crop. Only one
    // is canonical; the rest are kept as `-variant` keys for cross-checking the canonical one against
    // independent sourcing. They must NOT sit in by_crop_type — nothing would ever resolve them (no
    // crop_type_slug is called "pepper-jalapeno-variant"), so they would ship as dead weight in the
    // bundle and read as real crop entries to the next person who opens the file.
    const isVariant = isCrop && /-variant$/.test(key)
    if (isVariant) doc._crosschecks ??= {}
    const bucket = isVariant ? doc._crosschecks : isCrop ? doc.by_crop_type : doc.by_cultivar
    if (isVariant) delete doc.by_crop_type[key]
    if (bucket[key]) replaced++; else added++
    bucket[key] = rec
    if (isCrop) seenCrops.add(key)

    // A vendor parenthetical produces two live spellings ("Bulgarian Carrot (Shipka)" and the bare
    // form). The resolver strips parentheticals as a FALLBACK, so the bare key is what matters — but
    // aliasing both costs nothing and survives a rename in either direction.
    if (!isCrop && raw.key_full && raw.key_full !== key) {
      doc.by_cultivar[normKey(raw.key_full)] = rec
    }
  }
}

if (errors.length) {
  console.error(`REJECTED ${errors.length} problem(s):\n` + errors.map(e => '  ✗ ' + e).join('\n'))
}
const cultivars = Object.keys(doc.by_cultivar).length
const crops = Object.keys(doc.by_crop_type).length
console.log(`by_cultivar ${cultivars} (added ${added}, replaced ${replaced}) · by_crop_type ${crops}`)

if (!checkOnly && files.length) {
  writeFileSync(TARGET, JSON.stringify(doc, null, 2) + '\n')
  console.log(`wrote ${TARGET}`)
}
process.exit(errors.length ? 1 : 0)
