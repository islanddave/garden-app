#!/usr/bin/env node
// tray-arrow-measure.mjs — a MEASUREMENT, not a gate (V5-TODAYREDESIGN-001 S4g item 5; build-s4g.md).
//
//   GATE_HARNESS_PORT=… GATE_CDP_PORT=… node scripts/layout-gate/tray-arrow-measure.mjs
//
// gate:today-shape:v2 lets FilterChipRow's tray toggle ("More ▾" / "Less ▴") paint its arrow in a host font (the
// TRAY allowance next to its font census). font-census.mjs's rule for any host-painted glyph: allowed ONLY if it
// cannot move a box, shown by swapping it for Roboto-painted ASCII and comparing geometry. This does that, in real
// Chrome at 426x836 @3 under the Roboto pin, through the V2 harness, on v2-busy and v2-frost (Needs care open by its
// trigger, its spot row pinned 3 + "More ▾"): collapsed, with a spot selected (Clear shown), and expanded ("Less ▴").
// For each: the font that painted the toggle, then every box the gate reads with the arrow and with the swap, and
// the slack left on the toggle's line. Re-run it whenever FilterChipRow's toggle or the spot row changes.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolveWebSocket } from './cdp-socket.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = Number(process.env.GATE_HARNESS_PORT || 5351)
const CDP = Number(process.env.GATE_CDP_PORT || 9451)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CLOCK = '2026-09-24T14:30:00.000Z'
if (!existsSync(CHROME)) { console.error(`Chrome not found at ${CHROME} — set CHROME_PATH`); process.exit(2) }

const vite = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), '--config', 'tests/harness/vite.harness.v2.mjs', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
const udd = mkdtempSync(join(tmpdir(), 'tray-arrow-'))
let chrome, ws
try {
  let up = false
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`http://localhost:${PORT}/tests/harness/todaymeasure.html`)).ok } catch { await sleep(250) } }
  if (!up) throw new Error(`the V2 harness never served :${PORT}`)
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${udd}`, '--window-size=900,1000', '--no-first-run', '--hide-scrollbars'], { stdio: 'ignore' })
  let ver = null
  for (let i = 0; i < 240 && !ver; i++) { try { const r = await fetch(`http://127.0.0.1:${CDP}/json/version`); if (r.ok) ver = await r.json() } catch { await sleep(250) } }
  if (!ver) throw new Error(`Chrome never exposed CDP on ${CDP}`)
  const WS = await resolveWebSocket()
  ws = new WS(ver.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket failed')) })
  let id = 0
  const pend = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } }
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) })) })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, S); await send('Runtime.enable', {}, S)
  const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, S); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }
  const frames = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))'

  // Which fonts painted the toggle's text (CSS.getPlatformFontsForNode, as font-census.mjs reads it).
  async function fontsOfToggle() {
    await ev(`(() => { const b = document.querySelector('[data-testid="care-filter-spots"] button[aria-expanded]'); if (b) b.setAttribute('data-arrow-probe', '1'); return 1 })()`)
    await send('DOM.enable', {}, S); await send('CSS.enable', {}, S)
    const { root } = await send('DOM.getDocument', { depth: 0 }, S)
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-arrow-probe="1"]' }, S)
    const out = nodeId ? (await send('CSS.getPlatformFontsForNode', { nodeId }, S)).fonts.map((f) => `${f.familyName}${f.isCustomFont ? '' : ' (HOST)'} ×${f.glyphCount}`) : ['(no toggle)']
    await send('CSS.disable', {}, S); await send('DOM.disable', {}, S)
    await ev(`(() => { for (const el of document.querySelectorAll('[data-arrow-probe]')) el.removeAttribute('data-arrow-probe'); return 1 })()`)
    return out.join(', ')
  }
  // Every box the gate reads on this surface, and the slack left on the toggle's line.
  const GEOM = `(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left * 100) / 100, Math.round((b.top + scrollY) * 100) / 100, Math.round(b.width * 100) / 100, Math.round(b.height * 100) / 100] }
    const row = document.querySelector('[data-testid="care-filter-spots"]')
    const toggle = row ? row.querySelector('button[aria-expanded]') : null
    let ink = -1; const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n
    while ((n = tw.nextNode())) { if (!n.nodeValue.trim()) continue; const rg = document.createRange(); rg.selectNodeContents(n); for (const rc of rg.getClientRects()) if (rc.width > 0.5 && rc.height > 0.5) ink = Math.max(ink, Math.ceil(rc.bottom + scrollY)) }
    const slack = (() => { if (!row || !toggle) return null; const tb = toggle.getBoundingClientRect(); const line = [...row.querySelectorAll('button')].map((b) => b.getBoundingClientRect()).filter((q) => Math.abs(q.top - tb.top) < 1); return Math.round((row.getBoundingClientRect().right - Math.max(...line.map((q) => q.right))) * 100) / 100 })()
    return {
      toggleText: toggle ? toggle.textContent : null, toggle: toggle ? r(toggle) : null,
      chips: row ? [...row.querySelectorAll('button')].map((b) => b.textContent.trim() + '@' + r(b).join(',')) : [],
      row: row ? r(row) : null, tasks: (() => { const t = document.querySelector('[data-testid="care-filter-tasks"]'); return t ? r(t) : null })(),
      care: r(document.querySelector('[data-testid="today-sec-care"]')),
      spots: [...document.querySelectorAll('[data-testid="care-spot"]')].map((s) => s.getAttribute('data-spot') + '@' + r(s).join(',')),
      scrollHeight: document.documentElement.scrollHeight, lastInk: ink, slack,
    } })()`
  const SWAP = (from, to) => `(() => { const b = document.querySelector('[data-testid="care-filter-spots"] button[aria-expanded]'); if (!b) return false; for (const n of b.childNodes) if (n.nodeType === 3 && n.nodeValue.includes(${JSON.stringify(from)})) { n.nodeValue = n.nodeValue.replace(${JSON.stringify(from)}, ${JSON.stringify(to)}); return true } return false })()`
  const diff = (a, b) => {
    const out = []
    for (const k of Object.keys(a)) {
      if (k === 'toggleText' || JSON.stringify(a[k]) === JSON.stringify(b[k])) continue
      if (Array.isArray(a[k]) && typeof a[k][0] === 'string') a[k].forEach((v, i) => { if (v !== b[k][i]) out.push(`${k}[${i}]: ${v} → ${b[k][i]}`) })
      else out.push(`${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`)
    }
    return out
  }

  for (const state of ['v2-busy', 'v2-frost']) {
    await send('Emulation.setDeviceMetricsOverride', { width: 426, height: 836, deviceScaleFactor: 3, mobile: true }, S)
    await send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' }, S)
    await send('Page.navigate', { url: `http://localhost:${PORT}/tests/harness/todaymeasure.html?state=${state}&v2=1&badge=0&clock=${encodeURIComponent(CLOCK)}` }, S)
    await sleep(300)
    let ready = false
    for (let i = 0; i < 250 && !ready; i++) { try { ready = await ev('!!(window.__h && window.__h.v2ready())') } catch { /* navigating */ } if (!ready) await sleep(100) }
    if (!ready) throw new Error(`${state} never became ready`)
    await ev('new Promise(r => setTimeout(r, 1500))')
    const pin = await ev('window.__fontPin ? window.__fontPin.source + (window.__fontPin.ok ? "" : " NOT OK") : "NO PIN"')
    console.log(`\n== ${state} · Roboto pin ${pin} · ${ver.Browser}`)
    for (const [glyph, ascii, select, expand] of [['▾', 'v', false, false], ['▾', 'v', true, false], ['▴', '^', true, true]]) {
      if (select) await ev(`(() => { const b = [...document.querySelectorAll('[data-testid="care-filter-spots"] button[aria-pressed="false"]')].find((x) => x.textContent.trim() === 'Bag Area'); if (b) b.click(); return 1 })()`)
      if (expand) await ev(`(() => { const b = document.querySelector('[data-testid="care-filter-spots"] button[aria-expanded="false"]'); if (b) b.click(); return 1 })()`)
      await ev(frames)
      const fonts = await fontsOfToggle()
      const a = await ev(GEOM)
      const swapped = await ev(SWAP(glyph, ascii)); await ev(frames)
      const b = await ev(GEOM)
      await ev(SWAP(ascii, glyph)); await ev(frames)
      const c = await ev(GEOM)
      console.log(`"${a.toggleText}"${select ? ' (a spot selected: Clear shown)' : ''} — painted by ${fonts}`)
      console.log(`  toggle [x, y, w, h] ${JSON.stringify(a.toggle)} → with '${ascii}' ${JSON.stringify(b.toggle)}${swapped ? '' : ' (SWAP NOT APPLIED)'} · row ${JSON.stringify(a.row)} · page ${a.scrollHeight}px, last ink y=${a.lastInk} · slack on the toggle's line ${a.slack}px → ${b.slack}px`)
      const moved = diff(a, b).filter((d) => !/^(toggle|slack):/.test(d) && !d.includes(`${glyph}@`))
      console.log(moved.length ? '  ALSO MOVED:\n    ' + moved.join('\n    ') : '  nothing else moved: every other chip, the row, the task row, Needs care, every spot row, the page height, the last ink')
      const back = diff(a, c)
      if (back.length) console.log('  (restore mismatch: ' + back.join('; ') + ')')
    }
  }
} finally {
  try { ws?.close() } catch { /* gone */ }
  chrome?.kill('SIGKILL'); vite.kill('SIGKILL')
  rmSync(udd, { recursive: true, force: true })
}
