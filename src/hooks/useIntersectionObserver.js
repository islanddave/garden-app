// useIntersectionObserver — scaffolding hook for Session 3 Stage 2 viewport gate.
// Spec: revision §3.26 (Stage 2 reveal must defer when tile is out-of-viewport).
//
// Generic + reusable. Returns { isIntersecting, ref } where ref is attached to
// the target element. Callback fires on every intersection state change.
//
// Session 2 scope: hook + tests only. Wiring into CritterSprite is Session 3.

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
