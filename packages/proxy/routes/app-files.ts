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
 *
 * A published Artifact opens in the configured viewer the same way, with one
 * address, `path`, for its own bytes. Those are read by id as the listener's
 * content route reads them, so no folder rule applies.
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

/** What a view opened on: one tool call, or one published Artifact. */
export type AppSubjectId = { toolCallId: string } | { artifactId: string }

/** The view a request names, as its path carries it. */
export type AppTarget = { agentId: string; sessionId: string } & AppSubjectId

/** A published Artifact as its listener read it by id. */
export type PublishedArtifact = Awaited<ReturnType<ServerRuntime["artifact"]>>

/**
 * A view's subject as a route resolved it. An Artifact comes with `read`, the
 * listener's own way to read it by id, which throws as gone for one the
 * Session lacks.
 */
export type AppSubject =
  | { toolCallId: string }
  | {
      artifactId: string
      read: (scope: SessionScope) => Promise<PublishedArtifact>
    }

/** The subject's id alone, as a pass and a log line name it. */
export function subjectId(subject: AppSubject): AppSubjectId {
  return "toolCallId" in subject
    ? { toolCallId: subject.toolCallId }
    : { artifactId: subject.artifactId }
}

/** The one address an Artifact's view gets: the name its viewer reads. */
export const ARTIFACT_FILE_ARGUMENT = "path"

/** A view's subject as an MCP App route resolved it. */
export type AppFileContext = {
  runtime: ServerRuntime
  scope: SessionScope
  subject: AppSubject
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
/**
 * Audio and video, which play but never run as code, keep their reported
 * subtype when it is a plain token.
 */
const MEDIA_TYPE = /^(?:audio|video)\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u
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
  if (KEPT_TYPES.has(type) || MEDIA_TYPE.test(type)) return type
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

/** One address per name under one pass for the subject, for the listener's role. */
async function addressed(
  context: AppFileContext,
  grant: AppFileGrant,
  names: readonly string[]
): Promise<McpAppFiles> {
  const { scope } = context
  const subject = subjectId(context.subject)
  const { pass, expiresAt } = await grant.options.passes.issue(
    {
      role: grant.role,
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      ...subject,
    },
    context.notAfter
  )
  const base = [
    grant.root,
    "agents",
    encodeURIComponent(scope.agentId),
    "sessions",
    encodeURIComponent(scope.sessionId),
    ...("toolCallId" in subject
      ? ["tool-calls", encodeURIComponent(subject.toolCallId)]
      : ["artifacts", encodeURIComponent(subject.artifactId)]),
    "app/files",
  ].join("/")
  return {
    addresses: Object.fromEntries(
      names.map((name) => [
        name,
        `${base}/${encodeURIComponent(name)}?pass=${pass}`,
      ])
    ),
    expiresAt: new Date(expiresAt * 1_000).toISOString(),
  }
}

/** The one address an Artifact's view reads its bytes from. */
export function artifactFiles(
  context: AppFileContext,
  grant: AppFileGrant
): Promise<McpAppFiles> {
  return addressed(context, grant, [ARTIFACT_FILE_ARGUMENT])
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
  const { runtime, scope } = context
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
  return addressed(context, grant, [...call.servable.keys()])
}

/**
 * `view` with every top-level argument that starts with `/` withheld from its
 * `toolInput`, as are the stored call's servable ones whatever the view's copy
 * holds, and `files` in their place. A view with none comes back as it was.
 */
export async function offerAppFiles(
  view: McpAppView,
  context: AppFileContext,
  toolCallId: string
): Promise<McpAppView> {
  const { runtime, scope, files } = context
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

/** Names a file answer's type and filename; a PDF drops the sandbox policy. */
function describedFile(
  headers: Headers,
  reported: string | null | undefined,
  filename: string
) {
  const type = servedType(reported ?? null)
  headers.set("content-type", type)
  headers.set(
    "content-disposition",
    `inline; filename*=UTF-8''${encodedFilename(filename)}`
  )
  // A browser shows no PDF under `sandbox`; the listener's policy holds.
  if (type === "application/pdf") headers.delete("content-security-policy")
}

/**
 * One file request, whichever listener it reached. For a tool call, only the
 * runtime's 200, 206, or 416 reaches the client, with only the headers
 * `PASSED_HEADERS` names and a type `servedType` narrows; its body streams,
 * and stops with the client. An Artifact answers its whole bytes, typed the
 * same way.
 */
export async function answerAppFile<Login>(input: {
  request: Request
  runtime: ServerRuntime
  grant: AppFileGrant
  target: { agentId: string; sessionId: string }
  /** The subject, read under the login that admitted a request with no pass. */
  subject: (login?: Login) => AppSubject
  argument: string
  allow: (target: AppTarget) => boolean
  /** The listener's own login for a request that sent no pass; none answers 401. */
  login: () => Promise<Login | undefined>
  /** The Session the target names; one the runtime lacks throws as gone. */
  scope: () => Promise<SessionScope>
}): Promise<Response> {
  const { request, runtime, grant } = input
  const target: AppTarget = { ...input.target, ...subjectId(input.subject()) }
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
  const login = pass === null ? await input.login() : undefined
  const admitted =
    pass === null
      ? login !== undefined
      : await passes.opens(pass, { role: grant.role, ...target })
  if (!admitted) return empty(401)
  const subject = input.subject(login)
  if (!input.allow(target)) return empty(429)
  try {
    const scope = await input.scope()
    if ("read" in subject) {
      if (input.argument !== ARTIFACT_FILE_ARGUMENT)
        return refused("argument_not_servable")
      const artifact = await subject.read(scope)
      headers.set("content-length", String(artifact.bytes.byteLength))
      describedFile(headers, artifact.mimeType, artifact.filename)
      return new Response(
        request.method === "HEAD" ? null : Buffer.from(artifact.bytes),
        { status: 200, headers }
      )
    }
    const reader = runtime.readFile
    if (!reader || (grant.requiresRealPath && !reader.realPath))
      return refused("no_reader")
    const call = await calls.lookup(
      runtime.mcpApps,
      scope,
      subject.toolCallId,
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
    describedFile(
      headers,
      upstream.headers.get("content-type"),
      posix.basename(written)
    )
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
