/** Minimal WHATWG URL surface used by platform-independent configuration parsing. */
interface URL {
  readonly href: string
  readonly password: string
  readonly protocol: string
  readonly username: string
}

declare const URL: {
  new (input: string, base?: string | URL): URL
}
