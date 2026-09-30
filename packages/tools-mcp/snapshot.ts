import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type {
  ReadResourceResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js"

import {
  PDFJS_RESOURCE_URI,
  PDFJS_WORKER_FILE,
} from "../../shared/presentation/views"
import {
  createToolsServer,
  type PdfjsFiles,
  type PresentationViewDocuments,
} from "./server"

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
 * Asks a real server for its `tools/list`, every view's `resources/read`, and
 * the pdf.js resources the artifact view needs for the fixture files.
 */
export async function snapshotToolsServer(
  views: PresentationViewDocuments,
  pdfjs: PdfjsFiles
): Promise<ToolsServerSnapshot> {
  const server = createToolsServer({ views, pdfjs })
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
    for (const uri of FIXTURE_PDFJS_URIS)
      resources[uri] = await client.readResource({ uri })
    return { tools, resources }
  } finally {
    await client.close()
    await server.close()
  }
}
