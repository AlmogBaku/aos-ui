import { isMcpAppPolicyOrigin } from "@harness-gw/sdk/protocol"

import {
  MCP_APP_STABLE_ORIGINS_SETTING,
  stableOriginsOf,
} from "./mcp-app-sandbox"

/** The two lanes AOS UI serves. */
export type Surface = "operator" | "guest"

/**
 * Where MCP App views show, as every surface's `/runtime-config.json` carries
 * them: the origins people open AOS UI at, operator and guest alike, the only
 * pages that may frame the sandbox, which its page's header publishes anyway,
 * and the deployment's one sandbox origin, which every view loads from.
 */
export type DeploymentOrigins = {
  publicOrigins: readonly string[]
  mcpAppSandboxOrigin: string
  /**
   * The stable origins' wildcard, `<scheme>://*.<domain>[:port]`: a view whose
   * `domain` is one key label directly below its domain loads from that host,
   * with its scheme and port, instead of the one sandbox. Unset, none does.
   */
  mcpAppStableOrigins?: string
}

/** The setting every origin people open AOS UI at is read from. */
export const PUBLIC_ORIGIN_SETTING = "AOS_UI_PUBLIC_ORIGIN"

/** The setting the deployment's one MCP App sandbox origin is read from. */
export const MCP_APP_SANDBOX_ORIGIN_SETTING = "AOS_UI_MCP_APP_SANDBOX_ORIGIN"

type Getenv = (name: string) => string | undefined

const EXAMPLE = "such as https://agents.example"

/**
 * `localhost`, a name below it, or an IPv4 address in 127.0.0.0/8, which an
 * exact origin already writes as four decimal parts.
 */
function isLoopback(origin: string) {
  const { hostname } = new URL(origin)
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  )
}

/**
 * The host and port a request names an origin by, and routing compares: an
 * `http:` and an `https:` origin on default ports share one.
 */
const hostOf = (origin: string) => new URL(origin).host

function exactOrigin(name: string, value: string) {
  if (!isMcpAppPolicyOrigin(value))
    throw new Error(`${name}: ${value} is not an exact origin, ${EXAMPLE}`)
  return value
}

/**
 * Every origin people open AOS UI at, from its comma-separated setting, each
 * an exact origin (`isMcpAppPolicyOrigin`). Throws naming the setting.
 */
function readPublicOrigins(getenv: Getenv): string[] {
  const setting = PUBLIC_ORIGIN_SETTING
  const publicOrigins = [
    ...new Set(
      (getenv(setting) ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ].map((value) => exactOrigin(setting, value))
  if (publicOrigins.length === 0)
    throw new Error(
      `${setting} must list every origin AOS UI is opened at, operator and guest alike, ${EXAMPLE}`
    )
  return publicOrigins
}

/**
 * Refuses what `setting` names for the pages to frame unless it is loopback
 * exactly when they are, so a page on one side never frames one on the
 * other, and `https:` when any of them is, since such a page frames no
 * `http:` one.
 */
function assertFramable(
  setting: string,
  framed: string,
  publicOrigins: readonly string[]
) {
  const loopback = isLoopback(framed)
  const mismatched = publicOrigins.find(
    (origin) => isLoopback(origin) !== loopback
  )
  if (mismatched !== undefined)
    throw new Error(
      `${setting} is ${loopback ? "" : "not "}a loopback origin, but ${PUBLIC_ORIGIN_SETTING} lists ${mismatched}, which is${loopback ? " not" : ""}`
    )
  const secure = publicOrigins.find((origin) => origin.startsWith("https:"))
  if (secure !== undefined && framed.startsWith("http:"))
    throw new Error(
      `${setting} must be https:, since ${PUBLIC_ORIGIN_SETTING} lists ${secure}, whose page cannot frame an http: one`
    )
}

/**
 * The deployment's one sandbox origin, which every page frames: an exact
 * origin whose host and port are no page's, framable by them all
 * (`assertFramable`), and, on loopback, a name below `localhost`, since the
 * gateway answers `localhost` and loopback addresses on every port. Throws
 * naming the setting it refuses.
 */
function readSandboxOrigin(
  getenv: Getenv,
  publicOrigins: readonly string[]
): string {
  const setting = MCP_APP_SANDBOX_ORIGIN_SETTING
  const value = getenv(setting)?.trim()
  if (!value)
    throw new Error(
      `${setting} must name the MCP App sandbox origin, such as https://agents-sandbox.example`
    )
  const sandbox = exactOrigin(setting, value)
  if (publicOrigins.some((origin) => hostOf(origin) === hostOf(sandbox)))
    throw new Error(
      `${setting} must differ in host and port from every origin in ${PUBLIC_ORIGIN_SETTING}`
    )
  assertFramable(setting, sandbox, publicOrigins)
  if (isLoopback(sandbox) && !new URL(sandbox).hostname.endsWith(".localhost"))
    throw new Error(
      `${setting} must be a name below localhost, such as http://sandbox.localhost:3000: the gateway answers localhost and loopback addresses on every port`
    )
  return sandbox
}

/**
 * The stable origins' wildcard, lowercased, or `undefined` while it is unset:
 * a `<scheme>://*.<domain>[:port]` (`stableOriginsOf`) framable by every page
 * (`assertFramable`), whose domain has no page's host nor the sandbox's at or
 * below it, since every host there is a stable one or refused. Throws naming
 * the setting it refuses.
 */
function readStableOrigins(
  getenv: Getenv,
  publicOrigins: readonly string[],
  sandbox: string
): string | undefined {
  const setting = MCP_APP_STABLE_ORIGINS_SETTING
  const value = getenv(setting)?.trim().toLowerCase()
  if (!value) return undefined
  const stable = stableOriginsOf(value)
  if (stable === undefined)
    throw new Error(
      `${setting}: ${value} is not a wildcard origin, such as https://*.mcp-apps.example`
    )
  const claimed = [...publicOrigins, sandbox].find((origin) => {
    const { hostname } = new URL(origin)
    return hostname === stable.domain || hostname.endsWith(`.${stable.domain}`)
  })
  if (claimed !== undefined)
    throw new Error(
      `${setting} must name a domain that no origin in ${PUBLIC_ORIGIN_SETTING} or ${MCP_APP_SANDBOX_ORIGIN_SETTING} is at or below, but ${claimed} is`
    )
  assertFramable(setting, value, publicOrigins)
  return value
}

/**
 * The deployment's origins from its settings, which every surface's runtime
 * configuration carries: every origin people open AOS UI at, the one sandbox
 * origin, and the stable origins' wildcard, each checked against those pages.
 * The wildcard's key is there even while it is unset, so it writes over any
 * the configuration file names. Throws naming the setting it refuses.
 */
export function readDeploymentOrigins(getenv: Getenv): DeploymentOrigins {
  const publicOrigins = readPublicOrigins(getenv)
  const mcpAppSandboxOrigin = readSandboxOrigin(getenv, publicOrigins)
  return {
    publicOrigins,
    mcpAppSandboxOrigin,
    mcpAppStableOrigins: readStableOrigins(
      getenv,
      publicOrigins,
      mcpAppSandboxOrigin
    ),
  }
}
