import { HgwRemoteClient, type HgwRemoteClientOptions } from "@harness-gw/sdk"

/**
 * The gateway's REST client for this page. An MCP App view fetches its files
 * from an opaque origin, so their addresses resolve against the page's own.
 */
export function createGatewayClient(
  options: Omit<HgwRemoteClientOptions, "origin"> = {}
) {
  return new HgwRemoteClient({ ...options, origin: globalThis.location.origin })
}
