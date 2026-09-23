import { posix } from "node:path"
import {
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

import {
  presentationToolDefinitions,
  type PresentationToolName,
} from "../../shared/presentation/tools"
import {
  PRESENTATION_VIEW_MIME_TYPE,
  presentationViews,
  type PresentationViewName,
} from "../../shared/presentation/views"

/** Each presentation view's built, self-contained HTML document. */
export type PresentationViewDocuments = Record<PresentationViewName, string>

const SAFE_OUTPUT =
  "Never emit executable HTML, scripts, or browser-side code; Mermaid belongs only in fenced mermaid blocks."

const PRESENT_ARTIFACT_DESCRIPTION =
  "Publish a file to the user. Use when a concrete file is part of the answer delivered to the user, as its source, subject, or output; inspecting a candidate does not qualify. Publish each selected file after its final edit and before the final response. Pass an absolute path inside the project workspace."

const MIME_TYPE =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u

// eslint-disable-next-line no-control-regex -- the rule rejects control characters
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u

const presentArtifactSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine((path) => path.startsWith("/"), "Path must be absolute")
    .refine((path) => posix.basename(path) !== "", "Path must name a file")
    .refine(
      (path) => !CONTROL_CHARACTER.test(path),
      "Path must not contain control characters"
    )
    .describe("Absolute POSIX path of the file inside the project workspace"),
  title: z.string().min(1).max(160).optional().describe("Display filename"),
  mimeType: z.string().max(255).regex(MIME_TYPE).optional(),
})

function presentationResult(
  kind: PresentationToolName,
  value: { title?: string }
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: `${value.title ?? "presentation"} is ready for display.\n\nStructured fallback:\n${JSON.stringify(value)}`,
      },
    ],
    structuredContent: { ok: true, type: "aos.presentation", kind, value },
  }
}

/**
 * The stateless AOS UI tool server. The SDK parses every call against the
 * tool's Zod schema, refinements included, and reports a failed parse as a
 * tool error, so handlers only ever see validated input. Each render tool
 * declares the MCP App view that draws it, and the server serves that view's
 * HTML as a `ui://aos-ui/<view>` resource.
 */
export function createToolsServer({
  views,
}: {
  views: PresentationViewDocuments
}): McpServer {
  const server = new McpServer({ name: "aos-ui", version: "0.0.1" })

  for (const [name, definition] of Object.entries(
    presentationToolDefinitions
  ) as Array<
    [
      PresentationToolName,
      (typeof presentationToolDefinitions)[PresentationToolName],
    ]
  >) {
    const view = presentationViews[name]
    const ui = { csp: view.csp }
    registerAppResource(
      server,
      `aos-ui ${view.name} view`,
      view.resourceUri,
      { mimeType: PRESENTATION_VIEW_MIME_TYPE, _meta: { ui } },
      () => ({
        contents: [
          {
            uri: view.resourceUri,
            mimeType: PRESENTATION_VIEW_MIME_TYPE,
            text: views[view.name],
            _meta: { ui },
          },
        ],
      })
    )
    registerAppTool(
      server,
      name,
      {
        description: `${definition.description} ${SAFE_OUTPUT}`,
        inputSchema: definition.schema,
        annotations: { readOnlyHint: true },
        _meta: { ui: { resourceUri: view.resourceUri } },
      },
      (value: { title?: string }) => presentationResult(name, value)
    )
  }

  server.registerTool(
    "present_artifact",
    {
      description: PRESENT_ARTIFACT_DESCRIPTION,
      inputSchema: presentArtifactSchema,
      annotations: { readOnlyHint: true },
    },
    ({ path, title, mimeType }) => {
      const receipt = {
        ok: true,
        type: "aos.artifact",
        artifact: {
          path,
          filename: title ?? posix.basename(path),
          ...(mimeType ? { mimeType } : {}),
        },
      }
      return {
        content: [{ type: "text", text: JSON.stringify(receipt) }],
        structuredContent: receipt,
      }
    }
  )

  return server
}
