import { posix } from "node:path"

import { isAosUiServerName } from "./aos-tool-names"
import { sensitiveName } from "./artifact-path"
import type { ServerMcpApps, SessionScope } from "./runtime"

/**
 * The folder rules for the files an MCP App reads through the file route.
 * Core knows no roles: the route passes every folder set its role must pass,
 * and a read passes only when all of them allow it.
 */

/** One role's folders; `allow` and `deny` hold absolute paths. */
export type AppFolderSet = {
  /** Whether the Agent's own folder is served. */
  agentFolder: boolean
  allow: readonly string[]
  deny: readonly string[]
}

export type AppFileVerdict =
  | { ok: true; path: string }
  | { ok: false; reason: "denied" | "real_path_unknown" | "real_path_denied" }

/** Components no folder set can serve, compared in lower case. */
const DENIED_COMPONENTS: ReadonlySet<string> = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".git",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".pgpass",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ecdsa_sk",
  "id_ed25519",
  "id_ed25519_sk",
])
/** Folders under `.config` that hold a CLI's credentials. */
const DENIED_CONFIG_FOLDERS: ReadonlySet<string> = new Set(["gcloud", "gh"])
const DENIED_SUFFIXES = [".pem", ".key", ".p12", ".pfx"]

/** Whether a path names credentials, whatever any folder set says. */
function builtInDenied(path: string) {
  const components = path.toLowerCase().split(/[\\/]/u)
  return components.some(
    (component, index) =>
      DENIED_COMPONENTS.has(component) ||
      sensitiveName(component) ||
      DENIED_SUFFIXES.some((suffix) => component.endsWith(suffix)) ||
      (component === ".config" &&
        DENIED_CONFIG_FOLDERS.has(components[index + 1] ?? ""))
  )
}

/** Whether `path`, absolute and normalized, is `folder` or lies under it. */
function inside(folder: string, path: string) {
  const base = posix.normalize(folder).replace(/(?<=.)\/+$/u, "")
  return path === base || path.startsWith(base === "/" ? "/" : `${base}/`)
}

/** Whether every set allows `path`; a denial holds in any letter case. */
function allowed(
  sets: readonly AppFolderSet[],
  agentFolder: string | undefined,
  path: string
) {
  const lowered = path.toLowerCase()
  return (
    !builtInDenied(path) &&
    sets.every(
      (set) =>
        !set.deny.some((folder) => inside(folder.toLowerCase(), lowered)) &&
        ((set.agentFolder &&
          agentFolder !== undefined &&
          inside(agentFolder, path)) ||
          set.allow.some((folder) => inside(folder, path)))
    )
  )
}

/** Whether a path is absolute and normalized, with no NUL. */
export function isServablePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.includes("\u0000") &&
    value
      .slice(1)
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  )
}

/** Whether every set has a folder to serve from, so `open` offers addresses. */
export function servesFiles(
  sets: readonly AppFolderSet[],
  agentFolder: string | undefined
) {
  return sets.every(
    (set) =>
      (set.agentFolder && agentFolder !== undefined) || set.allow.length > 0
  )
}

/**
 * The path to read for `written`, or why not. The rules judge the path as
 * written, then the real path the runtime reports it will read. A runtime
 * without `realPath` enforces its own roots, so only the written path is
 * judged. Nothing is cached: every request, byte ranges included, asks again.
 */
export async function readablePath(
  sets: readonly AppFolderSet[],
  agentFolder: string | undefined,
  written: string,
  realPath?: (path: string) => Promise<string | undefined>
): Promise<AppFileVerdict> {
  if (!allowed(sets, agentFolder, written))
    return { ok: false, reason: "denied" }
  if (!realPath) return { ok: true, path: written }
  const real = await realPath(written)
  if (!isServablePath(real)) return { ok: false, reason: "real_path_unknown" }
  return allowed(sets, agentFolder, real)
    ? { ok: true, path: real }
    : { ok: false, reason: "real_path_denied" }
}

/** A call's servable arguments: each top-level one that names a servable path. */
export function servableArguments(
  input: Readonly<Record<string, unknown>>
): ReadonlyMap<string, string> {
  return new Map(
    Object.entries(input).filter((entry): entry is [string, string] =>
      isServablePath(entry[1])
    )
  )
}

/** Whether `server` is one of `servers`; `aos-ui` also names a harness's `aos_ui`. */
export function serverAllowed(servers: readonly string[], server: string) {
  return servers.some(
    (name) =>
      name === server || (isAosUiServerName(name) && isAosUiServerName(server))
  )
}

/** A stored call as the file route reads it: its server and servable arguments. */
export type AppFileCall = {
  server: string
  servable: ReadonlyMap<string, string>
}

export type AppFileCalls = ReturnType<typeof createAppFileCalls>

/**
 * The stored calls the file route has looked up, keyed by Agent, Session, and
 * call, so a view's reads ask the runtime once. A stored call never changes;
 * a miss is asked again, and past `max` calls the oldest is forgotten.
 */
export function createAppFileCalls(max = 256) {
  const calls = new Map<string, AppFileCall>()
  return {
    async lookup(
      apps: ServerMcpApps | undefined,
      scope: SessionScope,
      toolCallId: string,
      signal?: AbortSignal
    ): Promise<AppFileCall | undefined> {
      const key = JSON.stringify([
        scope.agentId,
        scope.providerSessionId,
        toolCallId,
      ])
      const known = calls.get(key)
      if (known) return known
      const call = await apps?.toolCall?.(scope, toolCallId, signal)
      if (!call) return undefined
      const found = {
        server: call.server,
        servable: servableArguments(call.input),
      }
      if (calls.size >= max) {
        const [oldest] = calls.keys()
        calls.delete(oldest)
      }
      calls.set(key, found)
      return found
    },
  }
}
