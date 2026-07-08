// V4-PHOTOSAVE-001 — save an in-app captured photo to the device. iOS Safari / standalone PWA
// IGNORES the <a download> attribute, so navigator.share({ files }) (guarded by canShare) is the
// only path to "Save Image" / "Save to Files" there; desktop + Android fall back to a download
// link. Must be called from a user gesture (a button tap). Returns 'shared' | 'downloaded' | 'noop'.
export async function saveFileToDevice(file, filename) {
  if (!file) return 'noop'
  const name = filename || file.name || 'garden-photo.jpg'
  const canShareFiles = typeof navigator !== 'undefined'
    && typeof navigator.share === 'function'
    && typeof navigator.canShare === 'function'
    && navigator.canShare({ files: [file] })
  if (canShareFiles) {
    try {
      await navigator.share({ files: [file] })
      return 'shared'
    } catch {
      // user cancelled the share sheet — do NOT also trigger a download
      return 'noop'
    }
  }
  try {
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return 'downloaded'
  } catch {
    return 'noop'
  }
}
