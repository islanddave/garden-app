// DESIGNSYS Pass A — frozen-primitives lint guard (V4-DESIGNSYS-001).
// Flat config. A local custom rule (no-raw-design-tokens) is applied to a SCOPED set
// of files only — the token-promoted primitives. It bans (a) raw hex color string
// literals and (b) raw emoji in JSX text / JSX attribute string values, so these files
// can only ever reference design values through the token (P/T) + iconRegistry surfaces.
//
// Out of scope for Pass A: the rest of the app (hundreds of pre-existing literals).
// Token/icon HOMES (tokens.js, constants.js, iconRegistry.js) are intentionally NOT
// scoped — they are allowed to hold the literal values.
import js from '@eslint/js'
import tsParser from '@typescript-eslint/parser'
import globals from 'globals'

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/
// Emoji ranges: pictographs, symbols, dingbats, arrows, misc-technical, variation
// selectors. Matches a glyph appearing literally in JSX text or a JSX string attribute.
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{FE0F}]/u

const noRawDesignTokens = {
  meta: {
    type: 'problem',
    docs: { description: 'Ban raw hex colors and raw emoji in frozen design primitives; use tokens.js / iconRegistry.js.' },
    schema: [],
    messages: {
      rawHex: "Raw hex color '{{value}}' — import a token from lib/constants.js (P) or lib/tokens.js instead.",
      rawEmoji: "Raw emoji in JSX — source glyphs from lib/iconRegistry.js instead.",
    },
  },
  create(context) {
    return {
      // (a) raw hex in any string literal
      Literal(node) {
        if (typeof node.value === 'string' && HEX_RE.test(node.value)) {
          context.report({ node, messageId: 'rawHex', data: { value: node.value.match(HEX_RE)[0] } })
        }
      },
      // (b) raw emoji in JSX text
      JSXText(node) {
        if (EMOJI_RE.test(node.value)) {
          context.report({ node, messageId: 'rawEmoji' })
        }
      },
      // (b) raw emoji in a JSX attribute whose value is a string literal (e.g. title="🌱")
      JSXAttribute(node) {
        const v = node.value
        if (v && v.type === 'Literal' && typeof v.value === 'string' && EMOJI_RE.test(v.value)) {
          context.report({ node: v, messageId: 'rawEmoji' })
        }
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
  // Scoped guard: ONLY the frozen primitives. Token/icon homes are exempt (not listed).
  {
    files: [
      'src/components/PlantStatusBadge.jsx',
      'src/components/SeverityBadge.jsx',
      'src/components/forms/Badge.jsx',
      'src/components/forms/SelectChip.jsx',
      'src/components/forms/SegmentedControl.jsx',
      'src/components/forms/Sheet.jsx',
      'src/components/forms/TileGrid.jsx',
      'src/components/forms/formStyles.js',
      'src/lib/status.js',
    ],
    plugins: { designsys: designsysPlugin },
    rules: { 'designsys/no-raw-design-tokens': 'error' },
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
