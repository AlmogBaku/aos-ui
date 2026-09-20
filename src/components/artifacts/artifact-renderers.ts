export type ArtifactPreviewKind =
  | "markdown"
  | "text"
  | "code"
  | "json"
  | "csv"
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "html"
  | "unsupported"

export type ArtifactMediaKind = Extract<
  ArtifactPreviewKind,
  "audio" | "video" | "image"
>

export type CsvPreview = {
  rows: string[][]
  truncated: boolean
}

export const MAX_CSV_PREVIEW_ROWS = 500

const CODE_MIME_TYPES = new Set([
  "application/javascript",
  "application/typescript",
  "application/x-javascript",
  "application/x-typescript",
  "text/css",
  "text/javascript",
  "text/jsx",
  "text/typescript",
  "text/tsx",
  "text/x-python",
  "text/x-rust",
  "text/x-shellscript",
])

export function classifyArtifactPreview(
  mimeType: string | undefined,
  filename: string
): ArtifactPreviewKind {
  const mime = mimeType?.split(";", 1)[0]?.trim().toLowerCase()

  if (mime === "text/markdown") return "markdown"
  if (mime === "application/json") return "json"
  if (mime === "text/csv") return "csv"
  if (mime === "text/html") return "html"
  if (mime && CODE_MIME_TYPES.has(mime)) return "code"
  if (mime?.startsWith("text/")) return "text"
  if (mime?.startsWith("image/")) return "image"
  if (mime === "application/pdf") return "pdf"
  if (mime?.startsWith("audio/")) return "audio"
  if (mime?.startsWith("video/")) return "video"

  const extension = filename.toLowerCase().split(".").at(-1)
  if (extension === "md" || extension === "markdown") return "markdown"
  if (extension === "json") return "json"
  if (extension === "csv") return "csv"
  if (extension === "html" || extension === "htm") return "html"
  if (
    extension &&
    ["css", "js", "jsx", "ts", "tsx", "py", "rs", "sh", "yaml", "yml"].includes(
      extension
    )
  ) {
    return "code"
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension ?? "")) {
    return "image"
  }
  if (extension === "pdf") return "pdf"
  if (["mp3", "wav", "ogg", "m4a"].includes(extension ?? "")) return "audio"
  if (["mp4", "webm", "mov"].includes(extension ?? "")) return "video"
  return "unsupported"
}

/**
 * Audio, video, and images are the artifact kinds the conversation shows
 * inline, so callers ask for the media kind instead of re-deriving it from the
 * media type.
 */
export function artifactMediaKind(
  mimeType: string | undefined,
  filename: string
): ArtifactMediaKind | null {
  const kind = classifyArtifactPreview(mimeType, filename)
  return kind === "audio" || kind === "video" || kind === "image" ? kind : null
}

export function parseCsvPreview(
  input: string,
  maxRows = MAX_CSV_PREVIEW_ROWS
): CsvPreview {
  if (input.length === 0 || maxRows <= 0) {
    return { rows: [], truncated: input.length > 0 }
  }

  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  let index = 0

  const finishRow = () => {
    row.push(field)
    rows.push(row)
    row = []
    field = ""
  }

  while (index < input.length) {
    const character = input[index]!

    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"'
        index += 2
        continue
      }
      if (character === '"') {
        quoted = false
        index += 1
        continue
      }
      field += character
      index += 1
      continue
    }

    if (character === '"' && field.length === 0) {
      quoted = true
    } else if (character === ",") {
      row.push(field)
      field = ""
    } else if (character === "\n" || character === "\r") {
      finishRow()
      if (character === "\r" && input[index + 1] === "\n") index += 1
      if (rows.length > maxRows) {
        return { rows: rows.slice(0, maxRows), truncated: true }
      }
    } else {
      field += character
    }
    index += 1
  }

  if (field.length > 0 || row.length > 0) finishRow()
  return {
    rows: rows.slice(0, maxRows),
    truncated: rows.length > maxRows,
  }
}
