// Unit tests for src/components/ErrorBoundary.jsx — catch, fallback, retry reset.

import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import ErrorBoundary from '../components/ErrorBoundary.jsx'

let shouldThrow = true

function Bomb() {
  if (shouldThrow) throw new Error('kaboom')
  return <div data-testid="bomb-ok">recovered</div>
}

let errSpy
beforeEach(() => {
  shouldThrow = true
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errSpy.mockRestore()
})

describe('ErrorBoundary', () => {
  it('renders children when no error', () => {
    shouldThrow = false
    render(
      <ErrorBoundary scope="test" fallback={<div>fb</div>}>
        <div data-testid="child">child ok</div>
      </ErrorBoundary>
    )
    expect(screen.getByTestId('child')).toBeTruthy()
  })

  it('renders fallback element on child throw', () => {
    render(
      <ErrorBoundary scope="test" fallback={<div data-testid="fb">fb here</div>}>
        <Bomb />
      </ErrorBoundary>
    )
    expect(screen.getByTestId('fb')).toBeTruthy()
  })

  it('renders fallback function on child throw with error + retry args', () => {
    render(
      <ErrorBoundary scope="test" fallback={(err, retry) => (
        <div>
          <div data-testid="msg">{err.message}</div>
          <button data-testid="retry-btn" onClick={retry}>retry</button>
        </div>
      )}>
        <Bomb />
      </ErrorBoundary>
    )
    expect(screen.getByTestId('msg').textContent).toBe('kaboom')
    expect(screen.getByTestId('retry-btn')).toBeTruthy()
  })

  it('logs to console.error with scope prefix on catch', () => {
    render(
      <ErrorBoundary scope="dashboard" fallback={<div>fb</div>}>
        <Bomb />
      </ErrorBoundary>
    )
    const calls = errSpy.mock.calls.map(c => c[0])
    expect(calls.some(c => typeof c === 'string' && c.includes('[ErrorBoundary scope=dashboard]'))).toBe(true)
  })

  it('retry resets state and re-renders children successfully', () => {
    render(
      <ErrorBoundary scope="test" fallback={(err, retry) => (
        <button data-testid="retry-btn" onClick={retry}>retry</button>
      )}>
        <Bomb />
      </ErrorBoundary>
    )
    expect(screen.getByTestId('retry-btn')).toBeTruthy()
    shouldThrow = false
    act(() => {
      fireEvent.click(screen.getByTestId('retry-btn'))
    })
    expect(screen.getByTestId('bomb-ok')).toBeTruthy()
  })

  it('renders null when no fallback provided', () => {
    const { container } = render(
      <ErrorBoundary scope="test">
        <Bomb />
      </ErrorBoundary>
    )
    expect(container.textContent).toBe('')
  })
})
