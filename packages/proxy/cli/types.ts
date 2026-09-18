import type { ConfiguredProxyDependencies } from "../composition"
import type { startProxyServer } from "../server"
import type { StaticHandler } from "../static"

export type ProxyCliDependencies = ConfiguredProxyDependencies & {
  start?: typeof startProxyServer
  staticHandler?: StaticHandler
  getenv?: (name: string) => string | undefined
  randomBytes?: (size: number) => Uint8Array
  clock?: () => number
  writeOut?: (value: string) => void
  writeErr?: (value: string) => void
  /** Install the process shutdown signal handler; overridden in tests. */
  onShutdownSignal?: (handler: () => void) => void
  exit?: (code: number) => void
}

export type ProxyLifecycle = {
  server: unknown
  guestServer?: unknown
  shutdown(): Promise<void>
}
