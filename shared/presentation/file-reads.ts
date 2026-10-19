/**
 * How the artifact view's file is read at its address, outside the view's
 * sandbox: the view asks its page for the address with `resources/read`, the
 * page and the gateway relay that to the `aos-ui` server, and the server reads
 * the address from the gateway, server to server. The fixture answers the same
 * read from its own files the same way.
 */

/**
 * The largest file a read returns, in decoded bytes: exactly this many is
 * read, one more is `tooLarge`. It is the gateway's `MAX_MCP_APP_FILE_BYTES`,
 * which `@harness-gw/sdk/protocol` exports from 0.14.0; this repository takes
 * it from there once it takes that release.
 */
export const FILE_READ_LIMIT = 64 * 1024 * 1024

/**
 * Why a read of a file address failed, as its JSON-RPC error names it in
 * `data.reason`: the gateway refused the path (`403`), the file is larger than
 * `FILE_READ_LIMIT`, or the address answered with anything else or nothing.
 * The gateway names its own refusals the same way, adding `unavailable` when
 * it cannot forward the read at all.
 */
export type FileReadReason = "denied" | "tooLarge" | "unreachable"

/** Why an address that answered `status`, other than a 2xx, was not read. */
export function refusalReason(status: number): FileReadReason {
  // The gateway answers 403 only for a path its folders do not serve.
  return status === 403 ? "denied" : "unreachable"
}
