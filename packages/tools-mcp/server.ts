import { posix } from "node:path"
import {
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server"
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  ErrorCode,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

import {
  presentationToolDefinitions,
  type AosUiToolName,
  type PresentArtifactResult,
  type PresentationToolName,
} from "../../shared/presentation/tools"
import {
  GRAMMAR_RESOURCE_URI,
  PDFJS_RESOURCE_URI,
  PDFJS_WORKER_FILE,
  PRESENTATION_VIEW_MIME_TYPE,
  presentationViews,
  type PresentationView,
  type PresentationViewName,
} from "../../shared/presentation/views"

/** Each presentation view's built, self-contained HTML document. */
export type PresentationViewDocuments = Record<PresentationViewName, string>

/** Files a view reads from the server, keyed by their path in one folder. */
export type ViewFiles = ReadonlyMap<string, Uint8Array>

/**
 * What the server serves: the built views, and the pdf.js files and code
 * grammars the artifact view reads beside them.
 */
export type ToolsServerFiles = {
  views: PresentationViewDocuments
  pdfjs?: ViewFiles
  grammars?: ViewFiles
}

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
 * The name a presented file shows by: the path's own, or its title ending in
 * the path's extension, which the view and a download type the file by.
 */
function displayFilename(path: string, title: string | undefined) {
  if (title === undefined) return posix.basename(path)
  const extension = posix.extname(path)
  return title.toLowerCase().endsWith(extension.toLowerCase())
    ? title
    : `${title}${extension}`
}

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
  const ui = {
    csp: view.csp,
    ...(view.permissions ? { permissions: view.permissions } : {}),
  }
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
 * Serves each of `files` at `<uri><path>`: as text of the type `textType`
 * names for it, else as bytes. A view asks for them by name, so they stay out
 * of the resource list.
 */
function registerFiles(
  server: McpServer,
  name: string,
  uri: string,
  files: ViewFiles,
  textType: (path: string) => string | undefined
) {
  server.registerResource(
    `aos-ui ${name}`,
    new ResourceTemplate(`${uri}{+path}`, { list: undefined }),
    {},
    (address, variables) => {
      const path = String(variables.path)
      const bytes = files.get(path)
      if (!bytes)
        throw new McpError(
          ErrorCode.InvalidParams,
          `No ${name} at ${address.href}`
        )
      const mimeType = textType(path)
      return {
        contents: [
          mimeType
            ? {
                uri: address.href,
                mimeType,
                text: new TextDecoder().decode(bytes),
              }
            : {
                uri: address.href,
                mimeType: "application/octet-stream",
                blob: Buffer.from(bytes).toString("base64"),
              },
        ],
      }
    }
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
  pdfjs = new Map(),
  grammars = new Map(),
}: ToolsServerFiles): McpServer {
  const server = new McpServer({ name: "aos-ui", version: "0.0.1" })

  for (const view of Object.values(presentationViews))
    registerView(server, view, views[view.name])
  // pdf.js's worker is script text; every other pdf.js file is bytes.
  registerFiles(server, "pdf.js file", PDFJS_RESOURCE_URI, pdfjs, (path) =>
    path === PDFJS_WORKER_FILE ? "text/javascript" : undefined
  )
  registerFiles(
    server,
    "grammar",
    GRAMMAR_RESOURCE_URI,
    grammars,
    () => "application/json"
  )

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
        filename: displayFilename(path, title),
        ...(mimeType ? { mimeType } : {}),
      }
      return presentationResult("present_artifact", file.filename, file)
    }
  )

  return server
}
