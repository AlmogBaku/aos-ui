import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type {
  ReadResourceResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js"

import { createToolsServer, type PresentationViewDocuments } from "./server"

/** What an MCP client reads from the server: its tools and every view. */
export type ToolsServerSnapshot = {
  tools: Tool[]
  resources: Record<string, ReadResourceResult>
}

/**
 * Asks a real server, over MCP, for its `tools/list` and the `resources/read`
 * of every view a tool declares, so the fixture preview draws the same views
 * the harnesses do through the same answers.
 */
export async function snapshotToolsServer(
  views: PresentationViewDocuments
): Promise<ToolsServerSnapshot> {
  const server = createToolsServer({ views })
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
    return { tools, resources }
  } finally {
    await client.close()
    await server.close()
  }
}
