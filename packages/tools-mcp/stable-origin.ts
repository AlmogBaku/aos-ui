import { mcpAppStableOriginKey } from "@harness-gw/sdk/node"

import {
  MCP_APP_STABLE_ORIGINS_SETTING,
  stableOriginsOf,
} from "../../shared/mcp-app-sandbox"
import type { ArtifactStableOrigin } from "./server"

/** The URL the gateway dials this server at, as the operator names it. */
const TOOLS_MCP_URL_SETTING = "AOS_UI_TOOLS_MCP_URL"

/**
 * The artifact view's stable origin, from the stable origins' wildcard and the
 * URL the gateway dials this server at, which the gateway checks the key
 * against: `<key of that URL>.<the wildcard's domain>`, expected with the
 * wildcard's port. It has none while either setting is unset, or under
 * `--stdio`, which no gateway dials a URL for; `note` says which, or what it
 * declares. Throws for a setting that names no wildcard or no URL.
 */
export function artifactStableOrigin(
  environment: Readonly<Record<string, string | undefined>>,
  stdio: boolean
): { origin?: ArtifactStableOrigin; note: string } {
  const wildcard = environment[MCP_APP_STABLE_ORIGINS_SETTING]?.trim()
  const url = environment[TOOLS_MCP_URL_SETTING]?.trim()
  const none = (reason: string) => ({
    note: `The artifact view declares no stable origin: ${reason}.`,
  })
  if (!wildcard) return none(`${MCP_APP_STABLE_ORIGINS_SETTING} is unset`)
  if (stdio) return none("under --stdio, no gateway dials it at a URL")
  if (!url) return none(`${TOOLS_MCP_URL_SETTING} is unset`)
  const stable = stableOriginsOf(wildcard.toLowerCase())
  if (stable === undefined)
    throw new Error(
      `${MCP_APP_STABLE_ORIGINS_SETTING}: ${wildcard} is not a wildcard origin, such as https://*.mcp-apps.example`
    )
  let key: string
  try {
    key = mcpAppStableOriginKey(url)
  } catch {
    throw new Error(
      `${TOOLS_MCP_URL_SETTING}: ${url} is not a URL, such as http://tools-mcp:4110/mcp`
    )
  }
  const domain = `${key}.${stable.domain}`
  return {
    origin: { domain, host: `${domain}${stable.port}` },
    note: `The artifact view declares the stable origin ${domain}.`,
  }
}
