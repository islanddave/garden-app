// Release F — putUpErrors gains words for F's refusal codes (contract-F §2.7). Every code the F Lambda
// sends is enumerated from the Lambda's own source, so a code added there without words here reds.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeRefusal, REFUSAL_CODES, onlyGLeftText, JAR_USED_UP_TEXT } from '../lib/putUpErrors.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const err = (body) => Object.assign(new Error(body.error ?? 'x'), { status: 409, body })

describe('putUpErrors — release F codes', () => {
  it('only_g_left reads the server\'s grams, rounded; no grams → the server\'s sentence', () => {
    expect(describeRefusal(err({ code: 'only_g_left', g: 91.6 }))).toEqual({ code: 'only_g_left', text: onlyGLeftText(92), refresh: false })
    expect(describeRefusal(err({ code: 'only_g_left', error: 'Only about 5 g left in that one.' })).text).toBe('Only about 5 g left in that one.')
  })

  it('every F code has the client\'s own sentence, never a refresh', () => {
    for (const code of ['jar_used_up', 'jar_removed', 'has_salt_line', 'already_in', 'has_jars', 'put_up_in_use', 'key_conflict', 'shu_cannot_compute']) {
      const r = describeRefusal(err({ code, error: '' }))
      expect(r?.text, code).toBeTruthy()
      expect(r.refresh).toBe(false)
    }
    expect(describeRefusal(err({ code: 'jar_used_up' })).text).toBe(JAR_USED_UP_TEXT)
  })

  it('every code the preservation Lambda sends is one this module knows', () => {
    const files = ['lineRoutes.js', 'kitchenLines.js', 'kitchenRoutes.js', 'pantryUses.js', 'jarRoutes.js', 'putUp.js', 'jarRules.js']
    const sent = new Set()
    for (const f of files) {
      const src = readFileSync(resolve(REPO, 'lambda/preservation', f), 'utf8')
      for (const m of src.matchAll(/code: '([a-z_]+)'/g)) sent.add(m[1])
      for (const m of src.matchAll(/refuse\(\d+, '([a-z_]+)'/g)) sent.add(m[1])
      for (const m of src.matchAll(/coded\('([a-z_]+)'/g)) sent.add(m[1])
    }
    // Answered by the server's own words on purpose (unknown-code arm) — each is a sentence the server
    // lane writes to be shown as it is, or a code no F surface reaches.
    const SERVER_WORDED = new Set(['not_found', 'place_exists', 'put_up_jar', 'remaining_above_count',
      'not_paused_able', 'not_resumed_able', 'not_reopened_able',
      // B′ (release 2): a batch line naming a removed pantry item; the server's sentence is shown as is.
      'item_removed'])
    const known = new Set(Object.values(REFUSAL_CODES))
    expect(sent.size).toBeGreaterThan(8)
    expect([...sent].filter((c) => !known.has(c) && !SERVER_WORDED.has(c))).toEqual([])
  })
})
