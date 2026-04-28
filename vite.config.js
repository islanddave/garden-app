import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Note: vite-plugin-pwa is removed — incompatible with Vite 8 / Rolldown bundler.
// The web app manifest is served as a static file from public/manifest.webmanifest.
// Service worker support can be re-added with a compatible plugin once one is available.

// Note: @clerk/react excluded from optimizeDeps — Rolldown incorrectly flags a
// re-export in @clerk/shared as missing. Excluding bypasses pre-bundling entirely.
// use-sync-external-store/shim aliased to React 18 native — avoids CJS/ESM interop
// failure when @clerk/* imports the shim under Vite 8.

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(process.env.VITE_APP_VERSION || pkg.version),
  },
  plugins: [
    react(),
  ],
  resolve: {
    dedupe: ['@clerk/shared'],
    alias: {
      'use-sync-external-store/shim/index.js': resolve(__dirname, 'src/shims/useSyncExternalStore.js'),
      'use-sync-external-store/shim': resolve(__dirname, 'src/shims/useSyncExternalStore.js'),
    },
  },
  optimizeDeps: {
    exclude: ['@clerk/react', '@clerk/shared', '@clerk/clerk-js'],
  },
})
