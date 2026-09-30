import { readFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"

import {
  PDFJS_WORKER_FILE,
  presentationViewNames,
} from "../../shared/presentation/views"
import {
  createToolsServer,
  type PdfjsFiles,
  type PresentationViewDocuments,
  type ToolsServerFiles,
} from "./server"

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

/** Reads the pdf.js files the build copied beside the views, once. */
async function loadPdfjs(directory: string): Promise<PdfjsFiles> {
  const root = path.join(directory, "pdfjs")
  const files = new Map<string, Uint8Array>()
  try {
    for await (const name of new Bun.Glob("**/*").scan({ cwd: root }))
      files.set(name, await readFile(path.join(root, name)))
  } catch {
    // A missing directory is reported below, as a missing worker.
  }
  if (!files.has(PDFJS_WORKER_FILE))
    throw new Error(
      `pdf.js is missing at ${root}; run \`bun run tools-mcp:build\` first.`
    )
  return files
}

/** One server and transport per request: the tools keep no state to share. */
async function handleMcp(
  files: ToolsServerFiles,
  request: Request
): Promise<Response> {
  const server = createToolsServer(files)
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

function serveHttp(files: ToolsServerFiles, hostname: string, port: number) {
  const server = Bun.serve({
    hostname,
    port,
    routes: {
      "/health": { GET: () => new Response("ok") },
      "/mcp": (request) => handleMcp(files, request),
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
  const directory = path.resolve(values.views)
  const files: ToolsServerFiles = await Promise.all([
    loadViews(directory),
    loadPdfjs(directory),
  ]).then(
    ([views, pdfjs]) => ({ views, pdfjs }),
    (error: Error) => {
      console.error(error.message)
      process.exit(1)
    }
  )
  if (values.stdio)
    await createToolsServer(files).connect(new StdioServerTransport())
  else serveHttp(files, values.host, port)
}
