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
  type AosUiToolName,
  type PresentArtifactResult,
  type PresentationToolName,
} from "../../shared/presentation/tools"
import {
  PRESENTATION_VIEW_MIME_TYPE,
  presentationViews,
  type PresentationView,
  type PresentationViewName,
} from "../../shared/presentation/views"

/** Each presentation view's built, self-contained HTML document. */
export type PresentationViewDocuments = Record<PresentationViewName, string>

const SAFE_OUTPUT =
  "Never emit executable HTML, scripts, or browser-side code; Mermaid belongs only in fenced mermaid blocks."

const PRESENT_ARTIFACT_DESCRIPTION =
  "Show a file to the user in a live preview they can refresh, open, and download. Use when a concrete file is part of the answer delivered to the user, as its source, subject, or output; inspecting a candidate does not qualify. Call it once the file is ready, and call it again after each change to the file, so the user sees its latest version. Pass an absolute path inside the project workspace."

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

/**
 * A tool's result: its value as structured content, and again as the JSON the
 * text ends with, for a harness that forwards only text.
 */
function presentationResult(
  kind: AosUiToolName,
  heading: string,
  value: object
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: `${heading} is ready for display.\n\nStructured fallback:\n${JSON.stringify(value)}`,
      },
    ],
    structuredContent: { ok: true, type: "aos.presentation", kind, value },
  }
}

function registerView(server: McpServer, view: PresentationView, html: string) {
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
          text: html,
          _meta: { ui },
        },
      ],
    })
  )
}

/**
 * The stateless AOS UI tool server. The SDK parses every call against the
 * tool's Zod schema, refinements included, and reports a failed parse as a
 * tool error, so handlers only ever see validated input. Each tool declares
 * the MCP App view that draws it, and the server serves that view's HTML as a
 * `ui://aos-ui/<view>` resource. `present_artifact` opens no file: its view
 * reads the file through the address the page hands it.
 */
export function createToolsServer({
  views,
}: {
  views: PresentationViewDocuments
}): McpServer {
  const server = new McpServer({ name: "aos-ui", version: "0.0.1" })

  for (const view of Object.values(presentationViews))
    registerView(server, view, views[view.name])

  for (const [name, definition] of Object.entries(
    presentationToolDefinitions
  ) as Array<
    [
      PresentationToolName,
      (typeof presentationToolDefinitions)[PresentationToolName],
    ]
  >) {
    registerAppTool(
      server,
      name,
      {
        description: `${definition.description} ${SAFE_OUTPUT}`,
        inputSchema: definition.schema,
        annotations: { readOnlyHint: true },
        _meta: { ui: { resourceUri: presentationViews[name].resourceUri } },
      },
      (value: { title?: string }) =>
        presentationResult(name, value.title ?? "presentation", value)
    )
  }

  registerAppTool(
    server,
    "present_artifact",
    {
      description: PRESENT_ARTIFACT_DESCRIPTION,
      inputSchema: presentArtifactSchema,
      annotations: { readOnlyHint: true },
      _meta: {
        ui: { resourceUri: presentationViews.present_artifact.resourceUri },
      },
    },
    ({ path, title, mimeType }) => {
      const file: PresentArtifactResult = {
        filename: title ?? posix.basename(path),
        ...(mimeType ? { mimeType } : {}),
      }
      return presentationResult("present_artifact", file.filename, file)
    }
  )

  return server
}
