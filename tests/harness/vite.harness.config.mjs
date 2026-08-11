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

export default defineConfig({
  root: repoRoot,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  // HARNESS_BASELINE_SHA pins src/** to a git object so a shared checkout with another session's
  // in-flight edits cannot contaminate a baseline run. Unset → the working tree, as normal.
  plugins: [baselineFromGit({ sha: process.env.HARNESS_BASELINE_SHA, repoRoot }), react()],
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
