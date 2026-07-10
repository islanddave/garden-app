// V4-ICON-001 ProjectDetail slice (U2b): finishes the emoji->Icon language on ProjectDetail.
// The three residual photo idioms (per-plant uploader, project-photos uploader, hand-rolled
// mini-logger) drop 📷/🖼️ for the registry media.camera glyph. Per-plant + project uploaders
// consolidate to the shipped single-mode "Add photo" control (mirrors the v3.42.0 PlantingTile
// bite2); the mini-logger keeps its own file input and swaps only the leading glyph.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(resolve(root, 'pages/ProjectDetail.jsx'), 'utf8')

describe('V4-ICON-001 ProjectDetail emoji purge', () => {
  it('no camera/frame emoji remain in ProjectDetail.jsx', () => {
    for (const g of ['📷', '🖼️', '🖼', '📸']) expect(src, `still contains ${g}`).not.toContain(g)
  })
  it('no takeLabel/chooseLabel emoji props remain (dual mode retired here)', () => {
    expect(src).not.toContain('takeLabel="📷"')
    expect(src).not.toContain('chooseLabel="🖼️"')
    expect(src).not.toMatch(/mode="both"/)
  })
  it('the two card/project uploaders use single-mode media.camera', () => {
    expect((src.match(/mode="single"/g) || []).length).toBeGreaterThanOrEqual(2)
    expect((src.match(/name="media\.camera"/g) || []).length).toBeGreaterThanOrEqual(3)
  })
  it('preserves the plant-photo / project-photo inputId automation contracts', () => {
    expect(src).toContain('inputId={`plant-photo-${plant.id}`}')
    expect(src).toContain('inputId={`project-photo-${id}`}')
  })
})
