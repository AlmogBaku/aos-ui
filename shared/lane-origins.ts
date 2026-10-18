import { isMcpAppPolicyOrigin } from "@harness-gw/sdk/protocol"

/** The two lanes AOS UI serves, each on an origin of its own. */
export type Surface = "operator" | "guest"

/**
 * Where one lane shows MCP App views, as its `/runtime-config.json` carries
 * them: the origins people open the lane at, the only pages that may frame its
 * views, and the sandbox origin those views load from.
 */
export type LaneOrigins = {
  publicOrigins: readonly string[]
  mcpAppSandboxOrigin: string
}

/** The settings each lane's origins are read from. */
export const LANE_ORIGIN_SETTINGS = {
  operator: {
    publicOrigins: "AOS_UI_PUBLIC_ORIGIN",
    mcpAppSandboxOrigin: "AOS_UI_MCP_APP_SANDBOX_ORIGIN",
  },
  guest: {
    publicOrigins: "AOS_UI_GUEST_PUBLIC_ORIGIN",
    mcpAppSandboxOrigin: "AOS_UI_GUEST_MCP_APP_SANDBOX_ORIGIN",
  },
} as const satisfies Record<Surface, Record<keyof LaneOrigins, string>>

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

/** Whether `origin` shares its host and port with one of `origins`. */
const sharesHost = (origin: string, origins: readonly string[]) =>
  origins.some((other) => hostOf(other) === hostOf(origin))

function exactOrigin(name: string, value: string) {
  if (!isMcpAppPolicyOrigin(value))
    throw new Error(`${name}: ${value} is not an exact origin, ${EXAMPLE}`)
  return value
}

/**
 * One lane's origins from its settings, each an exact origin
 * (`isMcpAppPolicyOrigin`): the public ones a comma-separated list. The
 * sandbox shares a host and port with none of them, is loopback exactly when
 * they are, so a page on one side never frames a sandbox on the other, and
 * then is a name below `localhost`, since the gateway answers `localhost` and
 * loopback addresses on every port. An `https:` page frames no `http:`
 * sandbox. Throws naming the setting it refuses.
 */
export function readLaneOrigins(
  getenv: (name: string) => string | undefined,
  surface: Surface
): LaneOrigins {
  const settings = LANE_ORIGIN_SETTINGS[surface]
  const publicOrigins = [
    ...new Set(
      (getenv(settings.publicOrigins) ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ].map((value) => exactOrigin(settings.publicOrigins, value))
  if (publicOrigins.length === 0)
    throw new Error(
      `${settings.publicOrigins} must list the origins the lane is opened at, ${EXAMPLE}`
    )
  const sandbox = getenv(settings.mcpAppSandboxOrigin)?.trim()
  if (!sandbox)
    throw new Error(
      `${settings.mcpAppSandboxOrigin} must name the lane's MCP App sandbox origin, such as https://agents-sandbox.example`
    )
  const mcpAppSandboxOrigin = exactOrigin(settings.mcpAppSandboxOrigin, sandbox)
  if (sharesHost(mcpAppSandboxOrigin, publicOrigins))
    throw new Error(
      `${settings.mcpAppSandboxOrigin} must differ in host and port from every origin in ${settings.publicOrigins}`
    )
  const loopback = isLoopback(mcpAppSandboxOrigin)
  const mismatched = publicOrigins.find(
    (origin) => isLoopback(origin) !== loopback
  )
  if (mismatched !== undefined)
    throw new Error(
      `${settings.mcpAppSandboxOrigin} is ${loopback ? "" : "not "}a loopback origin, but ${settings.publicOrigins} lists ${mismatched}, which is${loopback ? " not" : ""}`
    )
  if (loopback && !new URL(mcpAppSandboxOrigin).hostname.endsWith(".localhost"))
    throw new Error(
      `${settings.mcpAppSandboxOrigin} must be a name below localhost, such as http://sandbox.localhost:3000: the gateway answers localhost and loopback addresses on every port`
    )
  const secure = publicOrigins.find((origin) => origin.startsWith("https:"))
  if (secure !== undefined && mcpAppSandboxOrigin.startsWith("http:"))
    throw new Error(
      `${settings.mcpAppSandboxOrigin} must be https:, since ${settings.publicOrigins} lists ${secure}, whose page cannot frame an http: one`
    )
  return { publicOrigins, mcpAppSandboxOrigin }
}

/**
 * Refuses two lanes that share an origin: each lane's sandbox is its own, by
 * host and port as routing tells them apart, and neither is a page of the
 * other lane.
 */
export function assertLanesApart(operator: LaneOrigins, guest: LaneOrigins) {
  const settings = LANE_ORIGIN_SETTINGS
  if (sharesHost(guest.mcpAppSandboxOrigin, [operator.mcpAppSandboxOrigin]))
    throw new Error(
      `${settings.guest.mcpAppSandboxOrigin} must differ in host and port from ${settings.operator.mcpAppSandboxOrigin}`
    )
  if (sharesHost(operator.mcpAppSandboxOrigin, guest.publicOrigins))
    throw new Error(
      `${settings.operator.mcpAppSandboxOrigin} must differ in host and port from every origin in ${settings.guest.publicOrigins}`
    )
  if (sharesHost(guest.mcpAppSandboxOrigin, operator.publicOrigins))
    throw new Error(
      `${settings.guest.mcpAppSandboxOrigin} must differ in host and port from every origin in ${settings.operator.publicOrigins}`
    )
  const shared = operator.publicOrigins.find((origin) =>
    guest.publicOrigins.includes(origin)
  )
  if (shared !== undefined)
    throw new Error(
      `${shared} is in both ${settings.operator.publicOrigins} and ${settings.guest.publicOrigins}`
    )
}
