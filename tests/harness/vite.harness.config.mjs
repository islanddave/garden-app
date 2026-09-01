// Mobile layout-measurement harness — dev server config.
//
// SEPARATE from the app's vite.config.js on purpose: the harness needs a Clerk alias that must
// NEVER reach a production build. Nothing under src/ or lambda/ is modified by running this.
//
//   npx vite --config tests/harness/vite.harness.config.mjs
//   → http://localhost:5199/tests/harness/
//
// root stays the repo root so /public assets, /src imports and relative paths resolve exactly as
// they do in `npm run dev`. Only the entry HTML differs.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import baselineFromGit from './baselinePlugin.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))

// BUG-HARNESSGLOBALCSS-001 — give EVERY harness entry the app's runtime global stylesheet.
//
// The app builds that stylesheet in JS (src/main.jsx:10-24) instead of shipping a .css file, so
// mounting a component in isolation gets the UA defaults: `content-box` instead of `border-box`, and
// the UA serif instead of the app's system stack. Both silently change layout, which is the one
// thing this harness exists to measure.
//
// Done here, at the config, because harness entries do not share a root module — each .html loads
// its own .jsx. A fix in harness/main.jsx would have covered index.html and left every other entry
// wrong, and a per-entry import would be twenty edits that the twenty-first entry forgets. This hook
// covers every entry that exists and every entry anyone adds later, which is the property that
// matters: the bug was never that the style was wrong, it was that nobody knew to ask for it.
const appGlobalStyle = () => ({
  name: 'harness-app-global-style',
  transformIndexHtml: {
    order: 'pre',
    handler: (html, ctx) => (
      ctx.path.includes('/tests/harness/')
        // In <head>, so the module executes before the entry's own body script and the style is in
        // the cascade before React's first paint — no measurable flash of unstyled layout.
        ? { html, tags: [{ tag: 'script', attrs: { type: 'module', src: '/tests/harness/appGlobalStyle.js' }, injectTo: 'head' }] }
        : html
    ),
  },
})

export default defineConfig({
  root: repoRoot,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  // HARNESS_BASELINE_SHA pins src/** to a git object so a shared checkout with another session's
  // in-flight edits cannot contaminate a baseline run. Unset → the working tree, as normal.
  plugins: [baselineFromGit({ sha: process.env.HARNESS_BASELINE_SHA, repoRoot }), react(), appGlobalStyle()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      // The whole reason the harness exists: no Clerk session is available in the Browser pane.
      '@clerk/react': resolve(here, 'stubs/clerk.jsx'),
      'use-sync-external-store/shim/index.js': resolve(repoRoot, 'src/shims/useSyncExternalStore.js'),
      'use-sync-external-store/shim': resolve(repoRoot, 'src/shims/useSyncExternalStore.js'),
    },
  },
  optimizeDeps: { exclude: ['@clerk/react', '@clerk/shared', '@clerk/clerk-js'] },
  // 5311, not 5173/5199: concurrent Claude sessions in this checkout already hold both, and a
  // harness that silently attaches to somebody else's server measures somebody else's code.
  server: { port: 5311, strictPort: true, open: false },
})
