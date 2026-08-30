# Mobile layout-measurement harness

Answers, mechanically and at real mobile geometry, questions that **nothing else in this repo can
answer**:

| | question | method |
|---|---|---|
| **A** | Is the Save control's `getBoundingClientRect().bottom <= innerHeight` with a planting selected, a quantity filled, and the keypad open? | `__h.stateA()` → `__h.measureA()` |
| **B** | How many `pointerdown` events does a scripted N-harvest run cost? | `__h.runHarvestScript({n})` |
| **C** | Does the quantity chip row wrap at its longest label at 390px? | `__h.measureC({longestLabel})` |

Two things make this necessary and neither is going away:

* **jsdom has no layout engine.** Every `getBoundingClientRect()` in a vitest run returns zeros. No
  test in `src/__tests__/**` can falsify an "above the fold" claim, at any viewport.
* **The in-app Browser pane is not Dave's signed-in Chrome.** Loading the real app there lands on the
  Clerk gate. The harness stubs auth so the page under test is reachable at all.

## Run it

```bash
# one command; add HARNESS_BASELINE_SHA to pin src/** to a git object (see below)
cd garden-app && npx vite --config tests/harness/vite.harness.config.mjs
# → http://localhost:5311/tests/harness/
```

There is also a `harness` entry in `.claude/launch.json` for `preview_start`. Prefer it when it
works; it refuses to start while another session holds a port listed in that file, in which case run
the command above and open the URL with `preview_start({url})`.

Then, from the Browser pane (`mcp__Claude_Browser__*`):

```js
// resize_window({width:390, height:844})  ← normal
// resize_window({width:390, height:500})  ← keyboard open (see "Emulating the keyboard")

// javascript_tool does NOT await promises. Fire, then poll:
window.__go = f => { window.__r={state:'running'}; f().then(v=>window.__r={state:'done',v}).catch(e=>window.__r={state:'error',e:String(e)}); return 'started' }
__go(() => __h.stateA({quantityMode:'chip'}))     // then read window.__r
__go(() => __h.runHarvestScript({n:5, surface:'overlay', quantityMode:'chip'}))
__h.measureC({longestLabel:'12'})                  // synchronous
__h.surface('fullpage')                            // or 'overlay' (default)
```

`?surface=fullpage` in the URL works too.

### Measuring a true 390-wide layout — `viewport.html`

⚠️ **`--window-size=390,500` on a headless Chrome does NOT reflow to 390px.** macOS Chrome floors a
window at roughly 500px wide and **crops** the screenshot instead, so you measure a 500px layout,
every coordinate past ~500px is silently absent, and laid-out text reads as clipped. Nothing errors.

`viewport.html` is the fix: an iframe has no minimum width, so it is a real layout viewport at
whatever size the host gives it inside a normally-sized window.

```
http://localhost:5311/tests/harness/viewport.html?vw=390&vh=500&surface=fullpage&session=harvest
```

`vw`/`vh` size the frame; every other param is forwarded to the harness page. Same origin, so a
driver reaches straight through `frames[0]` for both `__h` and the document. Confirm
`frames[0].innerWidth === 390` in any run that quotes a number from it.

### Pinning to a SHA — `HARNESS_BASELINE_SHA`

This checkout is shared by concurrent Claude sessions. While this harness was being built, another
session already had `src/pages/EventNew.jsx` modified, so an unpinned run would have measured
somebody's in-flight edit and reported it as the baseline.

```bash
HARNESS_BASELINE_SHA=eeb7019dd51675d7b12df363db4b379f9767fc1e npx vite --config tests/harness/vite.harness.config.mjs
```

`baselinePlugin.mjs` serves every `src/**` module from `git show <sha>:<path>` at load time. Vite
still believes each module lives at its real path, so relative imports resolve normally and nothing
is written to the working tree. Paths absent at that SHA fall through to disk. The server prints
`[harness] serving src/** from git <full sha>` on start — **if you do not see that line, you are
measuring the working tree.**

### Emulating the keyboard

`index.html` copies the app's viewport meta verbatim, including
`interactive-widget=resizes-content`. That key means the soft keyboard **shrinks the layout
viewport** rather than covering it. Resizing the browser to 390×500 therefore reproduces the
keyboard-open layout exactly — the same `innerHeight` the sticky footer resolves its `bottom`
against. There is no keyboard to open and nothing about the emulation is approximate for layout
purposes.

If `index.html`'s viewport meta ever diverges from `../../index.html`, every number this harness
produces is void. `src/__tests__/viewportMeta.static.test.js` guards the app's copy; nothing guards
this one.

## Files

| file | role |
|---|---|
| `index.html` | entry page; **viewport meta copied verbatim from the app** |
| `viewport.html` | iframe host — the only honest way to measure a sub-500px layout in headless Chrome |
| `main.jsx` | mounts real `EventNew` in the two real surfaces; global `fetch` stub; `window.__h` |
| `harnessApi.js` | tap/type synthesis, counters, `measureA`, `measureC`, hidden-tab scheduling |
| `script.js` | the scripted N-harvest journey — **read its header before quoting a tap number** |
| `stubs/clerk.jsx` | `@clerk/react` stand-in (aliased only in the harness config) |
| `stubs/fixtures.js` | 24 plantings / 2 projects / event POST responses |
| `baselinePlugin.mjs` | serves `src/**` from a git object |
| `vite.harness.config.mjs` | port 5311, Clerk alias, baseline plugin |
| `BASELINE-eeb7019.json` | the recorded baseline this harness was built to capture |

Nothing under `src/` or `lambda/` is touched, imported-from-only.

## Limits — what this harness CANNOT prove

State these whenever a number from here is quoted.

1. **It is Chrome DevTools mobile emulation, not a phone.** Real Chrome on Dave's Android adds a URL
   bar that shrinks and grows on scroll, a real IME with its own height, `env(safe-area-inset-*)`
   values that are 0 here, and OS font scaling. A 12px clearance measured here is 12px of *layout*
   slack, not proof of on-device comfort.
2. **`env(safe-area-inset-bottom)` is 0 in the emulator.** Every "slack" figure is an upper bound on
   a device with a gesture bar.
3. **The tap count is only as honest as `script.js`.** It deliberately excludes the taps to *open*
   the log surface (bottom-nav `+` → "Log one"), because the harness mounts the page directly. Add
   that constant before comparing against any end-to-end model.
4. **`BottomNav` is a stand-in on the full-page surface.** Only its height constant is reproduced.
   Its internal layout, safe-area padding and z-index behaviour are not.
5. **The network is fixtures.** Latency is a few macrotask turns, not a real Lambda. Anything whose
   layout depends on a slow or failed response (spinners, error banners, the photo-upload progress
   label) is not exercised.
6. **Auth is stubbed.** Anything gated on a real Clerk claim (admin-only surfaces) does not render.
7. **A hidden Browser pane defers focus events and clamps timers.** `harnessApi.js` compensates by
   synthesising `focusin`/`focusout` and scheduling on `MessageChannel`. Layout is unaffected —
   `getBoundingClientRect` is live in a hidden tab — but *timing-sensitive* behaviour (a 150ms
   blur-close race, an animation) is not faithfully reproduced.
8. **It measures layout, not usability.** "Above the fold" is a geometric predicate. Reachability by
   thumb, contrast, and hit-target comfort are outside it.

## `plantingphotosheet.*` — the batch sheet, added 2026-08-30

`PlantingPhotoSheet` shipped in v4.75.0 having never been rendered in a browser. This entry mounts it
directly (no `AuthContext` anywhere in its import graph — see the note under Retired entries) and
stages a real batch by firing a `change` on the real hidden input, so the maxFiles cap, the
"only 10 at a time" notice and the serial upload queue all run. `window.fetch` and
`XMLHttpRequest` are replaced; nothing else is.

```
http://localhost:5325/tests/harness/plantingphotosheet.viewport.html?vw=390&vh=844&n=20
    n=0|1|5|20   how many files the picker hands over (20 exercises the 10-file cap + its notice)
    fail=1       presign 503s, so every row lands in the per-file error state — the tallest tile
    verdict=0    hide the measurement bar, for a screenshot of the surface alone
```

`plantingphotosheet.viewport.html` is a second iframe host: `viewport.html` hardcodes `index.html` as
its frame src, and three entries depend on it, so this one takes a `?page=`. It also mirrors
`frames[0].__h.all()` into an off-screen `<pre id="out">` — a session with no Browser-pane tools can
then read every number out of `chrome --headless --dump-dom` instead of a driver. `__h` is unchanged
and still callable directly: `overflow()`, `sheet()`, `strip()`, `tapTargets()`, `actionRow()`.

Launch entry `plantingphotosheet-harness` (port 5325). What it found, and the fixes, are in
`Projects/Gardening/_lane_reports/psheetverify-20260830.md`.

## Retired entries

**`photostrips.*` — removed 2026-08-30, V4-PHOTOBULK-001 D4b.** It measured the staged-photo strip
*inside a planting card* and found the defect that killed that design: ten staged files grew the card
from ~250px to 802px and pushed the next planting card off an 844px screen, and once the height was
capped the compact filename rows collided with the card's own status badge. The strip now lives in
`PlantingPhotoSheet`, so the surface this entry measured no longer exists. The finding is preserved
where it can still act on someone — in `PlantingTile.jsx`'s comment at the call site, in
`PlantingPhotoSheet.jsx`'s header, and in `photobulk-drain-design-V100-20260829.md` D4b.

Note for whoever adds the next entry: `photostrips` wrapped the card in the real `AuthProvider`
(FavoriteToggle needs it) and, in a fresh worktree, that path hit a dual-React "Invalid hook call"
that survived clearing `node_modules/.vite`. `quicktag.jsx` in the same worktree, which imports no
auth context, is unaffected. If you need an auth-wrapped entry, budget for that rather than
discovering it mid-measurement.
