// DESIGNSYS Pass A — frozen-primitives lint guard (V4-DESIGNSYS-001).
// Flat config. A local custom rule (no-raw-design-tokens) is applied to a SCOPED set
// of files only — the token-promoted primitives. It bans all FOUR classes contract §7
// demands: raw hex color, raw border-radius, raw padding/margin, raw font-size, plus raw
// emoji glyphs — so these files can only ever reference design values through the token
// (P/T) + iconRegistry surfaces.
//
// Out of scope for Pass A: the rest of the app (thousands of pre-existing literals).
// Token/icon HOMES (tokens.js, constants.js, iconRegistry.js) are intentionally NOT
// scoped — they are allowed to hold the literal values. formStyles.js is a PARTIAL
// exemption; see the `dimensional: false` override at the bottom of this file.
import js from '@eslint/js'
import tsParser from '@typescript-eslint/parser'
import globals from 'globals'
import { relative, sep } from 'node:path'

// Repo root, resolved from this file rather than from process.cwd() — see the DEFER_CAPS lookup.
const CONFIG_DIR = import.meta.dirname

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/
// BUG-EMOJIREGEX-001 — the icon-glyph class: pictographs, symbols, dingbats, misc-technical,
// geometric shapes. Matches a glyph appearing literally in source — see the Literal /
// TemplateLiteral / JSXText / JSXAttribute visitors below.
//
// The 2026-08-26 set was wrong in BOTH directions. Counts below are occurrences in the AST
// positions this rule actually visits, across src non-test at dev ddf26b1 — comments are never
// visited, so raw file-text greps overstate this corpus by roughly 10x (`→` is 440 in file text
// and 41 in linted positions).
//
//   DROPPED, the Arrows block U+2190-U+21FF (62 occurrences). `→` alone was 41 of them across
//   18 files — the single most frequent glyph the old class caught — and it is TYPOGRAPHY:
//   `Sow → Harvest` is punctuation inside a sentence, not a mark with a registry twin. `← ↑ ↓
//   ↔ ↩ ↗ ↘ ↳` came with it. U+2B00-U+2BFF is deliberately KEPT even though it also holds
//   arrows: its members carry emoji presentation by default (⬅️⬆️⬇️ render as coloured emoji),
//   which the Arrows block's do not.
//
//   DROPPED, U+FE0F on its own (15 occurrences). Variation-selector-16 never appears without a
//   base character this class already matches (`⚠️` is U+26A0 + FE0F), so as a class member it
//   changed no verdict and only inflated any global-match counter by one per glyph. U+20E3
//   replaces it for the one family whose base is otherwise unmatched — the keycaps 0️⃣-9️⃣ #️⃣ *️⃣.
//
//   ADDED, U+00D7 and the Geometric Shapes block U+25A0-U+25FF (20 + 51 occurrences). These are
//   the disclosure and dismiss marks: `▾` 28, `×` 20, `▸` 18, plus `▴ ▲ ▼ ▶ ○`. Their absence
//   made the guard TEACH THE WRONG MIGRATION — `✕` (U+2715) was banned, so an author retyped it
//   as `×` (U+00D7) and passed CI, while action.chevron sat at zero consumers.
//
// The two drops are not a new opinion: eventTypeIconWiring.test.jsx already ships the census
// regex this slice was sized with, and it excludes FE0F and the arrows for the same two reasons
// in the same words. That instrument and this one now agree; before today they did not.
const EMOJI_RE = /[\u{00D7}\u{20E3}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1FAFF}]/u

// The reported glyph, so the message can name the character that is being rejected rather than
// leaving the author to find it. Naming it is the whole point of the correction above: an author
// who cannot see WHICH mark tripped the rule is the author who substitutes a lookalike.
function firstGlyph(s) {
  const m = String(s).match(EMOJI_RE)
  return m ? m[0] : null
}

// §7's dimensional classes, keyed to the message that names the token surface to use.
// Longhand corner/side forms are included: `paddingRight: 36` is the same drift as
// `padding: 36` and was reachable before only because no visitor looked at property names.
const DIM_PROPS = new Map([
  ['borderRadius', 'rawRadius'], ['borderTopLeftRadius', 'rawRadius'], ['borderTopRightRadius', 'rawRadius'],
  ['borderBottomLeftRadius', 'rawRadius'], ['borderBottomRightRadius', 'rawRadius'],
  ['padding', 'rawSpace'], ['paddingTop', 'rawSpace'], ['paddingBottom', 'rawSpace'],
  ['paddingLeft', 'rawSpace'], ['paddingRight', 'rawSpace'],
  ['margin', 'rawSpace'], ['marginTop', 'rawSpace'], ['marginBottom', 'rawSpace'],
  ['marginLeft', 'rawSpace'], ['marginRight', 'rawSpace'],
  ['fontSize', 'rawType'],
])

// CSS-wide keywords and zero carry no design decision — `margin: 0` is the same in every
// token system, and `fontSize: 'inherit'` is a reset, not a size. Naming these would be
// indirection with no drift protection.
const KEYWORD_RE = /^(inherit|initial|unset|revert|revert-layer|auto|none)$/i
const ZERO_RE = /^0(px|rem|em|%)?$/

// A value expression is "raw" when it resolves to a literal dimension with no token in it.
// Identifiers, member expressions (T.space.sm), calls and binary expressions are treated as
// token-derived — the rule guards against re-scattering literals, not against indirection.
function isRawDimension(node) {
  if (!node) return false
  switch (node.type) {
    case 'Literal': {
      if (typeof node.value === 'number') return node.value !== 0
      if (typeof node.value !== 'string') return false
      const v = node.value.trim()
      return !(v === '' || KEYWORD_RE.test(v) || ZERO_RE.test(v))
    }
    // `${T.fieldPadY}px ${T.fieldPadX}px` is clean; `${x}px 12px` is not. Judge the
    // literal chunks only — a digit outside an interpolation is a hardcoded dimension.
    case 'TemplateLiteral':
      return node.quasis.some(q => /\d/.test(q.value.raw))
    // padding: small ? '6px 12px' : '8px 14px' — the ternary is where SelectChip's drift
    // hid from the value-shape regexes the recon used. Either branch being raw is a report.
    case 'ConditionalExpression':
      return isRawDimension(node.consequent) || isRawDimension(node.alternate)
    case 'LogicalExpression':
      return isRawDimension(node.left) || isRawDimension(node.right)
    default:
      return false
  }
}

function propName(node) {
  if (node.computed) return null
  if (node.key.type === 'Identifier') return node.key.name
  if (node.key.type === 'Literal' && typeof node.key.value === 'string') return node.key.value
  return null
}

const noRawDesignTokens = {
  meta: {
    type: 'problem',
    docs: { description: 'Ban raw hex, border-radius, padding/margin, font-size and emoji in frozen design primitives; use tokens.js / iconRegistry.js.' },
    // Per-class deferral for the debt register at the bottom of this file. `hex` is
    // deliberately NOT deferrable: an off-palette colour is the class that actually reached
    // production unseen, so no file gets to opt out of it.
    //
    // OPS-DEFERCEILING-001 — `caps` is what stops `defer` being a blank cheque. Keyed by
    // repo-relative path, it records how many violations of each deferred class the file held
    // when it was deferred. Every deferred file MUST carry an entry; a deferral with no number
    // is itself an error (messageId deferUncapped), so the ceiling cannot be dodged by omission
    // and a rename cannot silently orphan one.
    schema: [{
      type: 'object',
      properties: {
        defer: { type: 'array', items: { enum: ['dimensional', 'emoji'] }, uniqueItems: true },
        caps: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            properties: {
              dimensional: { type: 'integer', minimum: 0 },
              emoji: { type: 'integer', minimum: 0 },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    }],
    messages: {
      rawHex: "Raw hex color '{{value}}' — import a token from lib/constants.js (P) or lib/tokens.js instead.",
      rawEmoji: "Raw icon glyph '{{value}}' — source it from lib/iconRegistry.js instead. Substituting a lookalike (`×` for `✕`, `▾` for a chevron) is the drift this names, not a fix.",
      rawRadius: "Raw border-radius '{{value}}' on `{{prop}}` — use a T.radius* token from forms/formStyles.js.",
      rawSpace: "Raw spacing '{{value}}' on `{{prop}}` — use T.space / a named T pad token from forms/formStyles.js.",
      rawType: "Raw font-size '{{value}}' on `{{prop}}` — use the T.type ramp from forms/formStyles.js.",
      deferCeiling: "{{file}} holds {{actual}} raw {{cls}} literals but its recorded ceiling is {{cap}}. A deferral postpones the EXISTING debt; it does not license new debt. Route the additions through lib/constants.js (P) / forms/formStyles.js (T) / lib/iconRegistry.js — or, if the growth is genuinely unavoidable, raise this file's `caps.{{cls}}` to {{actual}} in eslint.config.js IN THE SAME COMMIT and say in the message why the number moved.",
      deferUncapped: "{{file}} defers the {{cls}} class with no recorded ceiling. Add a DEFER_CAPS entry for it in eslint.config.js recording {{cls}}: {{actual}} — an uncapped deferral is an unbounded one, which is how a guarded file grew +841 lines and +32 violations with CI green.",
    },
  },
  create(context) {
    const opts = context.options[0] ?? {}
    const defer = new Set(opts.defer ?? [])
    const caps = opts.caps ?? {}
    const dimensional = !defer.has('dimensional')
    const emoji = !defer.has('emoji')
    const src = context.sourceCode ?? context.getSourceCode()
    // OPS-DEFERCEILING-001 — a deferred class is COUNTED here, not discarded. The count is
    // compared against the file's recorded ceiling at Program:exit. Before this, `defer` meant
    // "stop looking", which is why ScopeChecklist.jsx could take on 32 more violations inside
    // the guarded scope without CI noticing.
    const deferred = { dimensional: 0, emoji: 0 }
    // Relative to THIS FILE's directory, not to context.cwd. The caps are keyed by repo-relative
    // path, and cwd is whatever ESLint was invoked from — `eslint .` at the root and an editor
    // integration running per-file from a subdirectory would otherwise produce different keys,
    // and a missed key is a hard deferUncapped error, not a quiet miss.
    const filename = context.filename ?? context.getFilename()
    const rel = relative(CONFIG_DIR, filename).split(sep).join('/')

    // One door for every emoji-class hit, so the deferred branch can never diverge from the
    // reported one — a counter that counts something other than what the rule would report is
    // a ceiling calibrated against nothing. Returns whether a glyph was found.
    function reportGlyph(node, text) {
      const glyph = firstGlyph(text)
      if (!glyph) return false
      if (emoji) context.report({ node, messageId: 'rawEmoji', data: { value: glyph } })
      else deferred.emoji++
      return true
    }

    return {
      // (a) raw hex in any string literal, and (b) raw emoji in any string literal. The
      // plain-Literal visitor is also what covers a JSX expression container — `{'🌱'}`
      // and `glyph: '🧺'` are both just string Literals, and both used to pass.
      Literal(node) {
        if (typeof node.value !== 'string') return
        if (HEX_RE.test(node.value)) {
          context.report({ node, messageId: 'rawHex', data: { value: node.value.match(HEX_RE)[0] } })
        }
        reportGlyph(node, node.value)
      },
      // (b) raw emoji in a template literal's fixed chunks (`🌱 ${name}`). Tests `cooked`,
      // not `raw`: raw is undecoded source, so `\u{1F33F}` reads as a backslash-u sequence
      // and slips through. cooked is the decoded string and covers both spellings; it is
      // null only for an invalid escape in a tagged template, hence the fallback.
      TemplateLiteral(node) {
        for (const q of node.quasis) {
          if (reportGlyph(node, q.value.cooked ?? q.value.raw)) return
        }
      },
      JSXText(node) {
        reportGlyph(node, node.value)
      },
      JSXAttribute(node) {
        const v = node.value
        if (!v || v.type !== 'Literal' || typeof v.value !== 'string') return
        reportGlyph(v, v.value)
      },
      // (c/d/e) raw radius / padding+margin / font-size. Keyed on the CSS property NAME, so
      // the `T = { radiusField: 7, fieldPadY: 10, ... }` declaration in formStyles.js is
      // exempt by construction — none of ITS keys is a CSS property name.
      Property(node) {
        const name = propName(node)
        if (!name) return
        const messageId = DIM_PROPS.get(name)
        if (!messageId || !isRawDimension(node.value)) return
        if (!dimensional) { deferred.dimensional++; return }
        context.report({ node, messageId, data: { prop: name, value: src.getText(node.value) } })
      },
      // OPS-DEFERCEILING-001 — the ceiling itself. Reported on Program so the message lands at
      // 1:1 of the offending file rather than on whichever literal happened to be last.
      //
      // The caps are MEASUREMENTS TAKEN ON 2026-09-02, not judgements about how much debt each
      // file deserves. That distinction matters when this fires: the ceiling is "do not grow the
      // debt", never "never touch this file". A legitimate widening — a file gaining a real new
      // control, a folder-clean that moves literals in — is expected to raise its own number in
      // the same commit, which is a deliberate, greppable, reviewable act. That is the whole
      // difference from today, where the same growth was silent.
      'Program:exit'(node) {
        for (const cls of defer) {
          const cap = caps[rel]?.[cls]
          const actual = deferred[cls]
          if (cap === undefined) {
            context.report({ node, messageId: 'deferUncapped', data: { file: rel, cls, actual } })
          } else if (actual > cap) {
            context.report({ node, messageId: 'deferCeiling', data: { file: rel, cls, cap, actual } })
          }
        }
      },
    }
  },
}

const designsysPlugin = { rules: { 'no-raw-design-tokens': noRawDesignTokens } }

// ── DEFERRAL CEILINGS (OPS-DEFERCEILING-001) ─────────────────────────────────────────────
// Every file in the debt register below carries its violation count for each class it defers.
// Exceeding the number is an ESLint error; omitting the entry is also an ESLint error.
//
// READ THIS BEFORE YOU EDIT A NUMBER. These are MEASUREMENTS TAKEN ON 2026-09-02, produced by
// running this exact rule over each file with its defer list emptied. They are not budgets and
// not opinions about how much debt a file has earned. A count-based ceiling is deliberately
// crude and it WILL fire on a legitimate widening — a primitive gaining a genuinely new control
// adds real literals — so the intended response to a red is either "route the new ones through
// P / T / iconRegistry" or "raise this file's number, in the same commit, and say why in the
// message". What it forbids is the third option that used to be free: adding debt to a deferred
// file and having CI stay green.
//
// WHY: on 2026-08-26 this register recorded ScopeChecklist.jsx at 26. It measures 58 today —
// +841 lines and +32 violations inside the guarded scope, every one of them invisible because
// `defer` meant "stop looking" rather than "stop growing". The drift ran both ways: the same
// re-measurement found EventTypePicker at 13 against a recorded 18 and ChoiceGrid at 9 against
// 11, so the old prose counts were stale in both directions and nothing could tell.
//
// UNITS: a cap counts violating SITES — the reports the rule would have made — not characters.
// `'▸▾'` in one literal is one emoji site, because the rule reports per node. Verified by
// mutation: adding a glyph to an existing literal does not move the count; adding a new
// `<span>{'○'}</span>` moves FacetGroupHeader from 2 to 3 and reds the build.
//
// Renaming a file here without updating the key produces deferUncapped rather than a silent
// pass, which is the same anti-stale property eslintScopeStale.test.js asserts, enforced at
// lint time instead of at test time.
const DEFER_CAPS = {
  // dimensional-only deferrals
  'src/components/forms/formStyles.js': { dimensional: 16 },
  'src/components/forms/SegmentedControl.jsx': { dimensional: 5 },
  'src/components/forms/Sheet.jsx': { dimensional: 9 },
  'src/components/forms/TileGrid.jsx': { dimensional: 6 },
  'src/components/forms/Card.jsx': { dimensional: 2 },
  'src/components/forms/PageShell.jsx': { dimensional: 6 },
  'src/components/forms/PlantForm.jsx': { dimensional: 14 },
  'src/components/forms/Spinner.jsx': { dimensional: 2 },
  'src/components/forms/Toast.jsx': { dimensional: 3 },
  'src/components/forms/VarietyEditor.jsx': { dimensional: 23 },
  // dimensional + emoji deferrals
  'src/components/forms/AsyncRegion.jsx': { dimensional: 8, emoji: 1 },
  'src/components/forms/ChoiceGrid.jsx': { dimensional: 9, emoji: 0 },
  'src/components/forms/EventTypePicker.jsx': { dimensional: 11, emoji: 2 },
  'src/components/forms/Field.jsx': { dimensional: 0, emoji: 1 },
  'src/components/forms/FilterChipRow.jsx': { dimensional: 8, emoji: 2 },
  'src/components/forms/PlantingSelect.jsx': { dimensional: 31, emoji: 6 },
  'src/components/forms/ScopeChecklist.jsx': { dimensional: 51, emoji: 7 },
  // emoji-only deferrals (BUG-EMOJIREGEX-001, 2026-09-02)
  'src/components/PhotoUpload.jsx': { emoji: 1 },
  'src/components/forms/FacetGroupHeader.jsx': { emoji: 2 },
  'src/components/forms/TagChip.jsx': { emoji: 1 },
}

// Stub react-hooks plugin: the app carries inline `// eslint-disable-...
// react-hooks/exhaustive-deps` directives. Pass A does NOT introduce the
// eslint-plugin-react-hooks dependency (out of scope), but ESLint errors on a
// disable directive that references an unregistered rule. Registering no-op rules
// lets those directives resolve harmlessly. These rules never report — they are
// placeholders, not an enforcement of hooks linting.
const noop = { create() { return {} } }
const reactHooksStub = { rules: { 'exhaustive-deps': noop, 'rules-of-hooks': noop } }

export default [
  // Base: permissive for the whole app so `eslint .` exits 0 (Pass A does not lint
  // pre-existing literals app-wide). No recommended ruleset enabled globally.
  {
    files: ['**/*.{js,jsx,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    plugins: { 'react-hooks': reactHooksStub },
    rules: {},
  },
  // ── Scoped guard: the frozen primitives ───────────────────────────────────────────────
  // A GLOB over the primitive barrel, not a hand-maintained file list. The list this
  // replaced named 9 files and MISSED FIVE SHIPPED PRIMITIVES — PhotoUpload plus all four
  // tag primitives (TagChip, FacetGroupHeader, TagFilterBar, GroupByControl) — which is
  // how PhotoUpload's off-palette #b14a3c reached prod invisible to CI. The failure mode of
  // a list is SILENT omission: nothing reports that a new primitive was never added to it.
  // With a glob, a file dropped into components/forms/ is guarded by default and has to be
  // opted OUT deliberately, in the register below, where the omission is greppable.
  {
    files: [
      'src/components/forms/**/*.{js,jsx}',
      'src/components/PlantStatusBadge.jsx',
      'src/components/SeverityBadge.jsx',
      'src/components/PhotoUpload.jsx',
      'src/lib/status.js',
    ],
    plugins: { designsys: designsysPlugin },
    rules: { 'designsys/no-raw-design-tokens': 'error' },
  },
  // ── DEBT REGISTER — per-class deferrals, dated 2026-08-26 ─────────────────────────────
  // These are NOT `ignores` entries. An ignore drops every class at once; `defer` names
  // exactly which class is being postponed and leaves the rest enforced. Raw HEX is
  // enforced on every file below with no opt-out available — an off-palette colour
  // (PhotoUpload's #b14a3c) is the drift that actually reached production unseen.
  //
  // This is a shrinking register: entries come OFF as the bulk literal migration reaches
  // each file. Adding a file here to make a build pass inverts its purpose.
  //
  //   formStyles.js is the one PERMANENT entry — it is the token HOME for space/radius/
  //   type. Its `T = { radiusField: 7, … }` declaration is already exempt by construction
  //   (the rule keys on CSS property NAMES and none of T's keys is one), but its chrome
  //   helpers compose pixel values inline, and banning literals in the file that DEFINES
  //   the ramp would force ~9 single-use names pointing at values 90 lines above them.
  //
  //   SegmentedControl / Sheet / TileGrid were in the pre-widening scope for hex+emoji
  //   only, so their coverage is UNCHANGED here, not reduced (20 dimensional literals
  //   between them; 3 already have exact T names — SegmentedControl's radius 12/10 and its
  //   0.82/0.9rem fonts). Every other file below was guarded by NOTHING before the glob.
  //
  //   THE LIVE COUNTS ARE IN `DEFER_CAPS` ABOVE, and they are enforced. The prose list that
  //   stood here — "162 dimensional + 17 emoji = 179; worst first PlantingSelect 36,
  //   ScopeChecklist 26, VarietyEditor 23, EventTypePicker 18…" — was measured on 2026-08-26
  //   and had gone stale in BOTH directions by 2026-09-02: ScopeChecklist measured 58 against
  //   its recorded 26, while EventTypePicker measured 13 against 18 and ChoiceGrid 9 against
  //   11. A number that lives only in a comment cannot be wrong loudly. It is kept here as
  //   history, not as a figure to trust; re-measure via DEFER_CAPS, never from this paragraph.
  //
  //   Every file here is still hex-CLEAN — the deferral costs nothing on the class that
  //   reached prod. EventTypePicker.jsx additionally carries the §5 case in its purest form —
  //   a 7-entry `emoji: '💧'` data map.
  {
    files: [
      'src/components/forms/formStyles.js',
      'src/components/forms/SegmentedControl.jsx',
      'src/components/forms/Sheet.jsx',
      'src/components/forms/TileGrid.jsx',
      'src/components/forms/Card.jsx',
      'src/components/forms/PageShell.jsx',
      'src/components/forms/PlantForm.jsx',
      'src/components/forms/Spinner.jsx',
      'src/components/forms/Toast.jsx',
      'src/components/forms/VarietyEditor.jsx',
    ],
    plugins: { designsys: designsysPlugin },
    rules: { 'designsys/no-raw-design-tokens': ['error', { defer: ['dimensional'], caps: DEFER_CAPS }] },
  },
  // Same register, plus an emoji deferral: these seven hold raw glyphs that §5 says belong in
  // iconRegistry.js. Routing them is a behaviour-adjacent change in files this lane does
  // not own, so it is deferred WITH the count recorded rather than silently un-guarded.
  //
  //   FilterChipRow.jsx moved up from the dimensional-only block on 2026-09-02 for its
  //   `More ▾` / `Less ▴` toggle — see the icon-glyph block below for why two carets that
  //   were green yesterday are debt today.
  {
    files: [
      'src/components/forms/AsyncRegion.jsx',
      'src/components/forms/ChoiceGrid.jsx',
      'src/components/forms/EventTypePicker.jsx',
      'src/components/forms/Field.jsx',
      'src/components/forms/FilterChipRow.jsx',
      'src/components/forms/PlantingSelect.jsx',
      'src/components/forms/ScopeChecklist.jsx',
    ],
    plugins: { designsys: designsysPlugin },
    rules: { 'designsys/no-raw-design-tokens': ['error', { defer: ['dimensional', 'emoji'], caps: DEFER_CAPS }] },
  },
  // ── ICON-GLYPH DEFERRALS — dated 2026-09-02, BUG-EMOJIREGEX-001 ───────────────────────
  // Widening EMOJI_RE to see `× ▾ ▸ ▴ ○` (see the class definition at the top of this file)
  // turned six sites across four files from green to red in one edit. Three of those files
  // had NOTHING deferred, so they land here rather than in the register above:
  //
  //     PhotoUpload.jsx:446      `×`      photo-remove control
  //     FacetGroupHeader.jsx:26  `▸` `▾`  collapse chevron
  //     TagChip.jsx:37           `×`      chip dismiss
  //     FilterChipRow.jsx:136    `▴` `▾`  More/Less toggle (moved into the block above)
  //
  // Deferred, not routed. Every one of them is a rendered mark on a shipped surface, and
  // swapping it for `<Icon name="action.chevron">` is a visual change in four files this lane
  // does not own during a nine-lane concurrent window — the same reasoning the 2026-08-26
  // register applied to its own six. The alternative was leaving `eslint .` red, and a guard
  // fix that freezes the promote is a worse outcome than the bug it fixes.
  //
  // ONLY the emoji class is deferred. Hex is non-deferrable by schema and dimensional stays
  // enforced on all three — PhotoUpload in particular is the file whose off-palette #b14a3c
  // reached prod, and nothing about a caret earns it an exemption from that.
  {
    files: [
      'src/components/PhotoUpload.jsx',
      'src/components/forms/FacetGroupHeader.jsx',
      'src/components/forms/TagChip.jsx',
    ],
    plugins: { designsys: designsysPlugin },
    rules: { 'designsys/no-raw-design-tokens': ['error', { defer: ['emoji'], caps: DEFER_CAPS }] },
  },
  // OPS-SETUPTSUNLINTED-001 — TypeScript files matched NO config object above, so ESLint
  // skipped all five of them outright: `eslint src/__tests__/setup.ts` reported "File ignored
  // because no matching configuration was supplied" and `--print-config` returned `undefined`.
  // Not an `ignores` entry — `--no-ignore` made no difference; the base block's `files` glob is
  // `**/*.{js,jsx,mjs,cjs}` and nothing else claimed `.ts`. The casualty that matters is
  // src/__tests__/setup.ts, the vitest setup file every one of the 700+ test files inherits its
  // global hooks from — the widest blast radius in the suite was the one file nothing linted.
  //
  // espree cannot parse the annotations (`Parsing error: Unexpected token :` on the first return
  // type), so bringing them in needs the TS parser. Glob rather than an explicit file list — the
  // defect WAS "nothing matches .ts", and a list would recreate it for the next file added.
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      // vitest.config.ts sets `globals: true`, so the hook names really are ambient here.
      // `globals@14` ships no vitest key, hence the explicit map.
      globals: {
        ...globals.browser,
        ...globals.node,
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
      },
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    // ESLint's own baseline, not a house invention: no-undef, no-unused-vars, no-empty,
    // no-dupe-keys and friends. Verified clean across all five .ts files at v4.43.0, so this
    // starts green. The JS side stays rule-free (Pass A scope) — this does not change it.
    rules: { ...js.configs.recommended.rules },
  },
  // Never lint build output / deps.
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
]
