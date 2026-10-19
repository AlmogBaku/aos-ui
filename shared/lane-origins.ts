import { isMcpAppPolicyOrigin } from "@harness-gw/sdk/protocol"

import {
  MCP_APP_STABLE_ORIGINS_SETTING,
  stableOriginsOf,
} from "./mcp-app-sandbox"

/** The two lanes AOS UI serves, each on origins of its own. */
export type Surface = "operator" | "guest"

/**
 * Where one lane shows MCP App views, as its `/runtime-config.json` carries
 * them: the origins people open the lane at, the deployment's one sandbox
 * origin, which every lane's views load from, and every lane's origins, the
 * only pages that may frame it, which its page's header publishes anyway.
 */
export type LaneOrigins = {
  publicOrigins: readonly string[]
  mcpAppSandboxOrigin: string
  /**
   * The stable origins' wildcard, `<scheme>://*.<domain>[:port]`: a view whose
   * `domain` is one key label directly below its domain loads from that host,
   * with its scheme and port, instead of the one sandbox. Unset, none does.
   */
  mcpAppStableOrigins?: string
  mcpAppFrameAncestors: readonly string[]
}

/** One lane's public origins. */
export type Lane = { surface: Surface; publicOrigins: readonly string[] }

/**
 * Every lane's public origins, the one sandbox origin they all frame, and the
 * stable origins' wildcard, when it is set, which they frame too.
 */
export type DeploymentOrigins = {
  lanes: readonly Lane[]
  mcpAppSandboxOrigin: string
  mcpAppStableOrigins?: string
}

/** The setting each lane's public origins are read from. */
export const PUBLIC_ORIGIN_SETTINGS = {
  operator: "AOS_UI_PUBLIC_ORIGIN",
  guest: "AOS_UI_GUEST_PUBLIC_ORIGIN",
} as const satisfies Record<Surface, string>

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
 * One lane's public origins from its comma-separated setting, each an exact
 * origin (`isMcpAppPolicyOrigin`). Throws naming the setting it refuses.
 */
function readPublicOrigins(getenv: Getenv, surface: Surface): string[] {
  const setting = PUBLIC_ORIGIN_SETTINGS[surface]
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
      `${setting} must list the origins the lane is opened at, ${EXAMPLE}`
    )
  return publicOrigins
}

/** A lane's origin, and the setting that lists it. */
type Listed = { origin: string; list: string }

const listedOrigins = (lanes: readonly Lane[]): Listed[] =>
  lanes.flatMap(({ surface, publicOrigins }) =>
    publicOrigins.map((origin) => ({
      origin,
      list: PUBLIC_ORIGIN_SETTINGS[surface],
    }))
  )

/**
 * Refuses what `setting` names for every lane's pages to frame unless it is
 * loopback exactly when they are, so a page on one side never frames one on
 * the other, and `https:` when any of them is, since such a page frames no
 * `http:` one.
 */
function assertFramable(
  setting: string,
  framed: string,
  listed: readonly Listed[]
) {
  const loopback = isLoopback(framed)
  const mismatched = listed.find(
    ({ origin }) => isLoopback(origin) !== loopback
  )
  if (mismatched !== undefined)
    throw new Error(
      `${setting} is ${loopback ? "" : "not "}a loopback origin, but ${mismatched.list} lists ${mismatched.origin}, which is${loopback ? " not" : ""}`
    )
  const secure = listed.find(({ origin }) => origin.startsWith("https:"))
  if (secure !== undefined && framed.startsWith("http:"))
    throw new Error(
      `${setting} must be https:, since ${secure.list} lists ${secure.origin}, whose page cannot frame an http: one`
    )
}

/**
 * The deployment's one sandbox origin, which every lane's pages frame: an
 * exact origin whose host and port are no lane origin's, framable by them all
 * (`assertFramable`), and, on loopback, a name below `localhost`, since the
 * gateway answers `localhost` and loopback addresses on every port. Throws
 * naming the setting it refuses.
 */
function readSandboxOrigin(getenv: Getenv, listed: readonly Listed[]): string {
  const setting = MCP_APP_SANDBOX_ORIGIN_SETTING
  const value = getenv(setting)?.trim()
  if (!value)
    throw new Error(
      `${setting} must name the MCP App sandbox origin, such as https://agents-sandbox.example`
    )
  const sandbox = exactOrigin(setting, value)
  const overlapping = listed.find(
    ({ origin }) => hostOf(origin) === hostOf(sandbox)
  )
  if (overlapping !== undefined)
    throw new Error(
      `${setting} must differ in host and port from every origin in ${overlapping.list}`
    )
  assertFramable(setting, sandbox, listed)
  if (isLoopback(sandbox) && !new URL(sandbox).hostname.endsWith(".localhost"))
    throw new Error(
      `${setting} must be a name below localhost, such as http://sandbox.localhost:3000: the gateway answers localhost and loopback addresses on every port`
    )
  return sandbox
}

/**
 * The stable origins' wildcard, lowercased, or `undefined` while it is unset:
 * a `<scheme>://*.<domain>[:port]` (`stableOriginsOf`) framable by every
 * lane's pages (`assertFramable`), whose domain has no lane's host nor the
 * sandbox's at or below it, since every host there is a stable one or
 * refused. Throws naming the setting it refuses.
 */
function readStableOrigins(
  getenv: Getenv,
  listed: readonly Listed[],
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
  const claimed = [
    ...listed,
    { origin: sandbox, list: MCP_APP_SANDBOX_ORIGIN_SETTING },
  ].find(({ origin }) => {
    const { hostname } = new URL(origin)
    return hostname === stable.domain || hostname.endsWith(`.${stable.domain}`)
  })
  if (claimed !== undefined)
    throw new Error(
      `${setting} must name a domain no lane or sandbox host is at or below, but ${claimed.list} names ${claimed.origin}`
    )
  assertFramable(setting, value, listed)
  return value
}

/** Refuses an origin two lanes both list: each page belongs to one lane. */
function assertLanesApart(lanes: readonly Lane[]) {
  const owners = new Map<string, Surface>()
  for (const { surface, publicOrigins } of lanes)
    for (const origin of publicOrigins) {
      const owner = owners.get(origin)
      if (owner !== undefined)
        throw new Error(
          `${origin} is in both ${PUBLIC_ORIGIN_SETTINGS[owner]} and ${PUBLIC_ORIGIN_SETTINGS[surface]}`
        )
      owners.set(origin, surface)
    }
}

/**
 * The deployment's origins from its settings, for the lanes in `surfaces`:
 * each lane's own, the one sandbox origin, and the stable origins' wildcard,
 * each checked against every lane. Throws naming the setting it refuses.
 */
export function readDeploymentOrigins(
  getenv: Getenv,
  surfaces: readonly Surface[]
): DeploymentOrigins {
  const lanes = surfaces.map((surface) => ({
    surface,
    publicOrigins: readPublicOrigins(getenv, surface),
  }))
  assertLanesApart(lanes)
  const listed = listedOrigins(lanes)
  const mcpAppSandboxOrigin = readSandboxOrigin(getenv, listed)
  return {
    lanes,
    mcpAppSandboxOrigin,
    mcpAppStableOrigins: readStableOrigins(getenv, listed, mcpAppSandboxOrigin),
  }
}

/**
 * The origins `surface`'s runtime configuration carries; every lane's pages,
 * whichever lane it is, may frame the one sandbox and the stable origins. The
 * wildcard's key is there even while it is unset, so it writes over any the
 * configuration file names.
 */
export function laneOrigins(
  { lanes, mcpAppSandboxOrigin, mcpAppStableOrigins }: DeploymentOrigins,
  surface: Surface
): LaneOrigins {
  const lane = lanes.find((candidate) => candidate.surface === surface)
  if (lane === undefined)
    throw new Error(`The ${surface} lane's origins were not read`)
  return {
    publicOrigins: lane.publicOrigins,
    mcpAppSandboxOrigin,
    mcpAppStableOrigins,
    mcpAppFrameAncestors: lanes.flatMap(({ publicOrigins }) => publicOrigins),
  }
}
