import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path"
import { randomUUID } from "node:crypto"

import type { ToolResult } from "@opencode-ai/plugin"

export const ARTIFACT_SIZE_LIMIT_BYTES = 25 * 1024 * 1024

export type PresentArtifactInput = {
  path: string
  title?: string
  mimeType?: string
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
}
const MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/
const SENSITIVE_FILE_NAMES = new Set([
  "auth.json",
  "auth.lock",
  "credentials",
  "config.yaml",
  ".anthropic_oauth.json",
  "google_token.json",
  "google_oauth_pending.json",
  "google_oauth.json",
  "webhook_subscriptions.json",
  "bws_cache.json",
  "bws_cache.enc.json",
  ".git-credentials",
])
const SENSITIVE_DIRECTORY_NAMES = new Set([
  ".git",
  ".ssh",
  "mcp-tokens",
  "pairing",
])

function isSensitivePath(pathFromRoot: string) {
  const parts = pathFromRoot.split(sep).map((part) => part.toLowerCase())
  const filename = parts.at(-1) ?? ""
  return (
    filename === ".env" ||
    filename.startsWith(".env.") ||
    filename === ".envrc" ||
    SENSITIVE_FILE_NAMES.has(filename) ||
    parts.some((part) => SENSITIVE_DIRECTORY_NAMES.has(part))
  )
}

function inferMimeType(path: string) {
  return (
    MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream"
  )
}

function assertWithinRoot(root: string, target: string) {
  const pathFromRoot = relative(root, target)
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("Artifact path must remain inside the configured worktree")
  }
}

async function assertNoSymlinkComponents(root: string, pathFromRoot: string) {
  let current = root
  for (const segment of pathFromRoot.split(sep)) {
    current = resolve(current, segment)
    let stats
    try {
      stats = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("Artifact file does not exist")
      throw error
    }
    if (stats.isSymbolicLink())
      throw new Error("Artifact path must not contain a symbolic link")
  }
}

export async function presentArtifact(
  configuredWorktree: string,
  input: PresentArtifactInput
): Promise<
  Exclude<ToolResult, string> & {
    attachments: NonNullable<Exclude<ToolResult, string>["attachments"]>
  }
> {
  const requestedPath = input.path.trim()
  if (!requestedPath) throw new Error("Artifact path is required")
  if (isAbsolute(requestedPath))
    throw new Error("Artifact path must be relative to the configured worktree")

  const root = await realpath(resolve(configuredWorktree))
  const target = resolve(root, requestedPath)
  assertWithinRoot(root, target)
  const pathFromRoot = relative(root, target)
  if (!pathFromRoot) throw new Error("Artifact path must name a regular file")
  if (isSensitivePath(pathFromRoot))
    throw new Error("Artifact path is sensitive and cannot be published")
  await assertNoSymlinkComponents(root, pathFromRoot)

  const canonicalTarget = await realpath(target)
  assertWithinRoot(root, canonicalTarget)

  const handle = await open(
    canonicalTarget,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  )
  try {
    const stats = await handle.stat()
    if (!stats.isFile())
      throw new Error("Artifact path must name a regular file")
    if (stats.size > ARTIFACT_SIZE_LIMIT_BYTES)
      throw new Error("Artifact exceeds the 25 MiB publication cap")

    const contents = await handle.readFile()
    if (contents.byteLength > ARTIFACT_SIZE_LIMIT_BYTES)
      throw new Error("Artifact exceeds the 25 MiB publication cap")

    const sourceFilename = basename(canonicalTarget)
    const filename = input.title?.trim() || sourceFilename
    if (!filename || filename.includes("/") || filename.includes("\\"))
      throw new Error("Artifact title must be a filename")
    const mimeType = input.mimeType?.trim() || inferMimeType(sourceFilename)
    if (!MIME_TYPE.test(mimeType))
      throw new Error("Artifact MIME type is invalid")
    const url = `data:${mimeType};base64,${contents.toString("base64")}`
    return {
      title: `Published ${filename}`,
      output: `Published ${filename} (${contents.byteLength} bytes).`,
      metadata: {
        aos_ui: {
          kind: "artifact",
          id: randomUUID(),
          filename,
          mimeType,
          sizeBytes: contents.byteLength,
        },
      },
      attachments: [{ type: "file", mime: mimeType, filename, url }],
    }
  } finally {
    await handle.close()
  }
}
