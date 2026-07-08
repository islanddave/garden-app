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
