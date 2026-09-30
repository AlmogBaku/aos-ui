export type ArtifactMediaKind = "audio" | "video" | "image"

/**
 * Audio, video, and images are the artifact kinds the conversation shows
 * inline, so callers ask for the media kind instead of re-deriving it from the
 * media type.
 */
export function artifactMediaKind(
  mimeType: string | undefined,
  filename: string
): ArtifactMediaKind | null {
  const mime = mimeType?.split(";", 1)[0]?.trim().toLowerCase()
  if (mime?.startsWith("image/")) return "image"
  if (mime?.startsWith("audio/")) return "audio"
  if (mime?.startsWith("video/")) return "video"
  const ext = filename.toLowerCase().split(".").at(-1)
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext ?? ""))
    return "image"
  if (["mp3", "wav", "ogg", "m4a"].includes(ext ?? "")) return "audio"
  if (["mp4", "webm", "mov"].includes(ext ?? "")) return "video"
  return null
}
