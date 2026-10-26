import { posix } from "node:path"
import { artifactFileId } from "@harness-gw/sdk/node"
import {
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server"
import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
  type CallToolResult,
} from "@modelcontextprotocol/server"
import { z } from "zod"

import {
  presentationToolDefinitions,
  type AosUiToolName,
  type PresentArtifactResult,
  type PresentationToolName,
} from "../../shared/presentation/tools"
import {
  ARTIFACT_VIEW_HOST_META,
  GRAMMAR_RESOURCE_URI,
  MAPLIBRE_RESOURCE_URI,
  OFFICE_RESOURCE_URI,
  PDFJS_RESOURCE_URI,
  PDFJS_WORKER_FILE,
  PRESENTATION_VIEW_MIME_TYPE,
  presentationViews,
  type PresentationView,
  type PresentationViewName,
} from "../../shared/presentation/views"
import {
  fileReader,
  registerFileReads,
  type FileReadOptions,
  type FileReader,
} from "./file-reads"

/** Each presentation view's built, self-contained HTML document. */
export type PresentationViewDocuments = Record<PresentationViewName, string>

/** Files a view reads from the server, keyed by their path in one folder. */
export type ViewFiles = ReadonlyMap<string, Uint8Array>

/**
 * What the server serves: the built views, the pdf.js files, code grammars,
 * and Office scripts the artifact view reads beside them, and the map view's
 * MapLibre worker.
 */
export type ToolsServerFiles = {
  views: PresentationViewDocuments
  pdfjs?: ViewFiles
  grammars?: ViewFiles
  maplibre?: ViewFiles
  office?: ViewFiles
}

/**
 * The artifact view's stable origin: the `domain` its resource declares, and
 * the host its HTML expects to run on, that domain with the stable origins'
 * port, if they name one.
 */
export type ArtifactStableOrigin = { domain: string; host: string }

/** What the server declares about its views beyond their files. */
export type ToolsServerOptions = {
  /** Declared by the artifact view alone, and only when set. */
  artifactStableOrigin?: ArtifactStableOrigin
  /** Where the artifact view's file reads are answered; by default, nowhere. */
  fileReads?: FileReadOptions
}

const SAFE_OUTPUT =
  "Never emit executable HTML, scripts, or browser-side code; Mermaid belongs only in fenced mermaid blocks."

// The first sentence fits 60 characters: a harness that defers MCP tools behind
// tool search, as Hermes does, lists each by its first sentence clipped there.
const PRESENT_ARTIFACT_DESCRIPTION =
  "Shows a file to the user; use it instead of a MEDIA: line. The file appears as an Artifact: a card in the conversation that previews it, and a row in the Session's Artifacts list where the user can open it full screen and download it. It previews documents, Markdown, code, PDFs, spreadsheets, Word documents, images and screenshots, HTML pages and slide decks, audio, and video. Use it whenever a file you created, changed, or found is part of your answer, as its output, subject, or source, rather than a MEDIA: line, a Markdown image, or a bare path. Call it again after each change to the file: one path is one Artifact, so each call refreshes the same card and row in place instead of adding another. Keep the title the same on every call or omit it, and never copy or rename a file to mark a version. Do not use it for files you only read or checked along the way. It returns the file's display name and an id, never its contents, so it cannot be used to read a file."

const MIME_TYPE =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u

// oxlint-disable-next-line no-control-regex -- the rule rejects control characters
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
    .describe(
      "Absolute path to a file inside the project workspace, e.g. /home/user/reports/q3/index.html. Use the same path on every call for one file."
    ),
  title: z
    .string()
    .min(1)
    .max(160)
    .optional()
    .describe(
      "Optional display name, when the file's own name would not tell the user what it is, e.g. 'Q3 report' for q3/index.html. Keep it the same on every call for one path; the file's extension is added when it is missing."
    ),
  mimeType: z
    .string()
    .max(255)
    .regex(MIME_TYPE)
    .optional()
    .describe(
      "Optional MIME type, only when the file's extension does not reveal its type, e.g. text/markdown for a file named NOTES."
    ),
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

const HEAD = "<head>"

/**
 * The view's HTML with the host it expects to run on as the first child of its
 * head, where the view reads it before it keeps anything in storage. A host
 * name and port need no escaping.
 */
function withExpectedHost(html: string, host: string) {
  if (!html.includes(HEAD))
    throw new Error("A view with a stable origin needs a <head> to name it in")
  return html.replace(
    HEAD,
    () => `${HEAD}<meta name="${ARTIFACT_VIEW_HOST_META}" content="${host}">`
  )
}

function registerView(
  server: McpServer,
  view: PresentationView,
  text: string,
  domain: string | undefined
) {
  const ui = {
    csp: view.csp,
    ...(view.permissions ? { permissions: view.permissions } : {}),
    ...(domain ? { domain } : {}),
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
          text,
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
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
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
 * Makes the stateless AOS UI tool server, one for each call of the function it
 * returns, from `files` and `options`. The artifact view's HTML names the host
 * it expects once, here, for every server made.
 */
export function toolsServerFactory(
  files: ToolsServerFiles,
  { artifactStableOrigin, fileReads = { origins: [] } }: ToolsServerOptions = {}
): () => McpServer {
  // One reader for every server made, so its bound on reads holds across them.
  const readFile = fileReader(fileReads)
  if (artifactStableOrigin === undefined)
    return () => createToolsServer(files, undefined, readFile)
  const { domain, host } = artifactStableOrigin
  const views = {
    ...files.views,
    artifact: withExpectedHost(files.views.artifact, host),
  }
  return () => createToolsServer({ ...files, views }, domain, readFile)
}

/**
 * The stateless AOS UI tool server. The SDK parses every call against the
 * tool's Zod schema, refinements included, and reports a failed parse as a
 * tool error, so handlers only ever see validated input. Each tool declares
 * the MCP App view that draws it, and the server serves that view's HTML as a
 * `ui://aos-ui/<view>` resource, the artifact view's declaring
 * `artifactDomain`, when it has one. `present_artifact` opens no file: its
 * view reads the file at the address the page hands it, which the server
 * answers with `readFile` alone.
 */
function createToolsServer(
  {
    views,
    pdfjs = new Map(),
    grammars = new Map(),
    maplibre = new Map(),
    office = new Map(),
  }: ToolsServerFiles,
  artifactDomain: string | undefined,
  readFile: FileReader
): McpServer {
  const server = new McpServer({ name: "aos-ui", version: "0.0.1" })

  for (const view of Object.values(presentationViews))
    registerView(
      server,
      view,
      views[view.name],
      view.name === "artifact" ? artifactDomain : undefined
    )
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
  registerFiles(
    server,
    "MapLibre file",
    MAPLIBRE_RESOURCE_URI,
    maplibre,
    () => "text/javascript"
  )
  registerFiles(
    server,
    "Office script",
    OFFICE_RESOURCE_URI,
    office,
    () => "text/javascript"
  )
  // Last, so it sees only the URIs no resource above answers.
  registerFileReads(server, readFile)

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
        // One file has one id however it is shown: the gateway gives a file
        // it delivers by path the same one.
        fileId: artifactFileId(path),
        ...(mimeType ? { mimeType } : {}),
      }
      return presentationResult("present_artifact", file.filename, file)
    }
  )

  return server
}
