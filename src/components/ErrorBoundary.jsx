import React from 'react'

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
    this.retry = this.retry.bind(this)
  }
  static getDerivedStateFromError(error) { return { hasError: true, error } }
  componentDidCatch(error, info) {
    const scope = this.props.scope ?? 'unknown'
    console.error(`[ErrorBoundary scope=${scope}]`, error, info)
  }
  retry() { this.setState({ hasError: false, error: null }) }
  render() {
    if (!this.state.hasError) return this.props.children
    const fb = this.props.fallback
    if (typeof fb === 'function') return fb(this.state.error, this.retry)
    if (React.isValidElement(fb)) return React.cloneElement(fb, { error: this.state.error, retry: this.retry })
    return fb ?? null
  }
}
