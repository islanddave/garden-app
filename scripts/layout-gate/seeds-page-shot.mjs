#!/usr/bin/env node
// seeds-page-shot.mjs — V5-SEEDSTAB-001. The whole Seeds page, in real Chrome, at the two phone
// geometries it is built for, on all three of its views.
//
//   node scripts/layout-gate/seeds-page-shot.mjs [--outdir dir]     # npm run gate:seeds-page
//   node scripts/layout-gate/seeds-page-shot.mjs --probe-nothing    # prove the instrument fires
//
// MEASURES /seeds?view=mine, ?view=saved and ?view=sow at a TRUE 360x640 and 390x844, mounted by
// tests/harness/seeds.{html,jsx} with the app's top bar and bottom nav in place, and asserts:
//   (a) THE VIEW SWITCH IS ONE LINE — its three radios share a top within SAME_TOP_PX, and the
//       control sits inside the viewport.
//   (b) THE HEADER IS ONE LINE — the title and every action button share a row (vertical centres
//       within SAME_TOP_PX), actions do not overlap the title or run past the header, and neither
//       the header, the action slot nor the title overflows its own box.
//   (c) NO SIDEWAYS SCROLL — documentElement.scrollWidth <= clientWidth. Mobile emulation adds a
//       second shape: Chrome WIDENS the layout viewport to fit a document wider than the device (and
//       scales it down), so innerWidth reads the content width. That arrives at the viewport
//       refusal, which recognises it by the preserved aspect ratio and names it (c).
//   (d) TAP FLOOR — every visible button, link, radio and form control is >= T.tapMinHeight, as a
//       census rather than a named list, EXCEPT the frozen SegmentedControl's radios (drawn at 40px):
//       ONE named exemption, shared with gate:seeds-saved (segmented-control-exemption.mjs), held to
//       the primitive's own floor and printed on every run. Controls inside the visible band also
//       hit-test to themselves; controls under the fixed nav are not probed (that is what a scrolling
//       page under fixed chrome looks like at scrollTop 0 — putup-close-clearance.mjs's lesson).
//   (e) THE FIRST SCREEN — at 360x640 on My seeds, at least FIRST_SCREEN.minRows seed rows are FULLY
//       inside the visible band: below the top bar and above the bottom nav, i.e. what the phone
//       actually shows. The count against the bare viewport (0..innerHeight) is printed beside it.
//   (f) ONE-LINE ROWS — every My seeds row's second line ([data-testid="my-seed-line"]) is ONE line:
//       its height <= ONE_LINE_RATIO x its one-line height, AND its text runs share one horizontal
//       band. Its title is one line too, and the fixture's 44-character name is TRUNCATED with an
//       ellipsis rather than wrapped.
//   (g) THE AMOUNT IS NEVER CUT — every My seeds row that states an amount ([data-testid=
//       "my-seed-amount"]) shows ALL of it: the span is inside its line's box, has width, and its
//       text is not ellipsised. Promoted from a REPORTED finding (2026-09-18: at 360px the 44-char
//       row's two chips squeezed a single facts span to 0px, and the amount went with it).
//   (h) SOW NOW NAMES ARE NOT SQUEEZED — every open Sow now card's title column is at least
//       SowNow.jsx's TITLE_COL_MIN_PX (read from the source); wider action pairs wrap under the name.
//       Promoted from a REPORTED finding (a needs-profile card left its name 76px, five lines).
//   (i) THE ORDINAL IS NEVER CUT — on each row of an identical pair, "1 of 2 with identical details"
//       ([data-testid="my-seed-ordinal"]) shows whole, like (g): it is the only fact that tells the two
//       apart, and at the tail of the ellipsised facts it was the first thing a phone cut.
//
// "ITS LINE-HEIGHT", MADE PRECISE, because the literal reading is wrong for this element. The second
// line is a flex row of Badges and a facts span; its own computed line-height is `normal` at 12px
// (~14px), but a Badge is 22px tall by construction (0.72rem x 1.4 + 2px padding + border) — so
// "height <= 1.5 x its line-height" would fail every row that carries a chip while it sits on one
// line. The one-line height used here is the TALLEST ONE-LINE BOX AMONG ITS ITEMS (each item's used
// line-height — `normal` resolved to the height of its own text run — plus its padding and border).
// And because a two-line wrap INSIDE the facts span takes a chip row only from 22px to 30px (x1.36,
// under 1.5), the ratio is paired with a direct count of visual lines: text runs clustered by vertical
// overlap. Either one alone has a hole; together they catch a flex-wrap and a text wrap.
//
// WHY IT CANNOT BE A VITEST TEST: jsdom returns 0 from every getBoundingClientRect(). The Seeds
// suites are green about content and structurally cannot see a wrap, an overflow or a fold.
//
// THE INSTRUMENT CHECK comes first on every view, and a mismatch stops that view before any
// invariant is read: the page must self-report the viewport it was asked for (else REFUSED — trap 1
// below), must have raised no error, must be the Seeds page on the requested view (switch checked,
// view body mounted, no view-error fallback), the chrome stand-ins must be exactly TopChrome's BAR_H
// and BOTTOM_NAV_HEIGHT_PX, the ferment line the fixture guarantees must be there, and every count
// the fixture promises must match. `--probe-nothing` points every selector at a testid nothing
// renders; it MUST exit 1, and that red is the proof the non-vacuity half is load-bearing.
//
// SCREENSHOTS: one PNG of the first screen per view and viewport, written to --outdir (repo-relative
// artifacts/layout-gate by default, gitignored) — viewport-only on purpose: captureBeyondViewport
// resizes the viewport and reflows the page it is photographing.
//
// TRAPS THE SIBLINGS ALREADY PAID FOR:
//   1. macOS Chrome floors an OS window at ~500px, so --window-size=360 lays the page out at ~500
//      and CROPS the capture. Geometry comes from Emulation.setDeviceMetricsOverride, and a view whose
//      innerWidth/innerHeight is not the one requested is REFUSED, never measured.
//   2. The in-app browser pane reports visibilityState 'hidden' and rAF never fires; hence headless
//      Chrome with --disable-renderer-backgrounding (log-chooser-clearance.mjs).
//   3. CI pins node 20.19.0, which has no global WebSocket — resolveWebSocket(), never a bare global.
//   4. Fonts differ on the Linux runner (no -apple-system; the stack falls to a wider sans), so a
//      width that passes by a few pixels here can fail there. The record prints every margin.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { T } from '../../src/components/forms/formStyles.js'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'
import { resolveWebSocket } from './cdp-socket.mjs'
import { segmentedRadioFloorPx, isExemptSegmentedRadio } from './segmented-control-exemption.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Read from the token / the sources, never spelled here: a gate carrying its own copy of a floor keeps
// passing after someone moves the real one.
const TAP_MIN_HEIGHT_PX = T.tapMinHeight
const SEGMENTED_RADIO_MIN_PX = segmentedRadioFloorPx(ROOT)
function topChromeHeightPx() {
  const src = readFileSync(resolve(ROOT, 'src/components/TopChrome.jsx'), 'utf8')
  const found = [...src.matchAll(/const BAR_H = (\d+)/g)].map(m => Number(m[1]))
  if (found.length !== 1) throw new Error(`TopChrome.jsx declares BAR_H ${found.length} times; expected exactly 1 — the top-bar stand-in cannot be sized`)
  return found[0]
}
const TOP_CHROME_PX = topChromeHeightPx()
function sowTitleColMinPx() {
  const src = readFileSync(resolve(ROOT, 'src/pages/SowNow.jsx'), 'utf8')
  const found = [...src.matchAll(/const TITLE_COL_MIN_PX = (\d+)/g)].map(m => Number(m[1]))
  if (found.length !== 1) throw new Error(`SowNow.jsx declares TITLE_COL_MIN_PX ${found.length} times; expected exactly 1 — (h) has no floor to hold the cards to`)
  return found[0]
}
const SOW_TITLE_COL_MIN_PX = sowTitleColMinPx()

// Tolerances. 2px is "the same line" for boxes whose centres a flex row aligns exactly; 1.5 is the
// brief's own one-line ratio (a second line of any of this text at least doubles the box).
const SAME_TOP_PX = 2
const ONE_LINE_RATIO = 1.5
// (e): the first screen of My seeds at the narrowest phone.
const FIRST_SCREEN = { view: 'mine', vw: 360, vh: 640, minRows: 3 }

const PORT = Number(process.env.GATE_HARNESS_PORT || 5319)   // 5312-5318 / 9422-9429 are sibling gates'
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9430)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Same seam the sibling gates use — CI passes --no-sandbox. Rendering-affecting flags do NOT belong here.
const EXTRA_CHROME_FLAGS = (process.env.GATE_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)
const outArg = process.argv.indexOf('--outdir')
const OUTDIR = outArg > -1 ? resolve(process.argv[outArg + 1]) : resolve(ROOT, 'artifacts/layout-gate')

// MUTATION HOOK — how each assertion below was shown able to fire WITHOUT touching src/**: CSS
// injected into the page after it is ready and before anything is read (e.g. GATE_MUTATE_CSS=
// '[data-testid="my-seed-line"]{flex-wrap:wrap!important}' must red (f)). Never set in CI; a run
// with it set says so in its first line, so its output cannot pass for a clean one.
const MUTATE_CSS = process.env.GATE_MUTATE_CSS || ''

const PROBE_NOTHING = process.argv.includes('--probe-nothing')
const SUFFIX = PROBE_NOTHING ? '-PROBE-NOTHING' : ''
const tid = (name) => `[data-testid="${name}${SUFFIX}"]`
const tidPrefix = (name) => `[data-testid^="${name}${SUFFIX}"]`

// What tests/harness/seeds.jsx promises, per view. EXACT where the number falls straight out of the
// fixture rows (the two files move together); a FLOOR only on Sow now, whose timed buckets move with
// the calendar — its floor counts only the date-independent cards (3 with no sow profile: Add sow
// details + Archive; 2 in process: Archive) and the two collapsed review sections' toggles.
const LONG_NAME = 'Money Plant (self-saved, variety unrecorded)'
const VIEWS = [
  { view: 'mine', label: 'My seeds', body: 'my-seeds-view', expect: { actions: 2, rows: 26, groups: 8, longRowChips: 2, ordinalRows: 2, amountRows: 24 } },
  { view: 'saved', label: 'Saved seeds', body: 'saved-seeds-view', expect: { actions: 1, cards: 4, sections: 3 } },
  { view: 'sow', label: 'Sow now', body: 'sow-now-view', expect: { actions: 0, minSowButtons: 10, minSowHeadings: 2 } },
]
const VIEWPORTS = [[360, 640], [390, 844]]

const failures = []
const fail = m => failures.push(m)

async function startHarness() {
  const bin = resolve(ROOT, 'node_modules/vite/bin/vite.js')
  if (!existsSync(bin)) throw new Error(`vite not installed at ${bin} — run npm ci --legacy-peer-deps`)
  // Spawned through vite's own bin, NOT `npx vite`: npx is a wrapper, so killing it at teardown
  // orphans the real server and hangs any caller that pipes this script's stdout.
  const proc = spawn(process.execPath, [bin, '--config', 'tests/harness/vite.harness.config.mjs', '--port', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  proc.stdout.on('data', d => { log += d })
  proc.stderr.on('data', d => { log += d })
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/tests/harness/seeds.html`)
      if (r.ok) return proc
    } catch { /* not listening yet */ }
    if (proc.exitCode != null) throw new Error(`harness vite exited (${proc.exitCode}):\n${log}`)
    await sleep(250)
  }
  proc.kill('SIGKILL')
  throw new Error(`harness vite never served :${PORT} within 30s:\n${log}`)
}

async function startChrome(userDataDir) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} — set CHROME_PATH`)
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`,
    // Deliberately LARGER than the viewport under test: geometry is imposed by emulation, so the
    // window only has to be big enough not to clip it. See trap 1 in the header.
    '--window-size=900,1000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', ...EXTRA_CHROME_FLAGS,
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  // 60s by default, as the siblings: 15s was marginal on a loaded GitHub runner. CDP_WAIT_MS overrides.
  const CDP_WAIT_TRIES = Math.max(1, Math.ceil(Number(process.env.CDP_WAIT_MS ?? 60000) / 250))
  for (let i = 0; i < CDP_WAIT_TRIES; i++) {
    // A DEAD CHROME IS NOT A SLOW CHROME — say which one this is instead of waiting out the clock.
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`Chrome EXITED before exposing CDP on ${CDP_PORT} (code=${proc.exitCode} signal=${proc.signalCode}) - a dead browser, not a slow one; re-running will not help`)
    }
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (r.ok) return { proc, version: await r.json() }
    } catch { /* not listening yet */ }
    await sleep(250)
  }
  proc.kill('SIGKILL')
  throw new Error(`Chrome did not expose CDP on ${CDP_PORT} within ${CDP_WAIT_TRIES * 250}ms`)
}

async function attach(wsUrl) {
  const WS = await resolveWebSocket()
  const ws = new WS(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket failed')) })
  let id = 0
  const pending = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id != null && pending.has(m.id)) {
      const { res, rej, timer } = pending.get(m.id); pending.delete(m.id)
      clearTimeout(timer)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
  }
  // Each call's 90s timeout is CLEARED when its answer lands. The siblings leave theirs armed, so a
  // PASSING run (which exits naturally rather than through process.exit) idles until the last one
  // fires — measured on gate:seeds-saved: ~90 of its ~99 s are that wait, after PASS is printed.
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id
    const timer = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`CDP timeout: ${method}`)) } }, 90000)
    pending.set(mid, { res, rej, timer })
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  const evalIn = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId)
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  return { ws, send, sessionId, evalIn }
}

// ── The measurement, evaluated in the page itself ───────────────────────────────────────────────
// Nothing is tapped, scrolled or restyled: every number is read from the live document at scrollTop
// 0, which is the first screen (e) is about.
const MEASURE = (v) => `(() => {
  const d = document, w = window, de = d.documentElement
  const R = n => Math.round(n * 10) / 10
  const box = el => { const r = el.getBoundingClientRect(); return {
    t: R(r.top), l: R(r.left), r: R(r.right), b: R(r.bottom), w: R(r.width), h: R(r.height) } }
  const name = el => el.getAttribute('aria-label') || el.getAttribute('data-testid') ||
    (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40) ||
    ('<' + el.tagName.toLowerCase() + ' ' + (el.type || '') + '>')
  // checkVisibility(), not offsetParent: a collapsed <details> or a zero-opacity ancestor reports a
  // parent and reads as visible through offsetParent.
  const shown = el => (!el.checkVisibility || el.checkVisibility()) && el.getBoundingClientRect().height > 0
  const px = s => { const n = parseFloat(s); return Number.isFinite(n) ? n : 0 }
  // Text runs, one rect per line fragment per TEXT NODE, from a Range over each live text node. No
  // clone and no style mutation: a gate that edits the document to measure it measures its own
  // instrument. Per text node and not one Range over the element, because a Range's rects include
  // the BORDER BOX of every element it selects — a two-line facts span's own 30px box then spans both
  // of its lines and merges them into one (measured: a GATE_MUTATE_CSS wrap read "1 visual line").
  const textRects = el => { const out = [], tw = d.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let t = tw.nextNode(); t; t = tw.nextNode()) {
      if (!t.textContent.trim()) continue
      const rg = d.createRange(); rg.selectNodeContents(t)
      for (const r of rg.getClientRects()) if (r.width > 0.5 && r.height > 0.5) out.push(r)
    }
    return out }
  // VISUAL LINES: text runs clustered by vertical OVERLAP. A chip's text sits a few px lower than the
  // facts beside it on the same line, so counting distinct tops (right for one text node, as in
  // seeds-saved-clearance.mjs) would call a one-line row three lines.
  // Each band keeps its widest run: an ellipsized text node hands back TWO rects on its one line (the
  // full run and the painted one — measured 327px + 270px for the 44-char name), so a sum of rects
  // double-counts and a per-band max does not.
  const bandsOf = el => { const rs = textRects(el).sort((a, b) => a.top - b.top); const out = []
    for (const r of rs) { const last = out[out.length - 1]
      if (last && r.top < last.bottom - 1) { last.bottom = Math.max(last.bottom, r.bottom); last.w = Math.max(last.w, r.width) }
      else out.push({ top: r.top, bottom: r.bottom, w: r.width }) }
    return out }
  const lines = el => bandsOf(el).length
  // ONE LINE of an element's own content: its used line-height (px; 'normal' resolved to the height
  // of its own text run, which is what normal means for that font) + vertical padding + border.
  const oneLine = el => { const cs = w.getComputedStyle(el); let lh = parseFloat(cs.lineHeight)
    if (!Number.isFinite(lh)) { const rs = textRects(el); lh = rs.length ? Math.min(...rs.map(r => r.height)) : px(cs.fontSize) * 1.2 }
    return lh + px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth) }

  const topBar = d.querySelector('header[data-app-chrome="top"]')
  const nav = d.querySelector('nav[aria-label="Main navigation"]')
  // The VISIBLE BAND at scrollTop 0: under the sticky top bar, above the fixed nav.
  const bandTop = topBar ? topBar.getBoundingClientRect().bottom : 0
  const bandBottom = nav ? nav.getBoundingClientRect().top : w.innerHeight
  const hitsSelf = (el, r) => {
    const x = (r.l + r.r) / 2, y = (r.t + r.b) / 2
    if (x < 0 || x > w.innerWidth || y < bandTop || y > bandBottom) return null   // never probed != not occluded
    const at = d.elementFromPoint(x, y)
    return at === el || (at != null && (el.contains(at) || at.contains(el)))
  }

  const page = d.querySelector('${tid('seeds-page')}')
  const sw = d.querySelector('${tid('seeds-view-switch')}')
  const radios = sw ? [...sw.querySelectorAll('[role="radio"]')] : []
  const checked = radios.find(r => r.getAttribute('aria-checked') === 'true')
  const h1 = page ? page.querySelector('h1') : null
  const header = h1 ? h1.parentElement : null
  const actionsEl = d.querySelector('${tid('seeds-actions')}')
  const actions = actionsEl ? [...actionsEl.children].filter(shown) : []
  const ferment = d.querySelector('${tid('seeds-ferment-line')}')
  const body = d.querySelector('${tid(v.body)}')

  // (d) the census: every visible control on the page, chrome stand-ins excluded (they carry none).
  const inChrome = el => (topBar && topBar.contains(el)) || (nav && nav.contains(el))
  const taps = [...d.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="radio"]')]
    .filter(shown).filter(el => !inChrome(el)).map(el => {
      const r = box(el), parent = el.parentElement
      return { label: name(el), tag: el.tagName.toLowerCase(), w: r.w, h: r.h, t: r.t,
        hitIsSelf: hitsSelf(el, r), fitsX: r.l >= -0.5 && r.r <= w.innerWidth + 0.5,
        role: el.getAttribute('role'),
        group: parent && parent.getAttribute('role') === 'radiogroup' ? parent.getAttribute('data-testid') : null }
    })

  // (e)/(f) My seeds rows.
  const rows = [...d.querySelectorAll('${tid('my-seed-row')}')].map(row => {
    const rb = box(row)
    const line = row.querySelector('${tid('my-seed-line')}')
    const title = line ? line.previousElementSibling : null
    let L = null, TT = null
    if (line) {
      const items = [...line.children]
      const chips = [...line.querySelectorAll('${tid('my-seed-chip')}')]
      const amount = line.querySelector('${tid('my-seed-amount')}')
      const ordinal = line.querySelector('${tid('my-seed-ordinal')}')
      const ob = ordinal ? ordinal.getBoundingClientRect() : null
      const rest = line.querySelector('${tid('my-seed-rest')}')
      const lb = line.getBoundingClientRect()
      // The chips count as items even though they now sit one level down, in their own shrinking box:
      // measured against the direct children only, a 22px Badge row read as x1.58 of a 14px line on
      // CI's fonts (x1.47 on the Mac) — a one-line row failing (f) because of where its chips live.
      const one = Math.max(oneLine(line), ...items.map(oneLine), ...chips.map(oneLine))
      const ab = amount ? amount.getBoundingClientRect() : null
      L = { text: (line.textContent || '').trim().replace(/\\s+/g, ' '), h: R(lb.height), oneLineH: R(one),
        ratio: Math.round(lb.height / one * 100) / 100, lines: lines(line), chips: chips.length,
        chipLabels: chips.map(c => (c.textContent || '').trim()),
        // (g): the amount, whole — inside the line's box, with width, not ellipsised.
        amount: amount ? { text: (amount.textContent || '').trim(), w: R(ab.width), l: R(ab.left), r: R(ab.right),
          inLine: ab.left >= lb.left - 0.5 && ab.right <= lb.right + 0.5, cut: amount.scrollWidth > amount.clientWidth + 1 } : null,
        ordinal: ordinal ? { text: (ordinal.textContent || '').trim(), w: R(ob.width), l: R(ob.left), r: R(ob.right),
          inLine: ob.left >= lb.left - 0.5 && ob.right <= lb.right + 0.5, cut: ordinal.scrollWidth > ordinal.clientWidth + 1 } : null,
        lineL: R(lb.left), lineR: R(lb.right),
        // REPORTED: what gives way on a crowded line, by design — chips ellipsised, then where-from/how-old.
        chipsCut: chips.filter(c => c.scrollWidth > c.clientWidth + 1 || c.getBoundingClientRect().right > lb.right + 0.5).length,
        restW: rest ? R(rest.getBoundingClientRect().width) : null,
        restInkW: rest ? R(rest.scrollWidth) : null,
        clipsContent: line.scrollWidth > line.clientWidth + 1 }
    }
    if (title) {
      const tb = title.getBoundingClientRect()
      TT = { text: (title.textContent || '').trim(), h: R(tb.height), oneLineH: R(oneLine(title)), lines: lines(title),
        truncated: title.scrollWidth > title.clientWidth + 1,
        ellipsis: w.getComputedStyle(title).textOverflow === 'ellipsis', w: R(tb.width),
        // The name's full ink width, wrapped or not: the widest run on each of its lines, summed.
        // Whether the name NEEDS truncating is a property of the fixture; whether it IS is (f).
        inkW: R(bandsOf(title).reduce((s, b) => s + b.w, 0)) }
    }
    return { t: rb.t, b: rb.b, h: rb.h, line: L, title: TT,
      inBand: rb.t >= bandTop - 0.5 && rb.b <= bandBottom + 0.5,
      inViewport: rb.t >= -0.5 && rb.b <= w.innerHeight + 0.5 }
  })

  // Sow now: the date-independent floor, and — REPORTED — each open card's title column, which is
  // what the card's action column leaves for the name.
  const sowView = d.querySelector('${tid('sow-now-view')}')
  const sowCards = sowView ? [...sowView.querySelectorAll('button[aria-label^="Archive "], button[aria-label^="Un-archive "]')]
    .filter(shown).map(b => b.parentElement && b.parentElement.parentElement).filter(Boolean).map(card => {
      const col = card.firstElementChild, titleEl = col && col.querySelector('span')
      return { title: titleEl ? (titleEl.textContent || '').trim() : '?', colW: col ? R(col.getBoundingClientRect().width) : null,
        titleLines: titleEl ? lines(titleEl) : null, cardH: R(card.getBoundingClientRect().height),
        hasProfileBtn: !!card.querySelector('button[aria-label^="Add sow details for "]') }
    }) : []

  const hb = header ? box(header) : null, tb = h1 ? box(h1) : null
  return {
    vw: w.innerWidth, vh: w.innerHeight,
    scroll: { x: Math.round(w.scrollX), y: Math.round(w.scrollY) },
    errors: w.__h && w.__h.errors ? w.__h.errors() : ['harness never exposed __h'],
    arrived: !!(w.__h && w.__h.arrived && w.__h.arrived()),
    hits: w.__h && w.__h.hits ? w.__h.hits() : {},
    chrome: { top: topBar ? R(topBar.getBoundingClientRect().height) : null, nav: nav ? R(nav.getBoundingClientRect().height) : null,
      bandTop: R(bandTop), bandBottom: R(bandBottom) },
    doc: { scrollW: de.scrollWidth, clientW: de.clientWidth, scrollH: de.scrollHeight },
    surface: { page: !!page, body: !!body, viewError: !!d.querySelector('${tid('seeds-view-error')}'),
      radios: radios.length, checked: checked ? (checked.textContent || '').trim() : null,
      h1: h1 ? (h1.textContent || '').trim() : null },
    sw: sw ? { ...box(sw), tops: radios.map(r => R(r.getBoundingClientRect().top)), heights: radios.map(r => R(r.getBoundingClientRect().height)),
      overflow: sw.scrollWidth > sw.clientWidth + 1 } : null,
    header: header ? { ...hb, overflow: header.scrollWidth > header.clientWidth + 1,
      title: { ...tb, clipped: h1.scrollWidth > h1.clientWidth + 1 },
      slotOverflow: actionsEl ? actionsEl.scrollWidth > actionsEl.clientWidth + 1 : false,
      actions: actions.map(a => ({ label: name(a), ...box(a) })) } : null,
    ferment: ferment ? { ...box(ferment), level: ferment.getAttribute('data-level'), lines: lines(ferment),
      text: (ferment.textContent || '').trim().replace(/\\s+/g, ' ') } : null,
    taps, rows,
    groups: d.querySelectorAll('${tid('my-seeds-view')} [data-testid="facet-group-header"]').length,
    cards: d.querySelectorAll('${tid('seed-lot-card')}').length,
    sections: d.querySelectorAll('${tidPrefix('stage-section-')}').length,
    sow: sowView ? { buttons: [...sowView.querySelectorAll('button')].filter(shown).length,
      headings: sowView.querySelectorAll('h2').length, cards: sowCards } : null,
  }
})()`

// Six navigations on one target, and Runtime.evaluate races the commit: dispatched a beat too early
// the context is torn down under it. Retried ONLY on that transport class (seeds-saved's lesson);
// anything else still throws, because a page error is not a slow page.
const CONTEXT_LOST = /navigated or closed|Execution context was destroyed|Cannot find context/i
async function evalSettled(expr, tries = 25) {
  let last
  for (let i = 0; i < tries; i++) {
    try { return await cdp.evalIn(expr) } catch (err) {
      if (!CONTEXT_LOST.test(err.message)) throw err
      last = err
      await sleep(200)
    }
  }
  throw new Error(`page never held still long enough to evaluate: ${last?.message}`)
}

let harness, chrome, cdp
const udd = mkdtempSync(join(tmpdir(), 'gate-seedspage-'))
try {
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)
  if (PROBE_NOTHING) console.log('[seeds-page] --probe-nothing: every selector points at a testid nothing renders. This run MUST fail.')
  if (MUTATE_CSS) console.log(`[seeds-page] MUTATED RUN — GATE_MUTATE_CSS is injected into every view: ${MUTATE_CSS}`)
  mkdirSync(OUTDIR, { recursive: true })

  for (const v of VIEWS) {
    for (const [vw, vh] of VIEWPORTS) {
      const at = `${v.view}@${vw}x${vh}`
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 2, mobile: true }, cdp.sessionId)
      // verdict=0 strips the harness's fixed instrument bar — z-index 99999 over the header, it
      // would make elementFromPoint report the bar and this gate would be measuring its own instrument.
      // `vp` makes every navigation a NEW url: navigating to the url already loaded restores its scroll.
      const url = `http://localhost:${PORT}/tests/harness/seeds.html?view=${v.view}&topbar=${TOP_CHROME_PX}&vp=${vw}x${vh}&verdict=0`
      const nav = await cdp.send('Page.navigate', { url }, cdp.sessionId)
      if (nav.errorText) throw new Error(`navigation to ${url} failed: ${nav.errorText}`)
      await sleep(200)
      await evalSettled(`(async()=>{for(let i=0;i<200;i++){if(window.__h&&window.__h.ready())return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('harness never reached ready() on view=${v.view}')})()`)
      await evalSettled('new Promise(r=>setTimeout(r,400))')   // let fonts settle
      if (MUTATE_CSS) {
        await evalSettled(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(MUTATE_CSS)}; document.head.appendChild(s); return 1 })()`)
        await evalSettled('new Promise(r=>setTimeout(r,200))')
      }
      const m = await evalSettled(MEASURE(v))

      // The artifact first, so a view that fails below still leaves its picture behind.
      const shotPath = join(OUTDIR, `seeds-page-${v.view}-${vw}x${vh}.png`)
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, cdp.sessionId)
      writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))

      // ── INSTRUMENT CHECK, before any invariant. A mismatch stops this view: every number below it
      //    would be about the wrong layout, the wrong surface, or nothing at all.
      if (m.vw !== vw || m.vh !== vh) {
        // TWO causes, told apart by the aspect ratio. Mobile Chrome WIDENS the layout viewport to fit a
        // document wider than the device and scales it down, KEEPING the device's aspect (measured: a
        // page forced to 480px at 360x640 self-reports 480x854, and visualViewport.scale still reads 1)
        // — so a sideways overflow arrives here, not at (c). An emulation that did not take reports the
        // OS window instead, whose aspect is unrelated.
        const grewToFit = m.vw > vw && Math.abs(m.vw * vh - m.vh * vw) <= vh
        fail(grewToFit
          ? `${at}: (c) REFUSED — the page is wider than the ${vw}px viewport: mobile Chrome widened the layout viewport to ${m.vw}x${m.vh} to fit a ${m.doc.scrollW}px document and scaled it down, so the page overflows sideways and every other coordinate is from the scaled layout`
          : `${at}: REFUSED — the page self-reports ${m.vw}x${m.vh}; emulation did not take, so every coordinate would be from the wrong layout`)
        continue
      }
      const e = v.expect
      const mismatch = []
      // The first screen is measured at scrollTop 0 or not at all. A same-URL navigation restores the
      // previous scroll (measured: an evidence scroll on one viewport carried into the next one's
      // measurement, radio tops -457), which is why every URL above carries its viewport too.
      if (m.scroll.x !== 0 || m.scroll.y !== 0) mismatch.push(`the page is scrolled to ${m.scroll.x},${m.scroll.y} — the first screen is only measurable at 0,0`)
      if (m.errors.length) mismatch.push(`the page raised ${m.errors.length} error(s) while mounting: ${m.errors.join(' | ')}`)
      if (!m.arrived) mismatch.push(`the ${v.label} body never arrived in the harness`)
      if (m.chrome.top !== TOP_CHROME_PX) mismatch.push(`top-bar stand-in is ${m.chrome.top}px, TopChrome's BAR_H is ${TOP_CHROME_PX}px`)
      if (m.chrome.nav !== BOTTOM_NAV_HEIGHT_PX) mismatch.push(`bottom-nav stand-in is ${m.chrome.nav}px, BOTTOM_NAV_HEIGHT_PX is ${BOTTOM_NAV_HEIGHT_PX}px`)
      if (!m.surface.page) mismatch.push('no Seeds page in the document')
      if (m.surface.radios !== 3) mismatch.push(`the view switch has ${m.surface.radios} radios, expected 3`)
      if (m.surface.checked !== v.label) mismatch.push(`the switch reports "${m.surface.checked}" as checked, expected "${v.label}" — ?view=${v.view} did not resolve`)
      if (m.surface.h1 !== 'Seeds') mismatch.push(`the page title reads "${m.surface.h1}", expected "Seeds"`)
      if (!m.surface.body) mismatch.push(`the ${v.label} view body (${v.body}) is not mounted`)
      if (m.surface.viewError) mismatch.push(`the ${v.label} view rendered its error fallback`)
      if (!m.ferment) mismatch.push('no ferment line — the fixture carries a lot 5 days into its ferment, so the line under the switch must show')
      else if (m.ferment.level !== 'alarm') mismatch.push(`the ferment line is at level "${m.ferment.level}", the fixture's day-5 lot is "alarm"`)
      if (m.header && m.header.actions.length !== e.actions) mismatch.push(`${m.header.actions.length} header action(s), expected ${e.actions}`)
      if (v.view === 'mine') {
        if (m.rows.length !== e.rows) mismatch.push(`${m.rows.length} seed rows, expected ${e.rows} (27 rows, the used-up packet collapsed under Sowed previously)`)
        if (m.groups !== e.groups) mismatch.push(`${m.groups} crop groups, expected ${e.groups}`)
        const long = m.rows.find(r => r.title && r.title.text === LONG_NAME)
        if (!long) mismatch.push(`the 44-character row ("${LONG_NAME}") is not on the page`)
        else {
          if (!long.line || long.line.chips !== e.longRowChips) mismatch.push(`the 44-character row carries ${long.line ? long.line.chips : 0} chip(s), expected ${e.longRowChips} — the worst case for its second line is not on screen`)
          // Non-vacuity for (f)'s ellipsis half: a name whose ink FITS its column proves nothing about
          // truncation. Ink, not scrollWidth — a name that wrapped fits by scrollWidth, and that is
          // (f)'s failure to report, not this check's.
          if (!(long.title.inkW > long.title.w + 1)) mismatch.push(`the 44-character title's ink (${long.title.inkW}px) fits its ${long.title.w}px column at ${vw}px, so the ellipsis path is exercised by nothing`)
          // Non-vacuity for (g): the worst row must state an amount, or (g) holds it to nothing.
          if (!long.line || !long.line.amount) mismatch.push('the 44-character row states no amount — (g) would be checking nothing on the one row that crowds it')
        }
        const withAmount = m.rows.filter(r => r.line && r.line.amount).length
        if (withAmount !== e.amountRows) mismatch.push(`${withAmount} of ${m.rows.length} rows state an amount, expected ${e.amountRows} (every row but the two uncounted saved lots, Aji Charapita and Cherokee Purple)`)
        const ordinal = m.rows.filter(r => r.line && /with identical details/.test(r.line.text)).length
        if (ordinal !== e.ordinalRows) mismatch.push(`${ordinal} row(s) carry the identical-details ordinal, expected ${e.ordinalRows}`)
        // Non-vacuity for (i): the ordinal must be in its own span on exactly those rows.
        const ordinalSpans = m.rows.filter(r => r.line && r.line.ordinal).length
        if (ordinalSpans !== e.ordinalRows) mismatch.push(`${ordinalSpans} row(s) render the ordinal in its own span, expected ${e.ordinalRows} — (i) would be checking nothing`)
      }
      if (v.view === 'saved') {
        if (m.cards !== e.cards) mismatch.push(`${m.cards} seed-lot cards, expected ${e.cards}`)
        if (m.sections !== e.sections) mismatch.push(`${m.sections} stage sections, expected ${e.sections}`)
      }
      if (v.view === 'sow') {
        if (!m.sow || m.sow.buttons < e.minSowButtons) mismatch.push(`${m.sow ? m.sow.buttons : 0} buttons in Sow now, expected >=${e.minSowButtons} (the date-independent cards and toggles alone)`)
        if (!m.sow || m.sow.headings < e.minSowHeadings) mismatch.push(`${m.sow ? m.sow.headings : 0} open Sow now sections, expected >=${e.minSowHeadings} (Needs a sow profile, Still in process)`)
        // Non-vacuity for (h): the widest action pair must be on screen, or (h) measures only the easy cards.
        if (!m.sow || !m.sow.cards.some(c => c.hasProfileBtn)) mismatch.push('no open Sow now card carries "Add sow details" — (h) would never meet the action pair that squeezed the name')
      }
      if (mismatch.length) {
        // A selector that matched nothing is a FAILURE, never a quiet pass. If the page was
        // redesigned, tests/harness/seeds.jsx and VIEWS here move together.
        fail(`${at}: the harness did not produce what this gate measures — ${mismatch.join('; ')}`)
        continue
      }
      // The zero-box detector: an unrendered (or jsdom-shaped) document hands back real elements
      // whose every box is 0x0, and every floor below would then be vacuously met.
      const heights = m.taps.map(t => t.h).concat(m.rows.map(r => r.h))
      if (!heights.length) { fail(`${at}: no boxes measured at all`); continue }
      if (heights.every(h => h === 0)) { fail(`${at}: every one of ${heights.length} measured boxes is 0px tall — an unrendered document, not a passing layout`); continue }

      // ── (a) THE VIEW SWITCH IS ONE LINE.
      const spread = Math.round((Math.max(...m.sw.tops) - Math.min(...m.sw.tops)) * 10) / 10
      if (spread > SAME_TOP_PX) fail(`${at}: (a) the view switch wraps — its radios' tops span ${spread}px (${m.sw.tops.join('/')}), over ${SAME_TOP_PX}px`)
      if (m.sw.overflow) fail(`${at}: (a) the view switch overflows its own box`)
      if (m.sw.l < -0.5 || m.sw.r > vw + 0.5) fail(`${at}: (a) the view switch spans x${m.sw.l}-${m.sw.r}, outside the ${vw}px viewport`)

      // ── (b) THE HEADER IS ONE LINE.
      const H = m.header
      const titleMid = (H.title.t + H.title.b) / 2
      for (const a of H.actions) {
        const mid = (a.t + a.b) / 2
        if (Math.abs(mid - titleMid) > SAME_TOP_PX) fail(`${at}: (b) header action "${a.label}" is not on the title's line — centres ${Math.round(mid)} vs ${Math.round(titleMid)}`)
        if (a.l < H.title.r - 0.5) fail(`${at}: (b) header action "${a.label}" (x${a.l}) overlaps the title (ends x${H.title.r})`)
        if (a.r > H.r + 0.5) fail(`${at}: (b) header action "${a.label}" runs past the header (x${a.r} > ${H.r})`)
      }
      if (H.actions.length > 1) {
        const aSpread = Math.max(...H.actions.map(a => a.t)) - Math.min(...H.actions.map(a => a.t))
        if (aSpread > SAME_TOP_PX) fail(`${at}: (b) the header actions do not share a row — tops span ${Math.round(aSpread)}px`)
      }
      if (H.overflow) fail(`${at}: (b) the header overflows its own box`)
      if (H.slotOverflow) fail(`${at}: (b) the header's action slot overflows its own box`)
      if (H.title.clipped) fail(`${at}: (b) the page title is clipped`)

      // ── (c) NO SIDEWAYS SCROLL.
      if (m.doc.scrollW > m.doc.clientW) fail(`${at}: (c) document scrollWidth ${m.doc.scrollW} > clientWidth ${m.doc.clientW} — the page scrolls sideways`)

      // ── (d) TAP FLOOR — census; ONE named exemption.
      const exempt = m.taps.filter(isExemptSegmentedRadio)
      const floored = m.taps.filter(t => !isExemptSegmentedRadio(t))
      const kind = t => (t.tag === 'a' ? 'link' : t.role === 'radio' ? 'radio' : t.tag)
      for (const t of floored.filter(t => t.h < TAP_MIN_HEIGHT_PX)) fail(`${at}: (d) ${kind(t)} "${t.label}" renders ${t.w}x${t.h}, under the ${TAP_MIN_HEIGHT_PX}px tap floor`)
      for (const t of exempt.filter(t => t.h < SEGMENTED_RADIO_MIN_PX)) fail(`${at}: (d) SegmentedControl radio "${t.label}" (${t.group}) renders ${t.w}x${t.h}, under even the primitive's own ${SEGMENTED_RADIO_MIN_PX}px`)
      for (const t of m.taps) {
        if (t.hitIsSelf === false) fail(`${at}: (d) ${kind(t)} "${t.label}" does not hit-test to itself — occluded`)
        if (!t.fitsX) fail(`${at}: (d) ${kind(t)} "${t.label}" sits outside the ${vw}px viewport`)
      }

      // ── (e) THE FIRST SCREEN.
      const inBand = m.rows.filter(r => r.inBand).length
      const inViewport = m.rows.filter(r => r.inViewport).length
      if (v.view === FIRST_SCREEN.view && vw === FIRST_SCREEN.vw && vh === FIRST_SCREEN.vh && inBand < FIRST_SCREEN.minRows) {
        const first = m.rows[0]
        fail(`${at}: (e) only ${inBand} seed row(s) fully visible on the first screen (y${m.chrome.bandTop}-${m.chrome.bandBottom}, between the top bar and the nav), need >=${FIRST_SCREEN.minRows} — the first row starts at y${first ? first.t : '?'}; ${inViewport} fit the bare 0-${vh} viewport`)
      }

      // ── (f) ONE-LINE ROWS.
      for (const r of m.rows) {
        const L = r.line, TT = r.title
        if (L && (L.ratio > ONE_LINE_RATIO || L.lines !== 1)) fail(`${at}: (f) "${TT ? TT.text : '?'}": its second line is ${L.h}px against a one-line ${L.oneLineH}px (x${L.ratio}) across ${L.lines} visual line(s) — it wrapped`)
        if (TT && (TT.lines !== 1 || TT.h > ONE_LINE_RATIO * TT.oneLineH)) fail(`${at}: (f) title "${TT.text}" occupies ${TT.lines} line(s), ${TT.h}px against a one-line ${TT.oneLineH}px — it wrapped instead of truncating`)
        if (TT && TT.truncated && !TT.ellipsis) fail(`${at}: (f) title "${TT.text}" is cut off without an ellipsis`)
      }
      // The brief's own words for (f): the long name truncates with an ellipsis instead of wrapping.
      const longRow = m.rows.find(r => r.title && r.title.text === LONG_NAME)
      if (longRow && !(longRow.title.truncated && longRow.title.ellipsis)) fail(`${at}: (f) the 44-character name is not truncated with an ellipsis (truncated ${longRow.title.truncated}, ellipsis ${longRow.title.ellipsis}, ${longRow.title.lines} line(s))`)

      // ── (g) THE AMOUNT IS NEVER CUT.
      for (const r of m.rows) {
        const A = r.line && r.line.amount
        if (!A) continue
        if (!(A.w > 0) || !A.inLine || A.cut) fail(`${at}: (g) "${r.title ? r.title.text : '?'}": its amount "${A.text}" is cut — ${A.w}px wide at x${A.l}-${A.r} in a line spanning x${r.line.lineL}-${r.line.lineR}${A.cut ? ', ellipsised' : ''}`)
      }

      // ── (i) THE ORDINAL IS NEVER CUT.
      for (const r of m.rows) {
        const O = r.line && r.line.ordinal
        if (!O) continue
        if (!(O.w > 0) || !O.inLine || O.cut) fail(`${at}: (i) "${r.title ? r.title.text : '?'}": its ordinal "${O.text}" is cut — ${O.w}px wide at x${O.l}-${O.r} in a line spanning x${r.line.lineL}-${r.line.lineR}${O.cut ? ', ellipsised' : ''}`)
      }

      // ── (h) SOW NOW NAMES ARE NOT SQUEEZED.
      if (m.sow) {
        for (const c of m.sow.cards) {
          if (!(c.colW >= SOW_TITLE_COL_MIN_PX - 0.5)) fail(`${at}: (h) Sow now card "${c.title}": its title column is ${c.colW}px, under SowNow.jsx's TITLE_COL_MIN_PX ${SOW_TITLE_COL_MIN_PX}px — the actions squeezed the name onto ${c.titleLines} line(s)`)
        }
      }

      // ── The record. Printed on pass as well as fail: the numbers a redesign has to move.
      const P = `[seeds-page] ${at}`
      const minFloored = floored.length ? Math.min(...floored.map(t => t.h)) : 0
      console.log(`${P}: switch ${m.sw.w}px wide at x${m.sw.l}-${m.sw.r}, radio tops ${m.sw.tops.join('/')} (spread ${spread}px) · header ${H.w}px: title ${H.title.w}px + actions ${H.actions.map(a => `"${a.label}" ${a.w}px`).join(', ') || 'none'} · doc ${m.doc.scrollW}/${m.doc.clientW} · pageH ${m.doc.scrollH}px`)
      console.log(`${P}: ${m.taps.length} controls, shortest floored ${minFloored}px (floor ${TAP_MIN_HEIGHT_PX}px) · NAMED EXEMPTION ${exempt.length} SegmentedControl radio(s) at ${[...new Set(exempt.map(t => t.h))].join('/')}px (floor ${SEGMENTED_RADIO_MIN_PX}px): ${[...new Set(exempt.map(t => t.group))].join(', ')}${exempt.length && exempt.every(t => t.h >= TAP_MIN_HEIGHT_PX) ? ' — INERT, every one clears the real floor: delete it' : ''}`)
      console.log(`${P}: ferment line ${m.ferment.h}px, ${m.ferment.lines} line(s): "${m.ferment.text}"`)
      if (v.view === 'mine') {
        const lr = m.rows.filter(r => r.line)
        const maxRatio = Math.max(...lr.map(r => r.line.ratio))
        const long = m.rows.find(r => r.title && r.title.text === LONG_NAME)
        console.log(`${P}: ${m.rows.length} rows in ${m.groups} groups · first row y${m.rows[0].t}-${m.rows[0].b} · visible band y${m.chrome.bandTop}-${m.chrome.bandBottom}: ${inBand} row(s) fully inside it, ${inViewport} inside the bare viewport · row heights ${[...new Set(m.rows.map(r => r.h))].join('/')}px`)
        console.log(`${P}: second lines max x${maxRatio} of one line (limit ${ONE_LINE_RATIO}), ${lr.filter(r => r.line.lines !== 1).length} multi-line · titles truncated ${m.rows.filter(r => r.title && r.title.truncated).length}/${m.rows.length}`)
        console.log(`${P}: the 44-char row: title ${long.title.w}px column, ink ${long.title.inkW}px, ellipsis ${long.title.ellipsis} · line "${long.line.text}" ${long.line.h}px/${long.line.oneLineH}px, chips [${long.line.chipLabels.join(' | ')}], amount "${long.line.amount ? long.line.amount.text : '—'}" ${long.line.amount ? long.line.amount.w : 0}px (whole: ${!!(long.line.amount && long.line.amount.inLine && !long.line.amount.cut)}), rest ${long.line.restW}px of ${long.line.restInkW}px ink`)
        const gave = lr.filter(r => r.line.chipsCut > 0 || (r.line.restW != null && r.line.restInkW > r.line.restW + 1))
        console.log(`${P}: [REPORTED — gives way by design, amount asserted whole in (g)] ${gave.length} row(s) whose chips or where-from/how-old are ellipsised at this width: ${gave.map(r => `"${r.title.text}" (${r.line.chipsCut} chip(s) cut, rest ${r.line.restW}px of ${r.line.restInkW}px)`).join('; ') || 'none'}`)
      }
      if (v.view === 'saved') console.log(`${P}: ${m.cards} lot cards in ${m.sections} stage sections`)
      if (v.view === 'sow') {
        const squeezed = m.sow.cards.filter(c => c.titleLines > 2)
        console.log(`${P}: ${m.sow.buttons} buttons, ${m.sow.headings} open sections, ${m.sow.cards.length} open cards · (h) title column widths ${m.sow.cards.map(c => c.colW).join('/')}px (floor ${SOW_TITLE_COL_MIN_PX}px); [REPORTED] ${squeezed.length} card title(s) over 2 lines: ${squeezed.map(c => `"${c.title}" ${c.titleLines}L in ${c.colW}px`).join('; ') || 'none'}`)
      }
      console.log(`${P}: seed-row fetches ${m.hits['seed-rows'] ?? 0} · screenshot ${shotPath}`)

      // EVIDENCE for the two below-the-fold findings the record reports, captured only AFTER every
      // number above was read — scrolling moves the first screen, which (e) is about. The 44-char row
      // on My seeds; on Sow now, the card whose title column the action column squeezes hardest.
      const evidence = v.view === 'mine'
        ? `[...document.querySelectorAll('[data-testid="my-seed-row"]')].find(r => (r.textContent || '').includes(${JSON.stringify(LONG_NAME)}))`
        : v.view === 'sow'
          ? `(() => { const b = document.querySelector('[data-testid="sow-now-view"] button[aria-label="Add sow details for Red Mustard (heirloom, unspecified variety)"]'); return b && b.parentElement && b.parentElement.parentElement })()`
          : null
      if (evidence && await evalSettled(`(() => { const el = ${evidence}; if (!el) return false; el.scrollIntoView({ block: 'center' }); return true })()`)) {
        await evalSettled('new Promise(r=>setTimeout(r,250))')
        const extra = await cdp.send('Page.captureScreenshot', { format: 'png' }, cdp.sessionId)
        const extraPath = join(OUTDIR, `seeds-page-${v.view}-${vw}x${vh}-${v.view === 'mine' ? 'longrow' : 'squeezed'}.png`)
        writeFileSync(extraPath, Buffer.from(extra.data, 'base64'))
        console.log(`${P}: evidence screenshot ${extraPath}`)
      }
    }
  }
} catch (err) {
  fail(`gate could not complete: ${err.message}`)
} finally {
  try { cdp?.ws.close() } catch { /* already gone */ }
  chrome?.proc.kill('SIGKILL')
  harness?.kill('SIGKILL')
  try { rmSync(udd, { recursive: true, force: true }) } catch { /* best effort */ }
}

// Exit codes are NOT inverted under --probe-nothing: both outcomes there are red, and the banner says
// which one happened. An arm that exited 0 on a deliberately-broken instrument would report a KILL as
// a SURVIVAL the day someone wires it into CI.
if (failures.length) {
  console.error(PROBE_NOTHING
    ? '\n[seeds-page] FAIL — EXPECTED. --probe-nothing pointed every selector at a testid nothing renders and the instrument check caught it. This red is the proof the check fires; exit 1 is the correct outcome for this arm.'
    : '\n[seeds-page] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
if (PROBE_NOTHING) {
  console.error('\n[seeds-page] FAIL — and this one is the real defect: every selector pointed at a testid that does not exist and the gate still found nothing to complain about. The non-vacuity checks are not doing their job.')
  process.exit(1)
}
console.log('[seeds-page] PASS')
