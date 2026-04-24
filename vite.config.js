import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'

// Note: vite-plugin-pwa is removed â incompatible with Vite 8 / Rolldown bundler.
// The web app manifest is served as a static file from public/manifest.webmanifest.
// Service worker support can be re-added with a compatible plugin once one is available.

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))

export default defineConfig({
  // Inject app version from package.json â available as __APP_VERSION__ in source
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(process.env.VITE_APP_VERSION || pkg.version),
  },
  plugins: [
    react(),
  ],
})
