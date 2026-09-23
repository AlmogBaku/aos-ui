import { readFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"

import { presentationViewNames } from "../../shared/presentation/views"
import { createToolsServer, type PresentationViewDocuments } from "./server"

const USAGE =
  "Usage: cli.ts --stdio | --http [--host 127.0.0.1] [--port 4110] [--views <dir>]"

/** `bun run tools-mcp:build` writes the views here. */
const DEFAULT_VIEWS_DIRECTORY = path.resolve(import.meta.dirname, "dist/views")

/** Reads every built view once; a missing one stops the server at start. */
async function loadViews(
  directory: string
): Promise<PresentationViewDocuments> {
  const views = {} as PresentationViewDocuments
  for (const name of presentationViewNames) {
    const file = path.join(directory, `${name}.html`)
    try {
      views[name] = await readFile(file, "utf8")
    } catch {
      throw new Error(
        `The ${name} view is missing at ${file}; run \`bun run tools-mcp:build\` first.`
      )
    }
  }
  return views
}

/** One server and transport per request: the tools keep no state to share. */
async function handleMcp(
  views: PresentationViewDocuments,
  request: Request
): Promise<Response> {
  const server = createToolsServer({ views })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    await server.close()
  }
}

function serveHttp(
  views: PresentationViewDocuments,
  hostname: string,
  port: number
) {
  const server = Bun.serve({
    hostname,
    port,
    routes: {
      "/health": { GET: () => new Response("ok") },
      "/mcp": (request) => handleMcp(views, request),
    },
    fetch: () => new Response("Not found", { status: 404 }),
  })
  console.info(`aos-ui tools MCP listening on ${server.url.origin}/mcp`)
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      stdio: { type: "boolean" },
      http: { type: "boolean" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "4110" },
      views: { type: "string", default: DEFAULT_VIEWS_DIRECTORY },
    },
  })
  const port = Number(values.port)

  if (values.stdio === values.http || !Number.isInteger(port)) {
    console.error(USAGE)
    process.exit(2)
  }
  const views = await loadViews(path.resolve(values.views)).catch(
    (error: Error) => {
      console.error(error.message)
      process.exit(1)
    }
  )
  if (values.stdio)
    await createToolsServer({ views }).connect(new StdioServerTransport())
  else serveHttp(views, values.host, port)
}
