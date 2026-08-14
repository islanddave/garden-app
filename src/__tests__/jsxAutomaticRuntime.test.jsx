// OPS-JSXCLASSICFALLBACK-001 — the guard for vitest.config.ts's `esbuild: { jsx: 'automatic' }`.
//
// WHAT BREAKS WITHOUT IT. vitest 2.1.9 pins vite-node to its own nested vite@5.4.21; the top-level
// vite is 8.0.9 and @vitejs/plugin-react 5.2.0 targets 6/7/8, so the plugin's automatic-runtime
// configuration never reaches the pipeline that transforms modules for the unit run. esbuild then
// falls back to its default classic transform and emits bare `React.createElement`. Any .jsx that
// does not `import React` throws `ReferenceError: React is not defined` the instant a test renders
// it. Measured 2026-08-14: 10 source files under src/ are in that state, plus every test file that
// writes JSX without importing React — including this one, deliberately.
//
// THIS FILE MUST NOT `import React`. That absence is half the assertion: the inline `<Probe />`
// below is compiled by the same transform under test.
//
// NOT VACUOUS — verified by mutation. Removing the `esbuild` block from vitest.config.ts turns
// every test here RED with `ReferenceError: React is not defined`, and the anchor assertions below
// fail loudly rather than silently matching nothing if a page's copy changes.
import { render, screen } from '@testing-library/react'
import Home from '../pages/Home.jsx'
import Tasks from '../pages/Tasks.jsx'
import Footer from '../components/Footer.jsx'
import { ZoneProvider } from '../context/ZoneContext.jsx'

function Probe() {
  return <div data-testid="inline-probe">inline</div>
}

describe('JSX automatic runtime (vitest.config.ts esbuild block)', () => {
  it('compiles inline JSX in a test file that never imports React', () => {
    render(<Probe />)
    expect(screen.getByTestId('inline-probe').textContent).toBe('inline')
  })

  // The three src/ modules that render standalone with no provider or network scaffolding. The
  // other seven latent files (Achievements, AuthCallback, Inventory, Login, ZonePicker,
  // FavoritesContext, ProjectTypes) need Clerk/AuthContext/data mocks to reach their JSX at all,
  // so a render here would be testing the mocks, not the transform. They are covered by the same
  // one config switch — the transform is repo-wide, not per file.
  it('renders src/pages/Home.jsx — no React import in the file', () => {
    render(<Home />)
    expect(screen.getByText(/Garden at the Ridge/)).toBeTruthy()
  })

  it('renders src/pages/Tasks.jsx — no React import in the file', () => {
    render(<Tasks />)
    expect(screen.getByText(/Tasks/)).toBeTruthy()
  })

  it('renders src/components/Footer.jsx — no React import in the file', () => {
    const { container } = render(<Footer />)
    expect(container.textContent.length).toBeGreaterThan(0)
  })

  it('renders src/context/ZoneContext.jsx\'s provider — no React import in the file', () => {
    render(<ZoneProvider><span data-testid="zone-child">child</span></ZoneProvider>)
    expect(screen.getByTestId('zone-child').textContent).toBe('child')
  })
})
