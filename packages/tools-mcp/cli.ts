import { readFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"

import {
  MAPLIBRE_WORKER_FILE,
  PDFJS_WORKER_FILE,
  presentationViewNames,
} from "../../shared/presentation/views"
import {
  createToolsServer,
  type PresentationViewDocuments,
  type ToolsServerFiles,
  type ToolsServerOptions,
  type ViewFiles,
} from "./server"
import { artifactStableOrigin } from "./stable-origin"

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

/**
 * Reads the files the build wrote into `folder` beside the views, once; a
 * folder without its `required` file stops the server at start.
 */
async function loadFolder(
  directory: string,
  folder: string,
  required: string
): Promise<ViewFiles> {
  const root = path.join(directory, folder)
  const files = new Map<string, Uint8Array>()
  try {
    for await (const name of new Bun.Glob("**/*").scan({ cwd: root }))
      files.set(name, await readFile(path.join(root, name)))
  } catch {
    // A missing directory is reported below, as a missing file.
  }
  if (!files.has(required))
    throw new Error(
      `${required} is missing at ${root}; run \`bun run tools-mcp:build\` first.`
    )
  return files
}

/** One server and transport per request: the tools keep no state to share. */
async function handleMcp(
  files: ToolsServerFiles,
  options: ToolsServerOptions,
  request: Request
): Promise<Response> {
  const server = createToolsServer(files, options)
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
  files: ToolsServerFiles,
  options: ToolsServerOptions,
  hostname: string,
  port: number
) {
  const server = Bun.serve({
    hostname,
    port,
    routes: {
      "/health": { GET: () => new Response("ok") },
      "/mcp": (request) => handleMcp(files, options, request),
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
  let options: ToolsServerOptions
  try {
    const { origin, note } = artifactStableOrigin(
      process.env,
      values.stdio === true
    )
    options = { artifactStableOrigin: origin }
    // On stderr, since stdout carries the protocol under --stdio.
    console.warn(note)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
  const directory = path.resolve(values.views)
  const files: ToolsServerFiles = await Promise.all([
    loadViews(directory),
    loadFolder(directory, "pdfjs", PDFJS_WORKER_FILE),
    loadFolder(directory, "grammars", "typescript.json"),
    loadFolder(directory, "maplibre", MAPLIBRE_WORKER_FILE),
  ]).then(
    ([views, pdfjs, grammars, maplibre]) => ({
      views,
      pdfjs,
      grammars,
      maplibre,
    }),
    (error: Error) => {
      console.error(error.message)
      process.exit(1)
    }
  )
  if (values.stdio)
    await createToolsServer(files, options).connect(new StdioServerTransport())
  else serveHttp(files, options, values.host, port)
}
