import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

// V5-TODAYREDESIGN-001 S8c (L8) — /today is the redesigned Today, and only it.
//
// Until S8c /today mounted a per-device chooser (components/today/v2/TodayRoute.jsx) between the redesign and the
// old page, switched by the Debug & smoke row "New Today on this phone" (lib/todayV2Flag.js, key garden.todayV2)
// and featureFlags TODAY_V2_PREVIEW_ROW / TODAY_V2_DEFAULT, with an ErrorBoundary that fell back to the old page.
// TodayRoute.test.jsx, TodayRoute.previewShipped.test.jsx, TodayRoute.previewHidden.test.jsx and
// TodayV1V2Flip.test.jsx pinned that switch; they retired with it. What is left to pin is static: App mounts TodayV2
// from a STATIC import (never React.lazy — V4-LAZYRETRY-001: a rejected lazy payload is cached for good, and /today
// is the first screen), and nothing reads the old switch or reaches the old page. today-shell-v2.mjs's drift guard
// holds the same App line for the browser gate.
const SRC = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')
const APP = read('App.jsx')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__') walk(p, out) } else if (/\.(jsx?|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}
const SOURCES = walk(SRC).map((p) => ({ rel: path.relative(SRC, p), text: fs.readFileSync(p, 'utf8') }))

describe('/today mounts TodayV2', () => {
  it('from a static import', () => {
    expect(APP).toMatch(/\nimport TodayV2 from '\.\/pages\/TodayV2\.jsx'\n/)
  })
  it('never through React.lazy or a dynamic import of the page', () => {
    expect(APP).not.toMatch(/lazy\(\s*\(\)\s*=>\s*import\(['"][^'"]*TodayV2/)
    expect(APP).not.toMatch(/import\(['"][^'"]*pages\/TodayV2/)
  })
})

describe('the old page and its switch are gone', () => {
  it('no Today.jsx, TodayRoute.jsx or todayV2Flag.js', () => {
    for (const rel of ['pages/Today.jsx', 'components/today/v2/TodayRoute.jsx', 'lib/todayV2Flag.js', 'components/today/CareNeeded.jsx']) {
      expect(fs.existsSync(path.join(SRC, rel)), rel).toBe(false)
    }
  })
  it('nothing imports them', () => {
    const hits = SOURCES.filter((s) => /from\s+['"][^'"]*(pages\/Today|today\/v2\/TodayRoute|todayV2Flag|today\/CareNeeded)(\.jsx?)?['"]/.test(s.text)).map((s) => s.rel)
    expect(hits).toEqual([])
  })
  it('garden.todayV2 is spelled only in the sign-out scrub list (a stale value still gets cleared)', () => {
    expect(SOURCES.filter((s) => s.text.includes("'garden.todayV2'")).map((s) => s.rel)).toEqual(['lib/clientPrefs.js'])
  })
  it('no TODAY_V2_* flag, and no "New Today on this phone" row on Debug & smoke', () => {
    expect(read('lib/featureFlags.js')).not.toMatch(/TODAY_V2_/)
    expect(read('pages/DebugMenu.jsx')).not.toMatch(/New Today on this phone|debug-today-v2/)
  })
  it('no "today-v2" error-boundary fallback to an old page', () => {
    expect(SOURCES.filter((s) => /scope="today-v2"/.test(s.text)).map((s) => s.rel)).toEqual([])
  })
})
