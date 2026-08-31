// V4-PUBHIDE-001 static guard: the is_public visibility toggle is removed from every
// create/edit form, and server create paths default is_public=true. Everything is public;
// the toggle is gone as a concept (photo-CDN pub/priv split must NOT key on is_public).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(resolve(root, p), 'utf8')

describe('V4-PUBHIDE-001 toggle removal', () => {
  const TOGGLE_IDS = ['id="is_public"', 'id="ev_public"', 'id="edit_public"', 'id="up_pub"']
  const FORMS = ['pages/ProjectNew.jsx','pages/ProjectDetail.jsx','pages/EventNew.jsx','pages/EventDetail.jsx','pages/PhotoLibrary.jsx']
  it('no is_public checkbox toggle id remains in any form', () => {
    for (const f of FORMS) {
      const src = read(f)
      for (const id of TOGGLE_IDS) expect(src, `${f} still has ${id}`).not.toContain(id)
    }
  })
  it('no "private" visibility badge remains in Garden / ProjectList / ProjectDetail', () => {
    for (const f of ['pages/Garden.jsx','pages/ProjectList.jsx','pages/ProjectDetail.jsx']) {
      expect(read(f)).not.toMatch(/!\w+\.is_public\s*&&/)
    }
  })
})

describe('V4-PUBHIDE-001 server default', () => {
  it('projects create path defaults is_public=true', () => {
    const src = readFileSync(resolve(root, '../lambda/projects/index.js'), 'utf8')
    expect(src).toContain('body.is_public ?? true')
    expect(src).not.toContain('body.is_public ?? false')
  })
  it('events create path defaults is_public=true', () => {
    const src = readFileSync(resolve(root, '../lambda/events/index.js'), 'utf8')
    expect(src).toContain('body.is_public ?? true')
    expect(src).not.toContain('body.is_public ?? false')
  })
})

// BUG-EVENTPUBFALSE-001. The two guards above were both GREEN on 2026-08-30 while 16 harvests
// were written is_public=false and vanished from the public site. They had to be: the toggle
// really was gone and the server really did default true. What neither covered is that a
// `?? true` default only holds while the client stays SILENT — an explicit false beats it, and
// EventNew was sending one, restored from a draft written before the toggle was removed and then
// carried across a whole Save & Next burst by resetForNext.
describe('BUG-EVENTPUBFALSE-001 — the client must not send is_public on create', () => {
  const src = read('pages/EventNew.jsx')
  const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

  it('EventNew sends no is_public in any create payload', () => {
    expect(code, 'EventNew is sending is_public again — the server ?? true default cannot save you')
      .not.toMatch(/is_public\s*:/)
  })

  it('is_public is not draft-persisted', () => {
    const list = src.match(/const DRAFT_FORM_FIELDS = \[[^\]]*\]/)
    expect(list, 'DRAFT_FORM_FIELDS not found — this guard has gone blind').toBeTruthy()
    expect(list[0]).not.toContain('is_public')
  })

  // The generalisation, which is the part worth keeping: a draft may persist only what the user
  // can actually SEE and change. is_public was the one entry in that list with no control anywhere
  // in the form, which is precisely why a stale value could sit there indefinitely with no way to
  // notice it. If a future field is added here, it needs a control — or it does not belong.
  it('every draft-persisted field is bound to a control in the form', () => {
    const list = src.match(/const DRAFT_FORM_FIELDS = \[([^\]]*)\]/)[1]
    const fields = [...list.matchAll(/'([^']+)'/g)].map(m => m[1])
    expect(fields.length).toBeGreaterThan(0)
    // This form binds controls as `value={form.x}` / `checked={form.x}` — it carries no id=""
    // attributes at all, which the first version of this guard assumed and got caught on.
    for (const f of fields) {
      expect(code, `${f} is draft-persisted but nothing in EventNew binds it to a control — ` +
                   `either give it one or take it out of DRAFT_FORM_FIELDS`)
        .toMatch(new RegExp(`(?:value|checked)=\\{form\\.${f}\\b`))
    }
  })

  // Non-vacuity: the guard above must actually reject the field that caused this bug. Without
  // this, a future refactor could make the regex match nothing and every field would "pass".
  it('that guard would have caught is_public', () => {
    expect(code).not.toMatch(/(?:value|checked)=\{form\.is_public\b/)
  })
})
