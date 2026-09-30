export type FilePreview =
  | { kind: "pdf"; blob: Blob }
  | { kind: "image"; url: string }
  | { kind: "text" | "html"; text: string }
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

const TEXT_EXTENSIONS =
  "css csv js json jsx log markdown md py rs sh sql toml ts tsv tsx txt xml yaml yml"

/** The type a file's extension names, for a file whose type was not declared. */
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
  ...Object.fromEntries(
    TEXT_EXTENSIONS.split(" ").map((extension) => [extension, "text/plain"])
  ),
}

const TEXT_TYPE =
  /^text\/|^application\/(?:json|xml|javascript|typescript|yaml|x-yaml|toml)$|\+(?:json|xml)$/u

/** A media type without its parameters, such as `; charset=utf-8`. */
function mediaType(value: string | null | undefined) {
  return value?.split(";")[0]?.trim().toLowerCase() || undefined
}

function extensionType(filename: string) {
  const extension = /\.([^./]+)$/u.exec(filename)?.[1]?.toLowerCase()
  return extension === undefined ? undefined : EXTENSION_TYPES[extension]
}

function kindOf(type: string | undefined): PreviewKind | undefined {
  if (type === "application/pdf") return "pdf"
  if (type === "text/html" || type === "application/xhtml+xml") return "html"
  if (type?.startsWith("image/")) return "image"
  if (type !== undefined && TEXT_TYPE.test(type)) return "text"
  return undefined
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

async function preview(kind: PreviewKind, blob: Blob): Promise<FilePreview> {
  if (kind === "pdf") return { kind, blob }
  // The view's policy loads images only from `data:` addresses.
  if (kind === "image") return { kind, url: await dataUrl(blob) }
  return { kind, text: await blob.text() }
}

/**
 * Fetches the file at `address` whole, up to its kind's limit, and prepares
 * its preview. The first type that is known decides how it shows: the one the
 * Agent declared, then the file name's, then the response's. A file with no
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
    const type =
      mediaType(file.mimeType) ??
      extensionType(file.filename) ??
      mediaType(response.headers.get("content-type"))
    const kind = kindOf(type)
    if (kind === undefined) {
      discard(response.body)
      return { status: "ready", preview: { kind: "none" } }
    }
    const chunks = await readBody(response, limits[kind])
    if (!chunks) return { status: "tooLarge" }
    return {
      status: "ready",
      preview: await preview(kind, new Blob(chunks, { type })),
    }
  } catch {
    return { status: "unreachable" }
  }
}
