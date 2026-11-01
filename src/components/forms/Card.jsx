// White bordered container. `title` renders an optional uppercase group label.
import React from 'react'
import { P } from '../../lib/constants.js'
import { cardChrome } from './formStyles.js'

const groupLabelChrome = {
  fontSize: '0.7rem', fontWeight: 700, color: P.greenLight,
  letterSpacing: '0.8px', textTransform: 'uppercase', marginBottom: 4,
}

export default function Card({ title, children, style, ...rest }) {
  return (
    <div style={{ ...cardChrome, ...style }} {...rest}>
      {title && <div style={groupLabelChrome}>{title}</div>}
      {children}
    </div>
  )
}
