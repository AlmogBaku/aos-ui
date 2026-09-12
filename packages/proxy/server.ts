type FetchHandler = (
  request: Request,
  server?: unknown
) => Response | Promise<Response>
type Server = { stop(closeActiveConnections?: boolean): Promise<void> | void }
type Serve = (options: {
  hostname: string
  port: number
  fetch: FetchHandler
}) => Server

export type StartProxyServerOptions = {
  app: { fetch: FetchHandler }
  host: string
  port: number
  shutdownGraceMs: number
  serve?: Serve
  installSignalHandlers?: boolean
}

function bunServe(): Serve {
  const bun = (globalThis as unknown as { Bun?: { serve: Serve } }).Bun
  if (!bun) throw new Error("Bun runtime is required")
  return bun.serve.bind(bun)
}

export function startProxyServer(options: StartProxyServerOptions) {
  const server = (options.serve ?? bunServe())({
    hostname: options.host,
    port: options.port,
    fetch: options.app.fetch.bind(options.app),
  })
  let shutdownPromise: Promise<void> | undefined
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise
    shutdownPromise = new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(forceTimer)
        resolve()
      }
      const forceTimer = setTimeout(() => {
        void Promise.resolve(server.stop(true)).then(finish, finish)
      }, options.shutdownGraceMs)
      void Promise.resolve(server.stop(false)).then(finish, finish)
    })
    return shutdownPromise
  }

  if (options.installSignalHandlers !== false) {
    const onSignal = () => void shutdown()
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
  }
  return { server, shutdown }
}
