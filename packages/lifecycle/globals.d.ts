/**
 * The few universal globals lifecycle code uses, declared here so the package
 * compiles without the DOM, Node or Bun type libraries.
 */
declare function setTimeout(callback: () => void, ms: number): unknown
declare function clearTimeout(id: unknown): void
declare const performance: { now(): number }

interface AbortSignal {
  readonly aborted: boolean
  readonly reason: unknown
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { once?: boolean }
  ): void
  removeEventListener(type: "abort", listener: () => void): void
}

declare class AbortController {
  readonly signal: AbortSignal
  abort(reason?: unknown): void
}

declare class DOMException extends Error {
  constructor(message?: string, name?: string)
}
