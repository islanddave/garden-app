// V4-STORAGEPERSIST-001 — persistent storage must be requested at BOOT, not from /field.
// Before this, requestPersistence() had exactly one call site (FieldCapture, reachable only via the
// field-mode mic button), so an origin whose owner never opened that route stayed BEST-EFFORT and
// Chrome Android could evict it wholesale. App.jsx is stubbed here, so nothing routes and
// FieldCapture is never even imported — the request has to come from main.jsx's own boot path or
// this file goes red.
import { describe, it, expect, vi } from 'vitest'

const boot = vi.hoisted(() => ({
  render: vi.fn(),
  requestPersistence: vi.fn().mockResolvedValue({ supported: true, granted: true }),
}))

vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: boot.render }) }))
vi.mock('@clerk/react', () => ({ ClerkProvider: ({ children }) => children }))
vi.mock('../App.jsx', () => ({ default: () => null }))
vi.mock('../lib/durableStorage.js', () => ({ requestPersistence: boot.requestPersistence }))

describe('app boot (src/main.jsx)', () => {
  it('requests persistent storage without visiting /field', async () => {
    document.body.innerHTML = '<div id="root"></div>'
    await import('../main.jsx')
    expect(boot.requestPersistence).toHaveBeenCalledTimes(1)
    expect(boot.render).toHaveBeenCalledTimes(1)
  })

  it('a rejecting requestPersistence cannot break boot', async () => {
    // Not reachable today (durableStorage catches internally), but boot must never depend on that.
    boot.requestPersistence.mockRejectedValueOnce(new Error('quota'))
    document.body.innerHTML = '<div id="root"></div>'
    vi.resetModules()
    await expect(import('../main.jsx')).resolves.toBeDefined()
  })
})
