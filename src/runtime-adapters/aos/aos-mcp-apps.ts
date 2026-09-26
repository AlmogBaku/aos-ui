import type { McpAppAdapter } from "../contracts"
import type { AosRemoteClient } from "./aos-client"

type McpAppClient = Pick<
  AosRemoteClient,
  "openMcpApp" | "callMcpAppTool" | "readMcpAppResource"
>

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
}
