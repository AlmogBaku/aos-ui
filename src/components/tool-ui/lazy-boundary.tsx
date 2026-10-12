"use client"

import { Component, type ReactNode } from "react"

type LazyBoundaryProps = {
  children: ReactNode
  fallbackLabel: string
  fallback?: ReactNode
  /** A failed boundary renders its children again once this changes. */
  resetKey?: string | undefined
}

type LazyBoundaryState = { failed: boolean; resetKey?: string | undefined }

export class LazyVisualBoundary extends Component<
  LazyBoundaryProps,
  LazyBoundaryState
> {
  state: LazyBoundaryState = { failed: false }

  static getDerivedStateFromProps(
    { resetKey }: LazyBoundaryProps,
    state: LazyBoundaryState
  ): LazyBoundaryState | null {
    return resetKey === state.resetKey ? null : { failed: false, resetKey }
  }

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
