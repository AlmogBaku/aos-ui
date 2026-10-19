import { HGW_API_PREFIX, isMcpAppPolicyOrigin } from "@harness-gw/sdk/protocol"
import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/server"

import { listedPublicOrigins } from "../../shared/lane-origins"
import {
  FILE_READ_LIMIT,
  refusalReason,
  type FileReadReason,
} from "../../shared/presentation/file-reads"

/**
 * The optional setting that maps a lane's origin to the base URL this server
 * reaches that lane at, for a lane whose own origin it cannot reach, such as a
 * loopback one from inside a container: `<lane origin>=<base URL>`, comma
 * separated, such as `http://localhost:3000=http://caddy:18080`.
 */
export const LANE_UPSTREAMS_SETTING = "AOS_UI_TOOLS_MCP_LANE_UPSTREAMS"

/** How long one file read may take, its body included. */
const FILE_READ_TIMEOUT_MS = 30_000

/** The `fetch` a read is made with. */
export type FetchFile = (address: URL, init: RequestInit) => Promise<Response>

/** What the server answers file reads with. */
export type FileReadOptions = {
  /** The lanes' public origins, the only ones a file address may name. */
  origins: readonly string[]
  /** The base URL a lane is reached at, by its origin, when not its own. */
  upstreams?: ReadonlyMap<string, string>
  limit?: number
  timeoutMs?: number
  fetch?: FetchFile
}

/** The gateway's file route below its API prefix, every id one segment. */
const FILE_ROUTE =
  /^\/agents\/[^/]+\/sessions\/[^/]+\/(?:tool-calls|artifacts)\/[^/]+\/app\/files\/[^/]+$/u

/**
 * The file address `uri` is, when it is one this server reads: an absolute
 * http(s) URL without credentials on one of `origins`, whose path is the
 * gateway's file route. Anything else is no file address, so no read reaches
 * any other host or path.
 */
export function fileAddress(
  uri: string,
  origins: readonly string[]
): URL | undefined {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return undefined
  }
  const { pathname } = url
  return (url.protocol === "https:" || url.protocol === "http:") &&
    url.username === "" &&
    url.password === "" &&
    origins.includes(url.origin) &&
    pathname.startsWith(`${HGW_API_PREFIX}/`) &&
    FILE_ROUTE.test(pathname.slice(HGW_API_PREFIX.length))
    ? url
    : undefined
}

/** `uri` without its query, which may carry a pass. */
function withoutQuery(uri: URL) {
  const named = new URL(uri.href)
  named.search = ""
  return named.href
}

/** Where an address points, without the query that carries its pass. */
const withoutPass = (url: URL) => `${url.origin}${url.pathname}`

/**
 * The whole body, or nothing once it proves larger than `limit`: by its
 * declared length before any byte is read, else by counting what arrives.
 */
async function readBody(response: Response, limit: number) {
  if (Number(response.headers.get("content-length")) > limit) {
    void response.body?.cancel().catch(() => undefined)
    return undefined
  }
  const chunks: Uint8Array[] = []
  let size = 0
  if (response.body)
    for (const reader = response.body.getReader(); ;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) {
        void reader.cancel().catch(() => undefined)
        return undefined
      }
      chunks.push(value)
    }
  return Buffer.concat(chunks, size)
}

/**
 * The file at `target`, read whole, up to `limit` bytes, with `fetchFile`,
 * keeping nothing, sending no credentials, and following no redirect, so a
 * read reaches only the address it was given; or why it was not.
 */
async function readFile(
  fetchFile: FetchFile,
  target: URL,
  init: RequestInit,
  limit: number
): Promise<{ blob: string; mimeType: string } | { reason: FileReadReason }> {
  try {
    const response = await fetchFile(target, {
      ...init,
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
    })
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      return { reason: refusalReason(response.status) }
    }
    const bytes = await readBody(response, limit)
    if (!bytes) return { reason: "tooLarge" }
    return {
      blob: bytes.toString("base64"),
      mimeType:
        response.headers.get("content-type") ?? "application/octet-stream",
    }
  } catch {
    return { reason: "unreachable" }
  }
}

/**
 * The lanes' upstreams from `LANE_UPSTREAMS_SETTING`, each lane origin and
 * base URL an exact origin. Throws naming the setting.
 */
function readUpstreams(value: string | undefined) {
  const upstreams = new Map<string, string>()
  for (const entry of (value ?? "").split(",")) {
    if (!entry.trim()) continue
    const [lane = "", upstream = "", ...rest] = entry
      .split("=")
      .map((part) => part.trim())
    if (
      rest.length > 0 ||
      !isMcpAppPolicyOrigin(lane) ||
      !isMcpAppPolicyOrigin(upstream)
    )
      throw new Error(
        `${LANE_UPSTREAMS_SETTING}: ${entry.trim()} is not <lane origin>=<base URL>, such as http://localhost:3000=http://caddy:18080`
      )
    upstreams.set(lane, upstream)
  }
  return upstreams
}

/**
 * What the server answers file reads with, from its settings: the origins
 * `AOS_UI_PUBLIC_ORIGIN` lists, none while it is unset, and the upstreams
 * `AOS_UI_TOOLS_MCP_LANE_UPSTREAMS` names; `note` says which. Throws naming a
 * setting it refuses.
 */
export function fileReadSettings(
  environment: Readonly<Record<string, string | undefined>>
): { options: FileReadOptions; note: string } {
  const origins = listedPublicOrigins((name) => environment[name])
  const upstreams = readUpstreams(environment[LANE_UPSTREAMS_SETTING])
  if (origins.length === 0)
    return {
      options: { origins, upstreams },
      note: "The artifact view's file reads are refused: AOS_UI_PUBLIC_ORIGIN is unset.",
    }
  const lanes = origins.map((origin) => {
    const upstream = upstreams.get(origin)
    return upstream ? `${origin} (at ${upstream})` : origin
  })
  return {
    options: { origins, upstreams },
    note: `The artifact view's file reads are answered at ${lanes.join(", ")}.`,
  }
}

/**
 * Answers `resources/read` of a file address (`fileAddress`) with the file the
 * address serves, as one base64 `blob` typed by the response, up to its limit.
 * It reads the address once, from a lane's upstream when one is named, under
 * the lane's own `Host`, so the lane routes and checks it as its own. A read
 * that fails is a JSON-RPC error whose `data.reason` names why
 * (`FileReadReason`); any other URI is not found. Registered after every other
 * resource, it sees only the URIs none of them answers. An address's query
 * carries its pass, so nothing here repeats or logs one.
 */
export function registerFileReads(
  server: McpServer,
  {
    origins,
    upstreams = new Map(),
    limit = FILE_READ_LIMIT,
    timeoutMs = FILE_READ_TIMEOUT_MS,
    fetch: fetchFile = fetch,
  }: FileReadOptions
) {
  server.registerResource(
    "aos-ui file",
    new ResourceTemplate("{+address}", { list: undefined }),
    {
      description:
        "A file the artifact view shows, read at the address its page hands it.",
    },
    async (uri) => {
      const address = fileAddress(uri.href, origins)
      if (!address) throw new ResourceNotFoundError(withoutQuery(uri))
      const upstream = upstreams.get(address.origin)
      const read = await readFile(
        fetchFile,
        upstream
          ? new URL(`${address.pathname}${address.search}`, upstream)
          : address,
        {
          signal: AbortSignal.timeout(timeoutMs),
          ...(upstream ? { headers: { host: address.host } } : {}),
        },
        limit
      )
      if ("reason" in read) {
        console.warn(
          `aos-ui: the file read at ${withoutPass(address)} failed: ${read.reason}`
        )
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `The file could not be read: ${read.reason}`,
          { reason: read.reason }
        )
      }
      return { contents: [{ uri: address.href, ...read }] }
    }
  )
}
