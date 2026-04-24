// src/components/Breadcrumb.jsx
// Reusable breadcrumb nav component.
// Props:
//   path: { label: string, href: string|null }[]
//   Items with href render as links; last item (current page) has href: null — plain text.
//
// Accepts an arbitrary-depth path array from the start.
// V2 will extend to full Space → Zone → Area → ... hierarchy without changes
// to this component — just pass a longer path array.
//
// DEFERRED:
//   - Plant detail breadcrumbs → V2
//   - Full location hierarchy (Space → Zone → Area → ...) → V2
//     (component already supports arbitrary depth via the path array)
import { Link } from 'react-router-dom'
import { P } from '../lib/constants.js'

export default function Breadcrumb({ path = [] }) {
  if (!path.length) return null
  return (
    <nav
      aria-label="breadcrumb"
      style={{
        fontSize: '0.82rem',
        color: P.light,
        marginBottom: 20,
        display: 'flex',
        flexWrap: 'nowrap',
        alignItems: 'center',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
    >
      {path.map((item, i) => {
        const isLast = i === path.length - 1
        return (
          <span key={i} style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
            {i > 0 && (
              <span style={{ margin: '0 6px', flexShrink: 0 }}>›</span>
            )}
            {isLast || !item.href ? (
              <span
                style={{
                  color: isLast ? P.dark : P.light,
                  fontWeight: isLast ? 600 : 400,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: '40vw',
                  display: 'inline-block',
                }}
              >
                {item.label}
              </span>
            ) : (
              <Link
                to={item.href}
                style={{
                  color: P.green,
                  textDecoration: 'none',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: '40vw',
                  display: 'inline-block',
                }}
              >
                {item.label}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}
