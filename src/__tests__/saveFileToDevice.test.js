import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { saveFileToDevice } from '../lib/saveFileToDevice.js'
function setNav(props) { Object.defineProperty(globalThis, 'navigator', { value: props, configurable: true, writable: true }) }
const origNav = window.navigator
afterEach(() => { setNav(origNav); vi.restoreAllMocks() })
beforeEach(() => {
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:x')
  globalThis.URL.revokeObjectURL = vi.fn()
})
describe('saveFileToDevice (V4-PHOTOSAVE-001)', () => {
  const file = new File(['x'], 'photo.jpg', { type: 'image/jpeg' })
  it('returns noop for a missing file', async () => {
    expect(await saveFileToDevice(null)).toBe('noop')
  })
  it('uses navigator.share({files}) when canShare(files) is true', async () => {
    const share = vi.fn().mockResolvedValue()
    setNav({ share, canShare: () => true })
    expect(await saveFileToDevice(file)).toBe('shared')
    expect(share).toHaveBeenCalledWith({ files: [file] })
  })
  it('falls back to a download link when file-share is unsupported', async () => {
    setNav({})
    const click = vi.fn()
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = { tag, click, remove: vi.fn(), setAttribute(){}, style:{} }
      return el
    })
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => {})
    expect(await saveFileToDevice(file)).toBe('downloaded')
    expect(click).toHaveBeenCalled()
  })
})
