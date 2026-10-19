import { z } from "zod"

import { ArtifactMissingError } from "@/artifacts/browser-artifact-adapter"
import { FileReadRefusalSchema } from "@shared/presentation/file-reads"

import {
  McpAppFilesRefusedError,
  McpAppResourceReadError,
  type McpAppAdapter,
  type McpAppTarget,
} from "../contracts"
import {
  HgwClientError,
  type HgwRemoteClient,
  type McpAppSubject,
} from "@harness-gw/sdk"

type McpAppClient = Pick<
  HgwRemoteClient,
  "openMcpApp" | "callMcpAppTool" | "readMcpAppResource" | "renewMcpAppFiles"
>

/** A client error no retry fixes: every 4xx but the rate limit's 429. */
function refusal(error: unknown): error is HgwClientError {
  return (
    error instanceof HgwClientError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429
  )
}

/**
 * A gateway refusal of a read that names its reason. The SDK release that
 * types it follows harness-gw's; until this repository takes it, the reason
 * is read by its shape.
 */
const RefusedReadSchema = z.object({ reason: FileReadRefusalSchema })

/** The part of a target the gateway's path names under its Session. */
function subjectOf(target: McpAppTarget): McpAppSubject {
  return "toolCallId" in target
    ? { toolCallId: target.toolCallId }
    : { artifactId: target.artifactId }
}

/**
 * A tool call id or a published Artifact id is all an App request names: the
 * gateway resolves the view's resource and MCP server from the Session this
 * client authorizes, so the browser never addresses a server or a resource
 * URI of its own. An Artifact's view calls no tool.
 */
export class AosMcpAppAdapter implements McpAppAdapter {
  constructor(private readonly client: McpAppClient) {}

  open: McpAppAdapter["open"] = (target, signal) =>
    this.client
      .openMcpApp(target.sessionId, subjectOf(target), signal)
      .catch((error: unknown) => {
        // A pruned Artifact is a permanent, presentable state, as its bytes are.
        throw error instanceof HgwClientError &&
          error.kind === "artifact-missing"
          ? new ArtifactMissingError()
          : error
      })

  callTool: McpAppAdapter["callTool"] = async (input) => {
    if (!("toolCallId" in input))
      throw new Error("A published Artifact's view calls no tool")
    return this.client.callMcpAppTool(input.sessionId, input.toolCallId, {
      name: input.name,
      arguments: input.arguments,
    })
  }

  readResource: McpAppAdapter["readResource"] = (input) =>
    this.client
      .readMcpAppResource(input.sessionId, subjectOf(input), {
        uri: input.uri,
      })
      .catch((error: unknown) => {
        // The gateway names why it or the view's server refused a read.
        const refused = RefusedReadSchema.safeParse(error).data
        throw refused ? new McpAppResourceReadError(refused.reason) : error
      })

  renewFiles: McpAppAdapter["renewFiles"] = (target) =>
    this.client
      .renewMcpAppFiles(target.sessionId, subjectOf(target))
      .catch((error: unknown) => {
        throw refusal(error)
          ? new McpAppFilesRefusedError(error.message)
          : error
      })
}
