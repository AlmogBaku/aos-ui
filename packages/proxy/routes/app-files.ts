import { posix } from "node:path"

import type { Logger } from "../../lifecycle"
import type { McpAppFiles, McpAppView } from "../../protocol/mcp-apps"
import type { FilePassScope, FilePassService } from "../auth/file-pass"
import type { McpAppsConfig } from "../config"
import {
  readablePath,
  serverAllowed,
  servesFiles,
  withheldArguments,
  type AppFileCall,
  type AppFileCalls,
  type AppFolderSet,
} from "../core/app-files"
import { coreFailure } from "../core/failures"
import type { ServerRuntime, SessionScope } from "../core/runtime"
import { encodedFilename } from "./http"

/**
 * The files an MCP App's tool call names, read by its view. `open` offers one
 * address per argument that names a file, all under one pass, and withholds
 * from the view every argument that starts with `/`. A read is judged on every
 * request: its pass, or the listener's own login without one, then the call,
 * then the folder rules. A bad pass or login answers 401; every other refusal
 * answers one empty 404 and logs only its reason.
 */

/** The file route's settings, and the services its passes and lookups use. */
export type AppFileOptions = ReturnType<typeof appFileSettings> & {
  passes: FilePassService
  calls: AppFileCalls
  logger: Logger
}

/** One listener's reach: its role, its API root, and the sets a read must pass. */
export type AppFileGrant = {
  options: AppFileOptions
  role: FilePassScope["role"]
  /** The listener's API root, such as `/api/aos/v1`. */
  root: string
  sets: readonly AppFolderSet[]
  /** Whether a read needs the runtime's real path, as a guest's does. */
  requiresRealPath: boolean
}

/** The tool call a request names, as its path carries it. */
export type AppCallTarget = {
  agentId: string
  sessionId: string
  toolCallId: string
}

/** A view's call as an MCP App route resolved it. */
export type AppFileContext = {
  runtime: ServerRuntime
  scope: SessionScope
  toolCallId: string
  request: Request
  /** Absent where the listener serves no files; paths are withheld all the same. */
  files?: AppFileGrant
  /** When the listener's own login ends, in Unix seconds; a pass ends by then. */
  notAfter?: number
}

type FolderSetConfig = NonNullable<McpAppsConfig["files"]>["operator"]

/**
 * The configured settings with their defaults filled: `aos-ui`'s calls, the
 * Agent folder for operators, nothing for guests, `aos-ui`'s artifact view
 * for published Artifacts, and each call's reads and renewals limited per
 * second apart from its view's own requests.
 */
export function appFileSettings(configured: McpAppsConfig["files"]) {
  const folders = (
    set: FolderSetConfig,
    agentFolder: boolean
  ): AppFolderSet => ({
    agentFolder: set?.agentFolder ?? agentFolder,
    allow: set?.allow ?? [],
    deny: set?.deny ?? [],
  })
  return {
    servers: configured?.servers ?? ["aos-ui"],
    operator: folders(configured?.operator, true),
    guest: folders(configured?.guest, false),
    viewer: configured?.viewer ?? {
      server: "aos-ui",
      resource: "ui://aos-ui/artifact",
    },
    ratePerSecond: 50,
  }
}

/** The policy every answer but a PDF's carries, so no file runs as a page. */
const SANDBOX = "default-src 'none'; frame-ancestors 'none'; sandbox"
/** One byte range, the only kind a runtime is asked for. */
const SINGLE_RANGE = /^bytes=(?:\d{1,16}-\d{0,16}|-\d{1,16})$/u
/** The only runtime headers a file answer passes on. */
const PASSED_HEADERS = ["content-length", "content-range", "accept-ranges"]
/** The types a file keeps as the runtime reported them: none of them runs. */
const KEPT_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])
const CHARSET = /;\s*charset="?([\w.:-]{1,40})"?\s*(?:;|$)/iu

/** The type a file goes out as: kept, plain text, or bytes a browser only saves. */
function servedType(reported: string | null) {
  const type = (reported ?? "").split(";", 1)[0].trim().toLowerCase()
  if (KEPT_TYPES.has(type)) return type
  if (!type.startsWith("text/")) return "application/octet-stream"
  const charset = CHARSET.exec(reported ?? "")?.[1]
  return charset ? `text/plain; charset=${charset}` : "text/plain"
}

/** The Agent's folder, asked only when a set serves it. */
async function agentFolderOf(
  runtime: ServerRuntime,
  sets: readonly AppFolderSet[],
  agentId: string
) {
  return sets.some((set) => set.agentFolder)
    ? runtime.agentFolder(agentId)
    : undefined
}

/** Stops reading an answer whose body goes nowhere. */
function discard(response: Response) {
  response.body?.cancel().catch(() => undefined)
}

/**
 * The files `call` offers its view: one address per servable argument, under
 * one pass for the listener's role. Empty where the listener reads none.
 */
export async function appFiles(
  context: AppFileContext,
  grant: AppFileGrant,
  call: AppFileCall
): Promise<McpAppFiles> {
  const { runtime, scope, toolCallId } = context
  const reader = runtime.readFile
  if (
    call.servable.size === 0 ||
    !reader ||
    (grant.requiresRealPath && !reader.realPath) ||
    !serverAllowed(grant.options.servers, call.server) ||
    !servesFiles(
      grant.sets,
      await agentFolderOf(runtime, grant.sets, scope.agentId)
    )
  )
    return { addresses: {} }
  const { pass, expiresAt } = await grant.options.passes.issue(
    {
      role: grant.role,
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      toolCallId,
    },
    context.notAfter
  )
  const base = [
    grant.root,
    "agents",
    encodeURIComponent(scope.agentId),
    "sessions",
    encodeURIComponent(scope.sessionId),
    "tool-calls",
    encodeURIComponent(toolCallId),
    "app/files",
  ].join("/")
  return {
    addresses: Object.fromEntries(
      [...call.servable.keys()].map((name) => [
        name,
        `${base}/${encodeURIComponent(name)}?pass=${pass}`,
      ])
    ),
    expiresAt: new Date(expiresAt * 1_000).toISOString(),
  }
}

/**
 * `view` with every top-level argument that starts with `/` withheld from its
 * `toolInput`, as are the stored call's servable ones whatever the view's copy
 * holds, and `files` in their place. A view with none comes back as it was.
 */
export async function offerAppFiles(
  view: McpAppView,
  context: AppFileContext
): Promise<McpAppView> {
  const { runtime, scope, toolCallId, files } = context
  const call =
    files &&
    (await files.options.calls.lookup(
      runtime.mcpApps,
      scope,
      toolCallId,
      context.request.signal
    ))
  const withheld = new Set([
    ...withheldArguments(view.toolInput ?? {}),
    ...(call?.servable.keys() ?? []),
  ])
  if (withheld.size === 0) return view
  const { toolInput, ...rest } = view
  return {
    ...rest,
    ...(toolInput && {
      toolInput: Object.fromEntries(
        Object.entries(toolInput).filter(([name]) => !withheld.has(name))
      ),
    }),
    files:
      files && call ? await appFiles(context, files, call) : { addresses: {} },
  }
}

/**
 * One file request, whichever listener it reached. Only the runtime's 200,
 * 206, or 416 reaches the client, with only the headers `PASSED_HEADERS`
 * names and a type `servedType` narrows; its body streams, and stops with
 * the client.
 */
export async function answerAppFile(input: {
  request: Request
  runtime: ServerRuntime
  grant: AppFileGrant
  target: AppCallTarget
  argument: string
  allow: (target: AppCallTarget) => boolean
  /** Whether the listener's own login admits a request that sent no pass. */
  login: () => Promise<boolean>
  /** The Session the target names; one the runtime lacks throws as gone. */
  scope: () => Promise<SessionScope>
}): Promise<Response> {
  const { request, runtime, grant, target } = input
  const { logger, passes, calls, servers } = grant.options
  const pass = new URL(request.url).searchParams.get("pass")
  const headers = new Headers({ "content-security-policy": SANDBOX })
  // A view reads from an opaque origin, and only a pass may answer it.
  if (pass !== null) headers.set("access-control-allow-origin", "null")
  const empty = (status: number) => new Response(null, { status, headers })
  const refused = (reason: string) => {
    logger.info({ reason, ...target }, "app_file.refused")
    return empty(404)
  }
  const unavailable = (reason: string) => {
    logger.warn({ reason, ...target }, "app_file.unavailable")
    return empty(503)
  }
  const admitted =
    pass === null
      ? await input.login()
      : await passes.opens(pass, { role: grant.role, ...target })
  if (!admitted) return empty(401)
  if (!input.allow(target)) return empty(429)
  try {
    const scope = await input.scope()
    const reader = runtime.readFile
    if (!reader || (grant.requiresRealPath && !reader.realPath))
      return refused("no_reader")
    const call = await calls.lookup(
      runtime.mcpApps,
      scope,
      target.toolCallId,
      request.signal
    )
    if (!call) return refused("call_unknown")
    if (!serverAllowed(servers, call.server))
      return refused("server_not_allowed")
    const written = call.servable.get(input.argument)
    if (written === undefined) return refused("argument_not_servable")
    const verdict = await readablePath(
      grant.sets,
      await agentFolderOf(runtime, grant.sets, scope.agentId),
      written,
      reader.realPath &&
        ((path) => reader.realPath!(scope, path, request.signal))
    )
    if (!verdict.ok) return refused(verdict.reason)
    const range = request.headers.get("range")
    const upstream = await reader.read(scope, verdict.path, {
      ...(range !== null && SINGLE_RANGE.test(range) ? { range } : {}),
      signal: request.signal,
    })
    if (upstream.status === 403 || upstream.status === 404) {
      discard(upstream)
      return refused(upstream.status === 403 ? "runtime_refused" : "missing")
    }
    if (![200, 206, 416].includes(upstream.status)) {
      discard(upstream)
      return unavailable("runtime_status")
    }
    for (const name of PASSED_HEADERS) {
      const value = upstream.headers.get(name)
      if (value !== null) headers.set(name, value)
    }
    if (upstream.status === 416) {
      discard(upstream)
      // The length described the runtime's own body, which stays behind.
      headers.delete("content-length")
      return empty(416)
    }
    const type = servedType(upstream.headers.get("content-type"))
    headers.set("content-type", type)
    headers.set(
      "content-disposition",
      `inline; filename*=UTF-8''${encodedFilename(posix.basename(written))}`
    )
    // A browser shows no PDF under `sandbox`; the listener's policy holds.
    if (type === "application/pdf") headers.delete("content-security-policy")
    if (request.method === "HEAD") {
      discard(upstream)
      return new Response(null, { status: upstream.status, headers })
    }
    return new Response(upstream.body, { status: upstream.status, headers })
  } catch (error) {
    return (coreFailure(error) ?? runtime.publicError(error))?.kind === "gone"
      ? refused("gone")
      : unavailable("failed")
  }
}
