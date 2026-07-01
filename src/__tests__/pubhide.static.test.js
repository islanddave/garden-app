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
})
