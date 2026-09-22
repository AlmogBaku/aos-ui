import type { ConfiguredProxyDependencies } from "../composition"
import type { ProxyConfigFileAccess } from "../config-file"
import type { startProxyServer } from "../server"
import type { StaticHandler } from "../static"

export type ProxyCliDependencies = ConfiguredProxyDependencies &
  Partial<ProxyConfigFileAccess> & {
    start?: typeof startProxyServer
    staticHandler?: StaticHandler
    /**
     * Required: the only `process.env`-backed reader is built in `cli.ts`, so a
     * test can never discover the operator's own configuration file.
     */
    getenv: (name: string) => string | undefined
    randomBytes?: (size: number) => Uint8Array
    clock?: () => number
    writeOut?: (value: string) => void
    writeErr?: (value: string) => void
    /** Ends the process once every listener has shut down. */
    exit?: (code: number) => void
  }

export type ProxyLifecycle = {
  server: unknown
  guestServer?: unknown
  shutdown(): Promise<void>
}
