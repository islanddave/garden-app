// V4-COLLECTIONSPLIT-001 + V4-CIGUARD-002 — RUNTIME chunk-reached guard for the /collection split.
//
// WHY THIS EXISTS. scripts/verify-window-chunk.sh proves a lazy chunk is ISOLATED in the build
// artifact, but nothing in this repo asserted that a split chunk is actually REACHED when the route
// renders. Both halves of that pair have to hold, and each one fails a way the other cannot see:
//
//   • re-bundled  — someone "simplifies" App.jsx's `React.lazy(() => import('./pages/Collection.jsx'))`
//                   back to a static `import Collection from './pages/Collection.jsx'`. The feature
//                   still works, every existing test stays green, and ~40KB gzip silently returns to
//                   the Android boot path. Nothing red. This is the inert-regression class.
//   • inert       — the boundary survives but the loader never resolves (bad path, dropped export),
//                   so the route sits on the fallback forever. A source-text grep for `lazy(` passes.
//
// A grep-the-source guard catches neither cleanly, so this file asserts BEHAVIOUR at both ends:
//   (a) importing App.jsx must NOT evaluate the Collection page module — that is what "split" means
//       at runtime, and a static import fails it immediately;
//   (b) rendering /collection must show the Suspense fallback FIRST (it suspends — a static import
//       renders synchronously and never does), and then must actually reach the module and render
//       what it exports.
//
// The page module is MOCKED on purpose. What is under test is App.jsx's import boundary, not
// Collection's internals — mocking keeps this file from going red every time Collection grows a new
// provider-dependent child (the L-160 / App.routes.test.jsx lesson about a guard that breaks for
// reasons unrelated to what it guards).
//
// MUTATION-PROVEN 2026-08-18, both failure modes, independently:
//   • re-bundled — App.jsx reverted to `import Collection from './pages/Collection.jsx'`:
//     all 3 tests RED.
//   • inert      — loader swapped to `() => Promise.resolve({ default: () => null })`, so the
//     boundary and lazy() both survive: the two shape assertions PASS and only
//     'rendering /collection suspends first, then reaches the chunk' goes RED (1 failed | 2 passed).
//     That is the assertion V4-CIGUARD-002 asked for, and this is the proof it is not vacuous.
// Re-verify the same way if you touch this file.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes } from 'react-router-dom'

// vi.hoisted: the vi.mock call below is hoisted above these imports, so the counter it mutates has
// to be hoisted with it. The FACTORY still runs lazily — on first import of the mocked module — and
// that laziness is precisely the signal this file reads.
const probe = vi.hoisted(() => ({ evals: 0 }))

vi.mock('../pages/Collection.jsx', () => {
  probe.evals += 1
  return { default: () => <div data-testid="collection-chunk-reached">critters</div> }
})

// Provider-free: Protected only needs useAuth, and pulling in the real AuthProvider would drag
// Clerk into a test about module graphs.
vi.mock('../context/AuthContext.jsx', () => ({
  AuthProvider: ({ children }) => children,
  useAuth: () => ({ user: { id: 'u1' }, loading: false }),
  useAuthOptional: () => ({ user: { id: 'u1' }, loading: false }),
}))

import { renderRoutes } from '../App.jsx'

const collectionRoute = () =>
  renderRoutes({ overlay: false, user: true }).find((r) => r.props.path === '/collection')

describe('V4-COLLECTIONSPLIT-001 — /collection is a real code-split route', () => {
  it('the Collection page module is NOT evaluated when App.jsx is imported', () => {
    // The static-import detector. App.jsx is imported at the top of this file; if its Collection
    // import were static, the mock factory would already have run by now.
    expect(probe.evals).toBe(0)
  })

  it('the route element is a React.lazy component, not a plain page component', () => {
    // Structural, not source-text: lazy() returns an exotic object tagged react.lazy. Checked
    // through the route table so a boundary that never made it onto the route cannot pass.
    const suspense = collectionRoute().props.element.props.children
    expect(suspense.type).toBe(React.Suspense)
    expect(suspense.props.children.type.$$typeof).toBe(Symbol.for('react.lazy'))
  })

  it('rendering /collection suspends first, then reaches the chunk', async () => {
    render(
      <MemoryRouter initialEntries={['/collection']}>
        <Routes>{collectionRoute()}</Routes>
      </MemoryRouter>,
    )

    // Suspended: the boundary is showing its fallback and the page is NOT in the tree yet. A static
    // import renders synchronously, so this pair is what makes the guard non-vacuous.
    expect(screen.getByTestId('route-chunk-fallback')).toBeDefined()
    expect(screen.queryByTestId('collection-chunk-reached')).toBeNull()

    // REACHED: the loader resolved, the module evaluated, and React rendered its default export.
    expect(await screen.findByTestId('collection-chunk-reached')).toBeDefined()
    expect(probe.evals).toBe(1)
    expect(screen.queryByTestId('route-chunk-fallback')).toBeNull()
  })
})
