// The household view switch + naming rule both Today pages share (src/lib/householdView.js; V4-ASSIGNLENS-001,
// V5-TODAYREDESIGN-001 SF6). Moved verbatim out of Today.jsx; these pin the semantics it had there, and that the
// app keeps ONE reader of the key (the orchestrator's rule for S5: add no key and no second reader).
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { SHOW_OTHERS_KEY, readShowOthers, writeShowOthers, memberFirstName } from '../lib/householdView.js'

beforeEach(() => { localStorage.clear() })

describe('the household view switch', () => {
  it('is off unless the key reads exactly "1"', () => {
    expect(SHOW_OTHERS_KEY).toBe('garden.today.showOthers')
    expect(readShowOthers()).toBe(false)
    for (const v of ['0', 'true', '']) { localStorage.setItem(SHOW_OTHERS_KEY, v); expect(readShowOthers()).toBe(false) }
    localStorage.setItem(SHOW_OTHERS_KEY, '1')
    expect(readShowOthers()).toBe(true)
  })
  it('writes "1" / "0", as the V1 pill always did', () => {
    writeShowOthers(true); expect(localStorage.getItem(SHOW_OTHERS_KEY)).toBe('1')
    writeShowOthers(false); expect(localStorage.getItem(SHOW_OTHERS_KEY)).toBe('0')
  })
  it('names another member by the first word of their display name, else "Someone else"', () => {
    const members = [{ id: 'u1', display_name: 'Dave N' }, { id: 'u2', display_name: '  Jen  Smith ' }, { id: 'u3', display_name: ' ' }]
    expect(memberFirstName(members, 'u2')).toBe('Jen')
    expect(memberFirstName(members, 'u3')).toBe('Someone else')
    expect(memberFirstName(members, 'nobody')).toBe('Someone else')
    expect(memberFirstName(null, 'u1')).toBe('Someone else')
  })
})

describe('one reader', () => {
  it('the key is spelled in exactly one source file: lib/householdView.js', () => {
    const root = resolve(process.cwd(), 'src')
    const hits = []
    const walk = (dir) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (statSync(p).isDirectory()) { if (f !== '__tests__') walk(p); continue }
        if (/\.(jsx?|tsx?|mjs)$/.test(f) && readFileSync(p, 'utf8').includes("'garden.today.showOthers'")) hits.push(relative(root, p))
      }
    }
    walk(root)
    expect(hits).toEqual(['lib/householdView.js'])
  })
})
