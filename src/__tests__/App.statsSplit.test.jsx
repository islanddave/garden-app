// V5-SEASONSTATS-001 — /season-stats and /sources/:id are real code-split routes (same guard shape as
// App.collectionSplit.test.jsx): (a) importing App.jsx does NOT evaluate either page module, (b) each
// route element is ErrorBoundary > PageChunkRoute, (c) rendering the route shows the loading state
// first and then reaches the page, and (d) a failed load is retried by "Try again" with a NEW load —
// the case React.lazy cannot reach, which is why it is not used (V4-LAZYRETRY-001).
//
// Negative control: with `import SeasonStats from './pages/SeasonStats.jsx'` restored in App.jsx,
// (a) goes red because the mock factory has already run.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes } from 'react-router-dom'

const probe = vi.hoisted(() => ({ stats: 0, edit: 0 }))

vi.mock('../pages/SeasonStats.jsx', () => {
  probe.stats += 1
  return { default: () => <div data-testid="season-stats-chunk-reached">stats</div> }
})
vi.mock('../pages/SourceEdit.jsx', () => {
  probe.edit += 1
  return { default: () => <div data-testid="source-edit-chunk-reached">edit</div> }
})
vi.mock('../context/AuthContext.jsx', () => ({
  AuthProvider: ({ children }) => children,
  useAuth: () => ({ user: { id: 'u1' }, loading: false }),
  useAuthOptional: () => ({ user: { id: 'u1' }, loading: false }),
}))

import { renderRoutes, PageChunkRoute } from '../App.jsx'
import ErrorBoundary from '../components/ErrorBoundary.jsx'

const route = (path) => renderRoutes({ overlay: false, user: true }).find((r) => r.props.path === path)

describe('V5-SEASONSTATS-001 — /season-stats and /sources/:id are split routes', () => {
  it('neither page module is evaluated when App.jsx is imported', () => {
    expect(probe.stats).toBe(0)
    expect(probe.edit).toBe(0)
  })

  it.each(['/season-stats', '/sources/:id'])('%s: Protected > ErrorBoundary(route) > PageChunkRoute', (path) => {
    const boundary = route(path).props.element.props.children
    expect(boundary.type).toBe(ErrorBoundary)
    expect(boundary.props.scope).toBe('route')
    expect(boundary.props.children.type).toBe(PageChunkRoute)
  })

  it.each([
    ['/season-stats', '/season-stats', 'season-stats-chunk-reached', 'stats'],
    ['/sources/:id', '/sources/b1f3c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d', 'source-edit-chunk-reached', 'edit'],
  ])('%s shows the loading state first, then reaches the page', async (path, url, testId, key) => {
    render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>{route(path)}</Routes>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('route-chunk-fallback')).toBeDefined()
    expect(screen.queryByTestId(testId)).toBeNull()
    expect(await screen.findByTestId(testId)).toBeDefined()
    expect(probe[key]).toBe(1)
  })

  it('a failed load shows "Try again", which starts a NEW load that can succeed', async () => {
    const Page = () => <div data-testid="retried-page" />
    const chunk = { peek: () => null, load: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(Page) }
    render(<PageChunkRoute chunk={chunk} />)
    const retry = await screen.findByRole('button', { name: 'Try again' })
    expect(screen.getByRole('alert').textContent).toContain('This page failed to load.')
    fireEvent.click(retry)
    expect(await screen.findByTestId('retried-page')).toBeDefined()
    expect(chunk.load).toHaveBeenCalledTimes(2)
  })
})
