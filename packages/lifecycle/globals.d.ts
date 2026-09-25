/**
 * The few universal globals lifecycle code uses, declared here so the package
 * compiles without the DOM, Node or Bun type libraries.
 */
declare function setTimeout(callback: () => void, ms: number): unknown
declare function clearTimeout(id: unknown): void
declare const performance: { now(): number }
