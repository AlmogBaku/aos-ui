"use client"

import { Component, type ReactNode } from "react"

type LazyBoundaryProps = {
  children: ReactNode
  fallbackLabel: string
  fallback?: ReactNode
}

type LazyBoundaryState = { failed: boolean }

export class LazyVisualBoundary extends Component<
  LazyBoundaryProps,
  LazyBoundaryState
> {
  state: LazyBoundaryState = { failed: false }

  static getDerivedStateFromError(): LazyBoundaryState {
    return { failed: true }
  }

  componentDidCatch() {
    // The textual representation below remains authoritative and available.
  }

  render() {
    if (this.state.failed) {
      if (this.props.fallback) return this.props.fallback
      return (
        <p className="text-sm text-muted-foreground" role="alert">
          {this.props.fallbackLabel}
        </p>
      )
    }
    return this.props.children
  }
}
