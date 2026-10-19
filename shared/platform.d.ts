/** Minimal WHATWG URL surface used by platform-independent configuration parsing. */
interface URL {
  readonly host: string
  readonly hostname: string
  readonly href: string
  readonly origin: string
  readonly password: string
  readonly protocol: string
  readonly username: string
}

declare const URL: {
  new (input: string, base?: string | URL): URL
}

/** Minimal WHATWG URLSearchParams surface used to read and write a page's query. */
interface URLSearchParams {
  append(name: string, value: string): void
  getAll(name: string): string[]
  set(name: string, value: string): void
  toString(): string
}

declare const URLSearchParams: {
  new (): URLSearchParams
}
