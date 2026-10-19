import type { McpAppFileReadFailure } from "@harness-gw/sdk/protocol"

/**
 * How the artifact view's file is read at its address, outside the view's
 * sandbox: the view asks its page for the address with `resources/read`, the
 * page and the gateway relay that to the `aos-ui` server, and the server reads
 * the address from the gateway, server to server, up to the gateway's
 * `MAX_MCP_APP_FILE_BYTES`. The fixture answers the same read from its own
 * files the same way.
 */

/**
 * Why the `aos-ui` server could not read a file address, as its JSON-RPC
 * error names it in `data.reason`: the gateway refused the path (`403`), the
 * file is past `MAX_MCP_APP_FILE_BYTES`, or the address answered with anything
 * else or nothing. The gateway names the same reasons, adding `unavailable`
 * when it cannot forward the read at all (`McpAppFileReadFailure`).
 */
export type FileReadReason = Exclude<McpAppFileReadFailure, "unavailable">

/** Why an address that answered `status`, other than a 2xx, was not read. */
export function refusalReason(status: number): FileReadReason {
  // The gateway answers 403 only for a path its folders do not serve.
  return status === 403 ? "denied" : "unreachable"
}
