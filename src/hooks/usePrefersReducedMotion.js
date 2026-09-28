// usePrefersReducedMotion — the OS "reduce motion" setting, live (plan-v2 §5.11). Until now the app had only
// a one-shot read (critterArt.js prefersReducedMotion); the redesigned Today scrolls on a chip tap and must
// switch smooth → instant the moment the setting changes, not at the next mount. No matchMedia (jsdom, an
// old WebView) reads as "no preference", the same default as the one-shot read.
import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

function mediaQuery() {
  try { return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null } catch { return null }
}

export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => !!mediaQuery()?.matches)
  useEffect(() => {
    const mq = mediaQuery()
    if (!mq) return undefined
    const on = () => setReduced(!!mq.matches)
    on()
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', on)
      return () => mq.removeEventListener('change', on)
    }
    if (typeof mq.addListener === 'function') {
      mq.addListener(on)
      return () => mq.removeListener(on)
    }
    return undefined
  }, [])
  return reduced
}
