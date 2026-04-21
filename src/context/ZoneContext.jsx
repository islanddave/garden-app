import { createContext, useContext, useState } from 'react'

// ZoneContext — tracks the user's currently selected zone for the session.
// null = "Everywhere" (no zone selected — show everything).
// Populated with a location row object when the user picks a zone.
// Intentionally NOT persisted to localStorage — pick fresh each session.

const ZoneContext = createContext(null)

export function ZoneProvider({ children }) {
  const [activeZone, setActiveZone] = useState(null)

  function clearZone() {
    setActiveZone(null)
  }

  return (
    <ZoneContext.Provider value={{ activeZone, setActiveZone, clearZone }}>
      {children}
    </ZoneContext.Provider>
  )
}

export function useZone() {
  const ctx = useContext(ZoneContext)
  if (!ctx) throw new Error('useZone must be called inside ZoneProvider')
  return ctx
}
