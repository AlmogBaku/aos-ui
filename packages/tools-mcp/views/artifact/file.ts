import { syntaxLanguageFromFilename } from "../../../../shared/syntax-language"
import { codeLanguage } from "./code"

/** How a text file lays out: as prose, a table, or highlighted source. */
export type TextFormat =
  | { format: "plain" | "markdown" | "csv" | "json" }
  | { format: "code"; language: string }

export type FilePreview =
  | { kind: "pdf"; blob: Blob }
  | { kind: "image"; url: string }
  | { kind: "html"; text: string }
  | ({ kind: "text"; text: string } & TextFormat)
  | { kind: "none" }

export type FileState =
  | { status: "loading" | "unreachable" | "tooLarge" }
  | { status: "ready"; preview: FilePreview }

type PreviewKind = Exclude<FilePreview["kind"], "none">

export type PreviewLimits = Record<PreviewKind, number>

const MIB = 1024 * 1024

/**
 * The largest file of each kind, in bytes, the view reads to preview; a larger
 * one is only offered. The view lays text out itself, so text gets the least.
 */
export const PREVIEW_LIMITS: PreviewLimits = {
  pdf: 64 * MIB,
  image: 64 * MIB,
  html: 25 * MIB,
  text: 2 * MIB,
}

const TEXT_EXTENSIONS = "log tsv txt"

/**
 * The type a file's extension names, for a file whose type was not declared;
 * source the view highlights is `text/x-<language>`, as its name names it.
 */
const EXTENSION_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  htm: "text/html",
  html: "text/html",
  avif: "image/avif",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  markdown: "text/markdown",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  ...Object.fromEntries(
    TEXT_EXTENSIONS.split(" ").map((extension) => [extension, "text/plain"])
  ),
}

const TEXT_TYPE =
  /^text\/|^application\/(?:json|xml|javascript|typescript|x-javascript|x-typescript|yaml|x-yaml|toml)$|\+(?:json|xml)$/u

/** A media type without its parameters, such as `; charset=utf-8`. */
function mediaType(value: string | null | undefined) {
  return value?.split(";")[0]?.trim().toLowerCase() || undefined
}

function extensionType(filename: string) {
  const extension = /\.([^./]+)$/u.exec(filename)?.[1]?.toLowerCase()
  const type = extension === undefined ? undefined : EXTENSION_TYPES[extension]
  const language = codeLanguage(syntaxLanguageFromFilename(filename))
  return type ?? (language === undefined ? undefined : `text/x-${language}`)
}

function kindOf(type: string | undefined): PreviewKind | undefined {
  if (type === "application/pdf") return "pdf"
  if (type === "text/html" || type === "application/xhtml+xml") return "html"
  if (type?.startsWith("image/")) return "image"
  if (type !== undefined && TEXT_TYPE.test(type)) return "text"
  return undefined
}

function textFormat(type: string): TextFormat {
  if (type === "text/markdown") return { format: "markdown" }
  if (type === "text/csv") return { format: "csv" }
  if (type === "application/json") return { format: "json" }
  // A source type names its language, as `text/x-python` and
  // `application/typescript` do.
  const language = codeLanguage(type.split("/")[1]?.replace(/^x-/u, ""))
  return language ? { format: "code", language } : { format: "plain" }
}

/**
 * A text type the view shows only as plain text, other than `text/plain`
 * itself, such as the `text/vnd.trolltech.linguist` a system names `.ts` by.
 */
function vague(type: string) {
  return (
    type !== "text/plain" &&
    kindOf(type) === "text" &&
    textFormat(type).format === "plain"
  )
}

function discard(body: ReadableStream | null) {
  void body?.cancel().catch(() => undefined)
}

/**
 * The whole body, or nothing once it proves larger than `limit`: by its
 * declared length before any byte is read, else by counting what arrives.
 */
async function readBody(response: Response, limit: number) {
  if (Number(response.headers.get("content-length")) > limit) {
    discard(response.body)
    return undefined
  }
  const chunks: Uint8Array<ArrayBuffer>[] = []
  if (!response.body) return chunks
  const reader = response.body.getReader()
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return chunks
    size += value.length
    if (size > limit) {
      void reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
}

function dataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function preview(
  kind: PreviewKind,
  type: string,
  blob: Blob
): Promise<FilePreview> {
  if (kind === "pdf") return { kind, blob }
  // The view's policy loads images only from `data:` addresses.
  if (kind === "image") return { kind, url: await dataUrl(blob) }
  const text = await blob.text()
  if (kind === "html") return { kind, text }
  return { kind, text, ...textFormat(type) }
}

/**
 * Fetches the file at `address` whole, up to its kind's limit, and prepares
 * its preview. The first type that is known decides how it shows: the one the
 * Agent declared, then the file name's, then the response's; a vague declared
 * text type yields to the file name's. A file with no
 * preview is not read at all.
 */
export async function loadFile(
  address: string,
  file: { filename: string; mimeType?: string | undefined },
  limits: PreviewLimits,
  signal: AbortSignal
): Promise<FileState> {
  try {
    const response = await fetch(address, {
      cache: "no-store",
      credentials: "omit",
      signal,
    })
    if (!response.ok) {
      discard(response.body)
      return { status: "unreachable" }
    }
    const declared = mediaType(file.mimeType)
    const type =
      (declared !== undefined && !vague(declared) ? declared : undefined) ??
      extensionType(file.filename) ??
      declared ??
      mediaType(response.headers.get("content-type"))
    const kind = kindOf(type)
    if (type === undefined || kind === undefined) {
      discard(response.body)
      return { status: "ready", preview: { kind: "none" } }
    }
    const chunks = await readBody(response, limits[kind])
    if (!chunks) return { status: "tooLarge" }
    return {
      status: "ready",
      preview: await preview(kind, type, new Blob(chunks, { type })),
    }
  } catch {
    return { status: "unreachable" }
  }
}
