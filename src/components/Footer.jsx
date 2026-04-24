import { P } from '../lib/constants.js'

// ── App version injected by vite.config.js at build time ──
// Falls back to '0.1.0' in dev if define hasn't been configured yet.
const APP_VERSION = import.meta.env.VITE_APP_VERSION || '0.0.0'

// Page load time — captured once when the module is first imported.
// This is a module-level constant so it doesn't re-render on every route change.
const PAGE_LOADED_AT = new Date()

function fmtTime(date) {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

// ── Global footer ────────────────────────────────────────────
export default function Footer() {
  return (
    <footer style={{
      borderTop: `1px solid ${P.border}`,
      backgroundColor: P.white,
      padding: '10px 20px',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      gap: 12,
      fontSize: '0.72rem',
      color: P.light,
      flexWrap: 'wrap',
    }}>
      <span>© {new Date().getFullYear()} FutureisHere.NET</span>
      <Dot />
      <span>v{APP_VERSION}</span>
      <Dot />
      <span>Loaded {fmtTime(PAGE_LOADED_AT)}</span>
    </footer>
  )
}

// ── Per-page data-freshness indicator ────────────────────────
// Usage in any page that fetches data:
//
//   const [fetchedAt, setFetchedAt] = useState(null)
//   // after data loads: setFetchedAt(new Date())
//   // at bottom of page content: <FetchedAt time={fetchedAt} />
//
export function FetchedAt({ time }) {
  if (!time) return null
  return (
    <div style={{
      textAlign: 'right',
      fontSize: '0.72rem',
      color: P.light,
      padding: '8px 0 0',
      opacity: 0.8,
    }}>
      Data fetched {fmtTime(time instanceof Date ? time : new Date(time))}
    </div>
  )
}

function Dot() {
  return <span style={{ opacity: 0.4 }}>·</span>
}
