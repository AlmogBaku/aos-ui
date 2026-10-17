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

/** `localhost`, a name below it, or an IPv4 loopback address. */
function isLoopback(origin: string) {
  const { hostname } = new URL(origin)
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.startsWith("127.")
  )
}

function exactOrigin(name: string, value: string) {
  if (!isMcpAppPolicyOrigin(value))
    throw new Error(`${name}: ${value} is not an exact origin, ${EXAMPLE}`)
  return value
}

/**
 * One lane's origins from its settings, each an exact origin
 * (`isMcpAppPolicyOrigin`): the public ones a comma-separated list. The
 * sandbox origin is none of them, and is loopback exactly when they are, so a
 * page on one side never frames a sandbox on the other. Throws naming the
 * setting it refuses.
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
      `${settings.mcpAppSandboxOrigin} must name the lane's MCP App sandbox origin, such as https://sandbox.agents.example`
    )
  const mcpAppSandboxOrigin = exactOrigin(settings.mcpAppSandboxOrigin, sandbox)
  if (publicOrigins.includes(mcpAppSandboxOrigin))
    throw new Error(
      `${settings.mcpAppSandboxOrigin} must differ from every origin in ${settings.publicOrigins}`
    )
  const loopback = isLoopback(mcpAppSandboxOrigin)
  const mismatched = publicOrigins.find(
    (origin) => isLoopback(origin) !== loopback
  )
  if (mismatched !== undefined)
    throw new Error(
      `${settings.mcpAppSandboxOrigin} is ${loopback ? "" : "not "}a loopback origin, but ${settings.publicOrigins} lists ${mismatched}, which is${loopback ? " not" : ""}`
    )
  return { publicOrigins, mcpAppSandboxOrigin }
}

/**
 * Refuses two lanes that share an origin: each lane's sandbox is its own, and
 * neither is a page of the other lane.
 */
export function assertLanesApart(operator: LaneOrigins, guest: LaneOrigins) {
  const settings = LANE_ORIGIN_SETTINGS
  if (operator.mcpAppSandboxOrigin === guest.mcpAppSandboxOrigin)
    throw new Error(
      `${settings.guest.mcpAppSandboxOrigin} must differ from ${settings.operator.mcpAppSandboxOrigin}`
    )
  if (guest.publicOrigins.includes(operator.mcpAppSandboxOrigin))
    throw new Error(
      `${settings.operator.mcpAppSandboxOrigin} must differ from every origin in ${settings.guest.publicOrigins}`
    )
  if (operator.publicOrigins.includes(guest.mcpAppSandboxOrigin))
    throw new Error(
      `${settings.guest.mcpAppSandboxOrigin} must differ from every origin in ${settings.operator.publicOrigins}`
    )
  const shared = operator.publicOrigins.find((origin) =>
    guest.publicOrigins.includes(origin)
  )
  if (shared !== undefined)
    throw new Error(
      `${shared} is in both ${settings.operator.publicOrigins} and ${settings.guest.publicOrigins}`
    )
}
