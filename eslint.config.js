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

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/
// Emoji ranges: pictographs, symbols, dingbats, arrows, misc-technical, variation
// selectors. Matches a glyph appearing literally in source — see the Literal /
// TemplateLiteral / JSXText / JSXAttribute visitors below.
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{FE0F}]/u

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
    schema: [{
      type: 'object',
      properties: {
        defer: { type: 'array', items: { enum: ['dimensional', 'emoji'] }, uniqueItems: true },
      },
      additionalProperties: false,
    }],
    messages: {
      rawHex: "Raw hex color '{{value}}' — import a token from lib/constants.js (P) or lib/tokens.js instead.",
      rawEmoji: 'Raw emoji glyph — source it from lib/iconRegistry.js instead.',
      rawRadius: "Raw border-radius '{{value}}' on `{{prop}}` — use a T.radius* token from forms/formStyles.js.",
      rawSpace: "Raw spacing '{{value}}' on `{{prop}}` — use T.space / a named T pad token from forms/formStyles.js.",
      rawType: "Raw font-size '{{value}}' on `{{prop}}` — use the T.type ramp from forms/formStyles.js.",
    },
  },
  create(context) {
    const defer = new Set(context.options[0]?.defer ?? [])
    const dimensional = !defer.has('dimensional')
    const emoji = !defer.has('emoji')
    const src = context.sourceCode ?? context.getSourceCode()
    return {
      // (a) raw hex in any string literal, and (b) raw emoji in any string literal. The
      // plain-Literal visitor is also what covers a JSX expression container — `{'🌱'}`
      // and `glyph: '🧺'` are both just string Literals, and both used to pass.
      Literal(node) {
        if (typeof node.value !== 'string') return
        if (HEX_RE.test(node.value)) {
          context.report({ node, messageId: 'rawHex', data: { value: node.value.match(HEX_RE)[0] } })
        }
        if (emoji && EMOJI_RE.test(node.value)) {
          context.report({ node, messageId: 'rawEmoji' })
        }
      },
      // (b) raw emoji in a template literal's fixed chunks (`🌱 ${name}`).
      TemplateLiteral(node) {
        if (emoji && node.quasis.some(q => EMOJI_RE.test(q.value.raw))) {
          context.report({ node, messageId: 'rawEmoji' })
        }
      },
      JSXText(node) {
        if (emoji && EMOJI_RE.test(node.value)) {
          context.report({ node, messageId: 'rawEmoji' })
        }
      },
      JSXAttribute(node) {
        if (!emoji) return
        const v = node.value
        if (v && v.type === 'Literal' && typeof v.value === 'string' && EMOJI_RE.test(v.value)) {
          context.report({ node: v, messageId: 'rawEmoji' })
        }
      },
      // (c/d/e) raw radius / padding+margin / font-size. Keyed on the CSS property NAME, so
      // the `T = { radiusField: 7, fieldPadY: 10, ... }` declaration in formStyles.js is
      // exempt by construction — none of ITS keys is a CSS property name.
      Property(node) {
        if (!dimensional) return
        const name = propName(node)
        if (!name) return
        const messageId = DIM_PROPS.get(name)
        if (!messageId || !isRawDimension(node.value)) return
        context.report({ node, messageId, data: { prop: name, value: src.getText(node.value) } })
      },
    }
  },
}

const designsysPlugin = { rules: { 'no-raw-design-tokens': noRawDesignTokens } }

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
  //   Counts at this date, measured by this rule: 159 dimensional literals and 17 emoji
  //   across the register. Both belong to the ~3,977-literal migration, not to standing up
  //   the guard. EventTypePicker.jsx additionally carries the §5 case in its purest form —
  //   a 7-entry `emoji: '💧'` data map — and is owned by a concurrent lane at this date.
  {
    files: [
      'src/components/forms/formStyles.js',
      'src/components/forms/SegmentedControl.jsx',
      'src/components/forms/Sheet.jsx',
      'src/components/forms/TileGrid.jsx',
      'src/components/forms/Card.jsx',
      'src/components/forms/FilterChipRow.jsx',
      'src/components/forms/PageShell.jsx',
      'src/components/forms/PlantForm.jsx',
      'src/components/forms/Spinner.jsx',
      'src/components/forms/Toast.jsx',
      'src/components/forms/VarietyEditor.jsx',
    ],
    plugins: { designsys: designsysPlugin },
    rules: { 'designsys/no-raw-design-tokens': ['error', { defer: ['dimensional'] }] },
  },
  // Same register, plus an emoji deferral: these six hold raw glyphs that §5 says belong in
  // iconRegistry.js. Routing them is a behaviour-adjacent change in files this lane does
  // not own, so it is deferred WITH the count recorded rather than silently un-guarded.
  {
    files: [
      'src/components/forms/AsyncRegion.jsx',
      'src/components/forms/ChoiceGrid.jsx',
      'src/components/forms/EventTypePicker.jsx',
      'src/components/forms/Field.jsx',
      'src/components/forms/PlantingSelect.jsx',
      'src/components/forms/ScopeChecklist.jsx',
    ],
    plugins: { designsys: designsysPlugin },
    rules: { 'designsys/no-raw-design-tokens': ['error', { defer: ['dimensional', 'emoji'] }] },
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
