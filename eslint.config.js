// Flat config. The local rule no-raw-design-tokens applies to a SCOPED set of files only, the token-promoted
// primitives: it bans raw hex colour, border-radius, padding/margin, font-size and icon glyphs, so those files
// reference design values only through the tokens (P/T) and iconRegistry. The rest of the app is not linted for
// literals. Token/icon HOMES (tokens.js, constants.js, iconRegistry.js) are NOT scoped: they hold the values.
// formStyles.js is a partial exemption, in the debt register at the bottom of this file.
import js from '@eslint/js'
import tsParser from '@typescript-eslint/parser'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import { relative, sep } from 'node:path'

// Repo root, resolved from this file rather than from process.cwd() — see the DEFER_CAPS lookup.
const CONFIG_DIR = import.meta.dirname

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/
// The icon-glyph class: pictographs, symbols, dingbats, misc-technical, geometric shapes. Matched only where
// the Literal / TemplateLiteral / JSXText / JSXAttribute visitors below look; comments are never visited.
//   OUT: the Arrows block U+2190-U+21FF (`Sow → Harvest` is typography, not a mark with a registry twin), and
//   U+FE0F alone (it never appears without a base this class already matches). U+20E3 is IN instead, for the
//   keycaps, whose base is otherwise unmatched.
//   IN although it holds arrows: U+2B00-U+2BFF, whose members render as coloured emoji by default.
//   IN: U+00D7 and Geometric Shapes U+25A0-U+25FF, the disclosure and dismiss marks (`× ▾ ▸ ▴ ▲ ▼ ▶ ○`).
//   Without them the guard teaches the wrong migration: a banned `✕` retyped as `×` passes.
// eventTypeIconWiring.test.jsx's census regex leaves out the same two ranges for the same reasons; keep the
// two in step.
const EMOJI_RE = /[\u{00D7}\u{20E3}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1FAFF}]/u

// The reported glyph, so the message names the rejected character: an author who cannot see WHICH mark
// tripped the rule substitutes a lookalike.
function firstGlyph(s) {
  const m = String(s).match(EMOJI_RE)
  return m ? m[0] : null
}

// §7's dimensional classes, keyed to the message that names the token surface to use.
// Longhand corner/side forms are included: `paddingRight: 36` is the same drift as `padding: 36`.
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
    // padding: small ? '6px 12px' : '8px 14px': either branch being raw is a report.
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
    // Per-class deferral for the debt register at the bottom of this file. `hex` is deliberately NOT
    // deferrable: an off-palette colour is the class that reached production unseen, so no file opts out.
    // `caps` stops `defer` being a blank cheque: keyed by repo-relative path, it records each deferred class's
    // violation count. Every deferred file MUST carry an entry; a deferral with no number is itself an error
    // (deferUncapped), so the ceiling cannot be dodged by omission and a rename cannot silently orphan one.
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
    // A deferred class is COUNTED here, not discarded, and the count is compared against the file's
    // recorded ceiling at Program:exit: `defer` means "stop growing", not "stop looking".
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
      // plain-Literal visitor is also what covers a JSX expression container: `{'🌱'}`
      // and `glyph: '🧺'` are both just string Literals.
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
      // The ceiling itself. Reported on Program so the message lands at 1:1 of the offending file rather
      // than on whichever literal happened to be last. DEFER_CAPS says how to respond when it fires.
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

// Core `no-unused-vars` does not see `<Foo />` as a use of `Foo`, so without this every
// component imported only for JSX is reported. Same logic as eslint-plugin-react's
// jsx-uses-vars, kept local to avoid a dependency for ten lines. Never reports.
const jsxUsesVars = {
  create(context) {
    return {
      JSXOpeningElement(node) {
        let root = node.name
        if (root.type === 'JSXNamespacedName') return
        while (root.type === 'JSXMemberExpression') root = root.object
        if (/^[a-z]/.test(root.name)) return
        context.sourceCode.markVariableAsUsed(root.name, node)
      },
    }
  },
}
const jsxPlugin = { rules: { 'uses-vars': jsxUsesVars } }

// DEFERRAL CEILINGS. Every file in the debt register below carries its violation count for each class it
// defers. Exceeding the number is an ESLint error; omitting the entry is also an ESLint error.
// They are measurements (this rule run over the file with its defer list emptied), not budgets. A count-based
// ceiling WILL fire on a legitimate widening: respond by routing the new literals through P / T / iconRegistry,
// or by raising this file's number in the same commit and saying why in the message. What it forbids is adding
// debt to a deferred file with CI green.
// UNITS: a cap counts violating SITES (the reports the rule would make), not characters: `'▸▾'` in one literal
// is one emoji site, because the rule reports per node.
// Renaming a file without updating its key produces deferUncapped rather than a silent pass: the same
// anti-stale property eslintScopeStale.test.js asserts, enforced at lint time.
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
  // emoji-only deferrals
  'src/components/PhotoUpload.jsx': { emoji: 1 },
  'src/components/forms/FacetGroupHeader.jsx': { emoji: 2 },
  'src/components/forms/TagChip.jsx': { emoji: 1 },
}

export default [
  // Base: permissive for the whole app so `eslint .` exits 0. No recommended ruleset enabled
  // globally. The plugin is registered here so disable directives resolve in every file.
  {
    files: ['**/*.{js,jsx,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    plugins: { 'react-hooks': reactHooks, jsx: jsxPlugin },
    rules: {},
  },
  // Hooks exist only in the browser app, so these rules cover app source only. The two hooks
  // rules are named individually because the plugin's `recommended` set also carries the
  // React Compiler rules, which this app is not written against. Lambda and
  // integration tests have functions named `use*` that are not hooks, and test mocks define
  // components inline (`default: () => { React.useEffect(...) }`) that the rule cannot name.
  // `no-unused-vars` and `no-undef` warn rather than error so existing findings do not block
  // the build while the count is worked down.
  {
    files: ['src/**/*.{js,jsx,mjs}'],
    ignores: ['src/**/__tests__/**', 'src/**/*.test.{js,jsx,mjs}'],
    languageOptions: {
      // __APP_VERSION__ is a Vite `define` (vite.config.js), not a real global.
      globals: { ...globals.browser, ...globals.es2021, __APP_VERSION__: 'readonly' },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': ['warn', {
        args: 'after-used',
        ignoreRestSiblings: true,
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-undef': 'warn',
      'jsx/uses-vars': 'error',
    },
  },
  // Scoped guard, the frozen primitives: a GLOB over the primitive barrel, not a hand-maintained file list.
  // A list fails by SILENT omission: nothing reports a new primitive that was never added to it. With the
  // glob, a file dropped into components/forms/ is guarded by default and is opted OUT only in the register
  // below, where that is greppable. eslintScopeStale.test.js holds the glob and the named files to the tree.
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
  // DEBT REGISTER: per-class deferrals. NOT `ignores` entries: an ignore drops every class at once;
  // `defer` names exactly which class is postponed and leaves the rest enforced. Raw HEX is enforced on
  // every file below with no opt-out. A shrinking register: entries come OFF as the literal migration
  // reaches each file, and adding a file here to make a build pass inverts its purpose. The live counts
  // are DEFER_CAPS above, enforced; never keep a count in a comment, where it cannot be wrong loudly.
  //   formStyles.js is the one PERMANENT entry: it is the token HOME for space/radius/type. Its `T`
  //   declaration is exempt by construction (the rule keys on CSS property NAMES and none of T's keys is
  //   one), but its chrome helpers compose pixel values inline, and banning literals in the file that
  //   DEFINES the ramp would force single-use names for values defined a few lines above.
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
  // Same register, plus an emoji deferral: these hold raw glyphs that belong in iconRegistry.js.
  // Routing them is a visual change, so it is deferred WITH the count recorded rather than un-guarded.
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
  // Icon-glyph deferrals: files whose only deferred debt is glyphs (`×` dismiss, `▸ ▾` chevrons) the
  // icon-glyph class catches. Each is a rendered mark on a shipped surface, and swapping it for an
  // `<Icon>` is a visual change, so it is deferred, not routed. ONLY the emoji class: hex is
  // non-deferrable by schema and dimensional stays enforced on all three.
  {
    files: [
      'src/components/PhotoUpload.jsx',
      'src/components/forms/FacetGroupHeader.jsx',
      'src/components/forms/TagChip.jsx',
    ],
    plugins: { designsys: designsysPlugin },
    rules: { 'designsys/no-raw-design-tokens': ['error', { defer: ['emoji'], caps: DEFER_CAPS }] },
  },
  // TypeScript files. The base block's glob is JS-only, so without this block ESLint skips every .ts
  // file ("File ignored because no matching configuration was supplied"), src/__tests__/setup.ts
  // included: the vitest setup file whose global hooks the dom-project tests inherit. espree cannot
  // parse the annotations, hence the TS parser. A glob, not a file list: a list would leave the next
  // .ts file unlinted.
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
    // ESLint's own baseline: no-undef, no-unused-vars, no-empty, no-dupe-keys and friends.
    // TS files only; it does not reach the JS blocks above.
    rules: { ...js.configs.recommended.rules },
  },
  // Never lint build output / deps.
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
]
