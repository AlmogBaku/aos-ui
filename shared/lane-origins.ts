import { isMcpAppPolicyOrigin } from "@harness-gw/sdk/protocol"

/** The two lanes AOS UI serves, each on origins of its own. */
export type Surface = "operator" | "guest"

/**
 * Where one lane shows MCP App views, as its `/runtime-config.json` carries
 * them: the origins people open the lane at, and the deployment's one sandbox
 * origin, which every lane's views load from.
 */
export type LaneOrigins = {
  publicOrigins: readonly string[]
  mcpAppSandboxOrigin: string
}

/** One lane's public origins. */
export type Lane = { surface: Surface; publicOrigins: readonly string[] }

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
export function readPublicOrigins(getenv: Getenv, surface: Surface): string[] {
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

/**
 * The deployment's one sandbox origin, which every lane in `lanes` frames: an
 * exact origin whose host and port are no lane origin's, loopback exactly when
 * they are, so a page on one side never frames a sandbox on the other, and
 * then a name below `localhost`, since the gateway answers `localhost` and
 * loopback addresses on every port. An `https:` page frames no `http:`
 * sandbox. Throws naming the setting it refuses.
 */
export function readSandboxOrigin(
  getenv: Getenv,
  lanes: readonly Lane[]
): string {
  const setting = MCP_APP_SANDBOX_ORIGIN_SETTING
  const value = getenv(setting)?.trim()
  if (!value)
    throw new Error(
      `${setting} must name the MCP App sandbox origin, such as https://agents-sandbox.example`
    )
  const sandbox = exactOrigin(setting, value)
  const listed = lanes.flatMap(({ surface, publicOrigins }) =>
    publicOrigins.map((origin) => ({
      origin,
      list: PUBLIC_ORIGIN_SETTINGS[surface],
    }))
  )
  const overlapping = listed.find(
    ({ origin }) => hostOf(origin) === hostOf(sandbox)
  )
  if (overlapping !== undefined)
    throw new Error(
      `${setting} must differ in host and port from every origin in ${overlapping.list}`
    )
  const loopback = isLoopback(sandbox)
  const mismatched = listed.find(
    ({ origin }) => isLoopback(origin) !== loopback
  )
  if (mismatched !== undefined)
    throw new Error(
      `${setting} is ${loopback ? "" : "not "}a loopback origin, but ${mismatched.list} lists ${mismatched.origin}, which is${loopback ? " not" : ""}`
    )
  if (loopback && !new URL(sandbox).hostname.endsWith(".localhost"))
    throw new Error(
      `${setting} must be a name below localhost, such as http://sandbox.localhost:3000: the gateway answers localhost and loopback addresses on every port`
    )
  const secure = listed.find(({ origin }) => origin.startsWith("https:"))
  if (secure !== undefined && sandbox.startsWith("http:"))
    throw new Error(
      `${setting} must be https:, since ${secure.list} lists ${secure.origin}, whose page cannot frame an http: one`
    )
  return sandbox
}

/** Refuses an origin two lanes both list: each page belongs to one lane. */
export function assertLanesApart(lanes: readonly Lane[]) {
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
