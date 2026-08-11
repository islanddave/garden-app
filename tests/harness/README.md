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
