import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'

// Note: vite-plugin-pwa is removed — incompatible with Vite 8 / Rolldown bundler.
// The web app manifest is served as a static file from public/manifest.webmanifest.
// Service worker support can be re-added with a compatible plugin once one is available.

// Note: @clerk/react excluded from optimizeDeps — Rolldown incorrectly flags a
// re-export in @clerk/shared as missing. Excluding bypasses pre-bundling entirely.

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(process.env.VITE_APP_VERSION || pkg.version),
  },
  plugins: [
    react(),
  ],
  optimizeDeps: {
    exclude: ['@clerk/react', '@clerk/shared', '@clerk/clerk-js'],
  },
})
