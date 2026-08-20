import { describe, it, expect, vi, afterEach } from 'vitest'
import { shareEntity, canShareFiles } from '../lib/shareEntity.js'
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

// V4-HARVPOSTPHOTOS-001 — files ride WITH the words. Chrome Android (Dave's only browser) is the
// target: navigator.canShare({ files }) is the capability probe, and a browser that says no must still
// get the caption. Both are stubbed here; neither exists in jsdom.
describe('shareEntity — photo hand-off', () => {
  const POST = '3 San Marzano\n1 Cubanelle pepper'
  const file = (name = 'harvest-photo-1.jpg') =>
    new File([new Uint8Array(16)], name, { type: 'image/jpeg' })

  it('attaches the files alongside the text when canShare approves', async () => {
    const share = vi.fn().mockResolvedValue()
    const canShare = vi.fn().mockReturnValue(true)
    setNav({ share, canShare })
    const files = [file(), file('harvest-photo-2.jpg')]
    expect(await shareEntity({ text: POST, files })).toBe('shared')
    expect(canShare).toHaveBeenCalledWith({ files })
    expect(share).toHaveBeenCalledWith({ text: POST, files })
  })

  it('KEEPS THE CAPTION when canShare rejects the files', async () => {
    const share = vi.fn().mockResolvedValue()
    setNav({ share, canShare: vi.fn().mockReturnValue(false) })
    expect(await shareEntity({ text: POST, files: [file()] })).toBe('shared')
    expect(share).toHaveBeenCalledWith({ text: POST })
  })

  it('KEEPS THE CAPTION when the browser has navigator.share but no canShare at all', async () => {
    const share = vi.fn().mockResolvedValue()
    setNav({ share })
    expect(await shareEntity({ text: POST, files: [file()] })).toBe('shared')
    expect(share).toHaveBeenCalledWith({ text: POST })
  })

  it('KEEPS THE CAPTION on a desktop with no Web Share — copies the words, drops the files', async () => {
    const writeText = vi.fn().mockResolvedValue()
    setNav({ clipboard: { writeText } })
    expect(await shareEntity({ text: POST, files: [file()] })).toBe('copied')
    expect(writeText).toHaveBeenCalledWith(POST)
  })

  it('sends the byte-identical payload it always sent when no files are passed', async () => {
    const share = vi.fn().mockResolvedValue()
    setNav({ share, canShare: vi.fn().mockReturnValue(true) })
    await shareEntity({ text: POST })
    expect(share).toHaveBeenCalledWith({ text: POST })
    expect('files' in share.mock.calls[0][0]).toBe(false)
  })

  // A caller that passes NO `text` is doing an entity share, and the pre-existing contract is that it
  // gets the current page URL. Files ride along with it; they do not replace it.
  it('adds files to an entity URL share without disturbing the url', async () => {
    const share = vi.fn().mockResolvedValue()
    setNav({ share, canShare: vi.fn().mockReturnValue(true) })
    const files = [file()]
    expect(await shareEntity({ url: 'https://x/1', title: 'T', files })).toBe('shared')
    expect(share).toHaveBeenCalledWith({ title: 'T', url: 'https://x/1', files })
  })
})

describe('canShareFiles', () => {
  const f = new File([new Uint8Array(8)], 'a.jpg', { type: 'image/jpeg' })

  it('is true only when share AND canShare exist and canShare approves', () => {
    setNav({ share: vi.fn(), canShare: vi.fn().mockReturnValue(true) })
    expect(canShareFiles([f])).toBe(true)
  })

  it('is false when canShare declines', () => {
    setNav({ share: vi.fn(), canShare: vi.fn().mockReturnValue(false) })
    expect(canShareFiles([f])).toBe(false)
  })

  it('is false when canShare is absent, even though share exists', () => {
    setNav({ share: vi.fn() })
    expect(canShareFiles([f])).toBe(false)
  })

  it('is false when canShare is present but share is not', () => {
    setNav({ canShare: vi.fn().mockReturnValue(true) })
    expect(canShareFiles([f])).toBe(false)
  })

  it('is false for an empty or absent list, so an empty share is never offered', () => {
    setNav({ share: vi.fn(), canShare: vi.fn().mockReturnValue(true) })
    expect(canShareFiles([])).toBe(false)
    expect(canShareFiles(undefined)).toBe(false)
    expect(canShareFiles([null, undefined])).toBe(false)
  })

  it('treats a canShare that THROWS as a no rather than propagating', () => {
    setNav({ share: vi.fn(), canShare: vi.fn(() => { throw new TypeError('bad payload') }) })
    expect(canShareFiles([f])).toBe(false)
  })

  it('is false when canShare returns a truthy non-true value', () => {
    setNav({ share: vi.fn(), canShare: vi.fn().mockReturnValue('yes') })
    expect(canShareFiles([f])).toBe(false)
  })
})
