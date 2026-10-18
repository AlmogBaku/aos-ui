import {
  assertLanesApart,
  readPublicOrigins,
  readSandboxOrigin,
  type Lane,
} from "../shared/lane-origins"
import { createWebApp } from "./web"

type Getenv = (name: string) => string | undefined

export type WebListener = Lane & { host: string; port: number }

export type WebServerConfig = {
  root: string
  runtimeConfigFile: string
  /** The one MCP App sandbox origin, which every listener's lane frames. */
  mcpAppSandboxOrigin: string
  listeners: WebListener[]
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"])
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"])

function port(name: string, value: string) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535)
    throw new Error(`${name} must be a port between 1 and 65535`)
  return parsed
}

/**
 * The gateway's listen rule: a loopback host, or a wildcard one only inside a
 * private container network, acknowledged with
 * `AOS_UI_WEB_EXPOSURE=private-container`. Any other address is refused.
 */
function host(name: string, value: string, getenv: Getenv) {
  if (LOOPBACK_HOSTS.has(value)) return value
  if (
    WILDCARD_HOSTS.has(value) &&
    getenv("AOS_UI_WEB_EXPOSURE") === "private-container"
  )
    return value
  throw new Error(
    WILDCARD_HOSTS.has(value)
      ? `${name}=${value} needs AOS_UI_WEB_EXPOSURE=private-container`
      : `${name} must be 127.0.0.1, ::1, 0.0.0.0 or ::`
  )
}

/**
 * Reads the web server's settings; the guest listener, and the guest lane's
 * origins, only when its port is set. The one sandbox origin is checked
 * against every listener's lane.
 */
export function readWebServerConfig(getenv: Getenv): WebServerConfig {
  const listeners: WebListener[] = [
    {
      surface: "operator",
      host: host(
        "AOS_UI_WEB_HOST",
        getenv("AOS_UI_WEB_HOST") ?? "127.0.0.1",
        getenv
      ),
      port: port("AOS_UI_WEB_PORT", getenv("AOS_UI_WEB_PORT") ?? "3000"),
      publicOrigins: readPublicOrigins(getenv, "operator"),
    },
  ]
  const guestPort = getenv("AOS_UI_GUEST_WEB_PORT")
  if (guestPort !== undefined)
    listeners.push({
      surface: "guest",
      host: host(
        "AOS_UI_GUEST_WEB_HOST",
        getenv("AOS_UI_GUEST_WEB_HOST") ?? "127.0.0.1",
        getenv
      ),
      port: port("AOS_UI_GUEST_WEB_PORT", guestPort),
      publicOrigins: readPublicOrigins(getenv, "guest"),
    })
  assertLanesApart(listeners)
  return {
    root: getenv("AOS_UI_STATIC_ROOT") ?? "/app/dist",
    runtimeConfigFile:
      getenv("AOS_UI_RUNTIME_CONFIG_FILE") ?? "/run/aos-ui/runtime-config.json",
    mcpAppSandboxOrigin: readSandboxOrigin(getenv, listeners),
    listeners,
  }
}

type Serve = (options: {
  hostname: string
  port: number
  fetch(request: Request): Promise<Response>
}) => { stop(force?: boolean): void }

/**
 * Starts one listener per surface. Whichever receives the sandbox address
 * serves the sandbox page, which every lane's pages may frame.
 */
export function startWebServer(config: WebServerConfig, serve: Serve) {
  const { mcpAppSandboxOrigin } = config
  const frameAncestors = config.listeners.flatMap(
    ({ publicOrigins }) => publicOrigins
  )
  return config.listeners.map(({ surface, host, port, publicOrigins }) =>
    serve({
      hostname: host,
      port,
      fetch: createWebApp({
        surface,
        root: config.root,
        runtimeConfigFile: config.runtimeConfigFile,
        origins: { publicOrigins, mcpAppSandboxOrigin },
        frameAncestors,
      }),
    })
  )
}

const bun = (globalThis as unknown as { Bun?: { serve: Serve } }).Bun

if ((import.meta as { main?: boolean }).main) {
  if (!bun) throw new Error("Bun runtime is required")
  startWebServer(
    readWebServerConfig((name) => process.env[name]),
    bun.serve.bind(bun)
  )
}
