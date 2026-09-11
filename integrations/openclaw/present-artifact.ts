import { lstat, realpath, stat } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve, sep } from "node:path"

import { textResult } from "./tool-contract.js"
import { objectValue, optionalText, requiredText } from "./tool-contract.js"

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
const SENSITIVE_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  "credentials",
  "secrets",
  "mcp-tokens",
])

const MIME_TYPES: Record<string, string> = {
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
  ".zip": "application/zip",
}

function extension(path: string) {
  const index = path.lastIndexOf(".")
  return index < 0 ? "" : path.slice(index).toLowerCase()
}

function assertSafeRelativePath(path: string) {
  if (isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path))
    throw new Error("Artifact path must be relative to the Agent workspace")
  const segments = path.split(/[\\/]+/)
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.toLowerCase().startsWith(".env") ||
        SENSITIVE_SEGMENTS.has(segment.toLowerCase()) ||
        /^(auth|credentials|secrets)\.(json|ya?ml|toml)$/i.test(segment)
    )
  )
    throw new Error("Artifact path is unsafe or sensitive")
  return segments
}

async function assertNoSymbolicLinks(workspace: string, segments: string[]) {
  let current = workspace
  for (const segment of segments) {
    current = resolve(current, segment)
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink())
      throw new Error("Artifact path must not contain a symbolic link")
  }
}

export async function presentArtifact(workspace: string, input: unknown) {
  if (!isAbsolute(workspace))
    throw new Error("OpenClaw did not provide an absolute Agent workspace")
  const workspaceMetadata = await stat(workspace)
  if (!workspaceMetadata.isDirectory())
    throw new Error("OpenClaw Agent workspace is unavailable")

  const value = objectValue(input)
  const requestedPath = requiredText(value.path, "Artifact path", 4_096)
  const segments = assertSafeRelativePath(requestedPath)
  const absolutePath = resolve(workspace, ...segments)
  const relativePath = relative(workspace, absolutePath)
  if (
    !relativePath ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  )
    throw new Error("Artifact path escapes the Agent workspace")

  await assertNoSymbolicLinks(workspace, segments)
  const resolvedWorkspace = await realpath(workspace)
  const resolvedFile = await realpath(absolutePath)
  const canonicalRelative = relative(resolvedWorkspace, resolvedFile)
  if (
    !canonicalRelative ||
    canonicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(canonicalRelative)
  )
    throw new Error("Artifact path escapes the Agent workspace")

  const metadata = await stat(resolvedFile)
  if (!metadata.isFile()) throw new Error("Artifact must be a regular file")
  if (metadata.size > MAX_ARTIFACT_BYTES)
    throw new Error("Artifact exceeds the 25 MiB publication limit")

  const requestedMime = optionalText(value.mimeType, "MIME type", 255)
  if (requestedMime && !/^[\w.+-]+\/[\w.+-]+$/.test(requestedMime))
    throw new Error("Artifact MIME type is invalid")
  const filename =
    optionalText(value.title, "Artifact title", 160) ?? basename(relativePath)
  const mimeType =
    requestedMime ??
    MIME_TYPES[extension(relativePath)] ??
    "application/octet-stream"
  const candidate = {
    path: relativePath.split(sep).join("/"),
    filename,
    sizeBytes: metadata.size,
    mimeType,
  }
  return textResult(
    `Validated ${candidate.filename} at ${candidate.path} (${candidate.sizeBytes} bytes, ${candidate.mimeType}), but it was not published: this OpenClaw SDK has no native plugin artifact-registration API.`,
    {
      ok: true,
      type: "aos.artifact-publication",
      status: "unsupported",
      published: false,
      candidate,
    }
  )
}
