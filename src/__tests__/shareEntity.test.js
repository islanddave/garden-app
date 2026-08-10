import { describe, it, expect, vi, afterEach } from 'vitest'
import { shareEntity } from '../lib/shareEntity.js'
function setNav(props) { Object.defineProperty(globalThis, 'navigator', { value: props, configurable: true, writable: true }) }
afterEach(() => { setNav(window.navigator) })
describe('shareEntity (V4-FBSHARE-001)', () => {
  it('uses Web Share when available', async () => {
    const share = vi.fn().mockResolvedValue()
    setNav({ share })
    expect(await shareEntity({ title: 'T', url: 'https://x/1' })).toBe('shared')
    expect(share).toHaveBeenCalledWith({ title: 'T', url: 'https://x/1' })
  })
  it('returns noop and does NOT copy when the user cancels the share sheet', async () => {
    const writeText = vi.fn().mockResolvedValue()
    setNav({ share: vi.fn().mockRejectedValue(new Error('AbortError')), clipboard: { writeText } })
    expect(await shareEntity({ url: 'https://x/2' })).toBe('noop')
    expect(writeText).not.toHaveBeenCalled()
  })
  it('falls back to clipboard when Web Share is unsupported', async () => {
    const writeText = vi.fn().mockResolvedValue()
    setNav({ clipboard: { writeText } })
    expect(await shareEntity({ url: 'https://x/3' })).toBe('copied')
    expect(writeText).toHaveBeenCalledWith('https://x/3')
  })
  it('returns noop when neither share nor clipboard exist', async () => {
    setNav({})
    expect(await shareEntity({ url: 'https://x/4' })).toBe('noop')
  })
})

// V4-COMPOSEPOST-001 — text hand-off. On Chrome Android this is what drops a composed harvest post
// straight into the Facebook composer instead of copy -> app-switch -> long-press -> paste.
describe('shareEntity — text hand-off', () => {
  const POST = 'Tomatoes:\n  3 1884\n\n10 cucamelons'

  it('shares the body as text', async () => {
    const share = vi.fn().mockResolvedValue()
    setNav({ share })
    expect(await shareEntity({ text: POST })).toBe('shared')
    expect(share).toHaveBeenCalledWith({ text: POST })
  })

  it('does NOT append the Clerk-gated app URL to a text share', async () => {
    // A login wall in the middle of a public garden post is the failure this guards against.
    const share = vi.fn().mockResolvedValue()
    setNav({ share })
    await shareEntity({ text: POST })
    expect(share.mock.calls[0][0].url).toBeUndefined()
  })

  it('copies the body, not the page URL, when Web Share is unsupported', async () => {
    const writeText = vi.fn().mockResolvedValue()
    setNav({ clipboard: { writeText } })
    expect(await shareEntity({ text: POST })).toBe('copied')
    expect(writeText).toHaveBeenCalledWith(POST)
  })

  it('is a no-op on whitespace-only text rather than falling back to sharing the current page', async () => {
    const share = vi.fn().mockResolvedValue()
    setNav({ share })
    expect(await shareEntity({ text: '   \n ' })).toBe('noop')
    expect(share).not.toHaveBeenCalled()
  })

  it('still carries a url when a caller explicitly passes both', async () => {
    const share = vi.fn().mockResolvedValue()
    setNav({ share })
    await shareEntity({ text: POST, url: 'https://x/9', title: 'T' })
    expect(share).toHaveBeenCalledWith({ title: 'T', text: POST, url: 'https://x/9' })
  })
})
