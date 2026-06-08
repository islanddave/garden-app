// V3-IMGTAP-001 — ZoomableImage / Lightbox contract tests.
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ZoomableImage from '../components/ZoomableImage.jsx'

const SRC = 'https://example.test/photo.jpg'

describe('ZoomableImage', () => {
  it('renders nothing when src is absent', () => {
    const { container } = render(<ZoomableImage src={null} alt="x" />)
    expect(container.querySelector('img')).toBeNull()
  })

  it('renders the inline trigger image with a zoom-in cursor', () => {
    render(<ZoomableImage src={SRC} alt="Tomato photo" />)
    const img = screen.getByAltText('Tomato photo')
    expect(img.getAttribute('src')).toBe(SRC)
    expect(img.style.cursor).toBe('zoom-in')
  })

  it('opens the lightbox dialog on tap and closes on Escape', () => {
    render(<ZoomableImage src={SRC} alt="Tomato photo" />)
    expect(screen.queryByTestId('lightbox')).toBeNull()
    fireEvent.click(screen.getByAltText('Tomato photo'))
    const dialog = screen.getByTestId('lightbox')
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('Tomato photo')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('lightbox')).toBeNull()
  })

  it('closes when the backdrop (but not the image) is clicked', () => {
    render(<ZoomableImage src={SRC} alt="Tomato photo" />)
    fireEvent.click(screen.getByAltText('Tomato photo'))
    const dialog = screen.getByTestId('lightbox')
    // Clicking the enlarged image must NOT close (stopPropagation + zoom toggle).
    const enlarged = dialog.querySelector('img')
    fireEvent.click(enlarged)
    expect(screen.getByTestId('lightbox')).toBeTruthy()
    // Clicking the backdrop itself closes.
    fireEvent.click(dialog)
    expect(screen.queryByTestId('lightbox')).toBeNull()
  })

  it('closes via the × close button', () => {
    render(<ZoomableImage src={SRC} alt="Tomato photo" />)
    fireEvent.click(screen.getByAltText('Tomato photo'))
    fireEvent.click(screen.getByLabelText('Close enlarged image'))
    expect(screen.queryByTestId('lightbox')).toBeNull()
  })

  it('tapping the enlarged image toggles the zoom cursor', () => {
    render(<ZoomableImage src={SRC} alt="Tomato photo" />)
    fireEvent.click(screen.getByAltText('Tomato photo'))
    const enlarged = screen.getByTestId('lightbox').querySelector('img')
    expect(enlarged.style.cursor).toBe('zoom-in')
    fireEvent.click(enlarged)
    expect(enlarged.style.cursor).toBe('zoom-out')
  })
})
