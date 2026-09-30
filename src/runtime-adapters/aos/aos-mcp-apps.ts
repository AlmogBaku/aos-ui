import { McpAppFilesRefusedError, type McpAppAdapter } from "../contracts"
import { AosClientError, type AosRemoteClient } from "./aos-client"

type McpAppClient = Pick<
  AosRemoteClient,
  "openMcpApp" | "callMcpAppTool" | "readMcpAppResource" | "renewMcpAppFiles"
>

/** A client error no retry fixes: every 4xx but the rate limit's 429. */
function refusal(error: unknown): error is AosClientError {
  return (
    error instanceof AosClientError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429
  )
}

/**
 * The tool call id is all an App request names: the proxy resolves the view's
 * resource and MCP server from the Session this client authorizes, so the
 * browser never addresses a server or a resource URI of its own.
 */
export class AosMcpAppAdapter implements McpAppAdapter {
  constructor(private readonly client: McpAppClient) {}

  open: McpAppAdapter["open"] = ({ sessionId, toolCallId }, signal) =>
    this.client.openMcpApp(sessionId, toolCallId, signal)

  callTool: McpAppAdapter["callTool"] = ({
    sessionId,
    toolCallId,
    name,
    arguments: args,
  }) =>
    this.client.callMcpAppTool(sessionId, toolCallId, { name, arguments: args })

  readResource: McpAppAdapter["readResource"] = ({
    sessionId,
    toolCallId,
    uri,
  }) => this.client.readMcpAppResource(sessionId, toolCallId, { uri })

  renewFiles: McpAppAdapter["renewFiles"] = ({ sessionId, toolCallId }) =>
    this.client
      .renewMcpAppFiles(sessionId, toolCallId)
      .catch((error: unknown) => {
        throw refusal(error)
          ? new McpAppFilesRefusedError(error.message)
          : error
      })
}
