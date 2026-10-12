import {
  Client,
  InMemoryTransport,
  type ReadResourceResult,
  type Tool,
} from "@modelcontextprotocol/client"

import {
  GRAMMAR_RESOURCE_URI,
  MAPLIBRE_RESOURCE_URI,
  MAPLIBRE_WORKER_FILE,
  PDFJS_RESOURCE_URI,
  PDFJS_WORKER_FILE,
} from "../../shared/presentation/views"
import { createToolsServer, type ToolsServerFiles } from "./server"

/** What an MCP client reads from the server: its tools and every view. */
export type ToolsServerSnapshot = {
  tools: Tool[]
  resources: Record<string, ReadResourceResult>
}

/**
 * The pdf.js resources the artifact view requests for the fixture PDF:
 * worker, Helvetica font substitute, and CCITT wasm decoder. Observed with a
 * logging BinaryDataFactory against report.pdf; no character maps needed.
 */
const FIXTURE_PDFJS_URIS = [
  `${PDFJS_RESOURCE_URI}${PDFJS_WORKER_FILE}`,
  `${PDFJS_RESOURCE_URI}standard_fonts/LiberationSans-Regular.ttf`,
  `${PDFJS_RESOURCE_URI}wasm/jbig2.wasm`,
]

/**
 * The grammars the fixture's files read: TypeScript for its source file and
 * Markdown `ts` fence, JSON for its data file, and HTML, with the CSS and
 * JavaScript it embeds, for its pages' source.
 */
const FIXTURE_GRAMMAR_URIS = [
  "typescript",
  "json",
  "html",
  "css",
  "javascript",
].map((name) => `${GRAMMAR_RESOURCE_URI}${name}.json`)

/** The worker every map view reads before it draws. */
const FIXTURE_MAPLIBRE_URIS = [
  `${MAPLIBRE_RESOURCE_URI}${MAPLIBRE_WORKER_FILE}`,
]

/**
 * Asks a real server for its `tools/list`, every view's `resources/read`, the
 * pdf.js resources and grammars the artifact view needs for the fixture
 * files, and the map view's worker.
 */
export async function snapshotToolsServer(
  files: ToolsServerFiles
): Promise<ToolsServerSnapshot> {
  const server = createToolsServer(files)
  const client = new Client({ name: "aos-ui-fixture", version: "1.0.0" })
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const { tools } = await client.listTools()
    const resources: Record<string, ReadResourceResult> = {}
    for (const { uri } of (await client.listResources()).resources)
      resources[uri] = await client.readResource({ uri })
    for (const uri of [
      ...FIXTURE_PDFJS_URIS,
      ...FIXTURE_GRAMMAR_URIS,
      ...FIXTURE_MAPLIBRE_URIS,
    ])
      resources[uri] = await client.readResource({ uri })
    return { tools, resources }
  } finally {
    await client.close()
    await server.close()
  }
}
