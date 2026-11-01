// useIntersectionObserver — viewport gate (a reveal must defer while its tile is out of the viewport).
//
// Generic + reusable. Returns { isIntersecting, ref } where ref is attached to
// the target element. Callback fires on every intersection state change.

import { useEffect, useRef, useState } from 'react'

export function useIntersectionObserver({
  threshold = 0,
  rootMargin = '0px',
  onChange = null,
} = {}) {
  const ref = useRef(null)
  const [isIntersecting, setIsIntersecting] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return undefined
    // Bail on environments without IntersectionObserver (legacy + some tests).
    if (typeof IntersectionObserver === 'undefined') return undefined
    const obs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        setIsIntersecting(entry.isIntersecting)
        if (typeof onChange === 'function') onChange(entry)
      }
    }, { threshold, rootMargin })
    obs.observe(node)
    return () => { obs.disconnect() }
  }, [threshold, rootMargin, onChange])

  return { ref, isIntersecting }
}

// Singleton-detection helper for environments where IO is not available.
// Useful for tests + degraded-browser code paths.
export function intersectionObserverAvailable() {
  return typeof IntersectionObserver !== 'undefined'
}
