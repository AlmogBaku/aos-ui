import type {
  ArtifactAdapter,
  ArtifactDescriptor,
  ArtifactResolveOptions,
} from "../contracts"

type ArtifactDataPart = {
  type: "data"
  name: "aos.artifact"
  data: ArtifactDescriptor
}

type JsonRecord = Record<string, unknown>

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null
}

function receiptValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function safeReference(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\\"))
    return false
  if (value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return false
  return !value.split("/").includes("..")
}

/** Converts only the explicit native receipt; ordinary tool JSON stays untouched. */
export function projectHermesArtifactReceipt(
  raw: unknown
): ArtifactDataPart | undefined {
  const value = receiptValue(raw)
  if (!record(value) || value.ok !== true || value.type !== "aos.artifact")
    return undefined
  const artifact = value.artifact
  if (
    !record(artifact) ||
    typeof artifact.id !== "string" ||
    !artifact.id.trim() ||
    typeof artifact.filename !== "string" ||
    !artifact.filename.trim() ||
    !safeReference(artifact.path) ||
    (artifact.mimeType !== undefined &&
      (typeof artifact.mimeType !== "string" || !artifact.mimeType.trim())) ||
    (artifact.sizeBytes !== undefined &&
      (!Number.isSafeInteger(artifact.sizeBytes) ||
        (artifact.sizeBytes as number) < 0))
  )
    return undefined

  const descriptor: ArtifactDescriptor = {
    id: artifact.id,
    filename: artifact.filename,
    source: { type: "provider", reference: artifact.path },
    ...(typeof artifact.mimeType === "string"
      ? { mimeType: artifact.mimeType }
      : {}),
    ...(typeof artifact.sizeBytes === "number"
      ? { sizeBytes: artifact.sizeBytes }
      : {}),
  }
  return { type: "data", name: "aos.artifact", data: descriptor }
}

type HermesArtifactAdapterOptions = {
  baseUrl: string
  client: {
    session(threadId: string):
      | {
          threadId: string
          agentId: string
          profile: string
          storedSessionId: string
        }
      | undefined
  }
  fetcher?: typeof fetch
}

function absoluteUrl(baseUrl: string, path: string) {
  const base = baseUrl.replace(/\/$/u, "")
  if (/^https?:\/\//u.test(base)) return `${base}${path}`
  if (typeof window === "undefined") return `${base}${path}`
  return new URL(`${base}${path}`, window.location.origin).toString()
}

function dataUrlBlob(value: unknown): Blob {
  if (!record(value) || typeof value.dataUrl !== "string")
    throw new Error("Hermes returned an invalid artifact response")
  const marker = ";base64,"
  const markerIndex = value.dataUrl.indexOf(marker)
  if (!value.dataUrl.startsWith("data:") || markerIndex <= 5)
    throw new Error("Hermes returned an invalid artifact response")
  const mimeType = value.dataUrl.slice(5, markerIndex)
  const encoded = value.dataUrl.slice(markerIndex + marker.length)
  if (
    /[\r\n]/u.test(mimeType) ||
    encoded.length % 4 !== 0 ||
    (encoded.length > 0 && !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded))
  )
    throw new Error("Hermes returned an invalid artifact response")
  try {
    const binary = atob(encoded)
    return new Blob(
      [Uint8Array.from(binary, (character) => character.charCodeAt(0))],
      { type: mimeType }
    )
  } catch {
    throw new Error("Hermes returned an invalid artifact response")
  }
}

export class HermesArtifactAdapter implements ArtifactAdapter {
  readonly #baseUrl: string
  readonly #client: HermesArtifactAdapterOptions["client"]
  readonly #fetch: typeof fetch

  constructor({
    baseUrl,
    client,
    fetcher = globalThis.fetch.bind(globalThis),
  }: HermesArtifactAdapterOptions) {
    this.#baseUrl = baseUrl
    this.#client = client
    this.#fetch = fetcher
  }

  async resolve({
    artifact,
    agentId,
    threadId,
    signal,
  }: ArtifactResolveOptions): Promise<Blob> {
    signal.throwIfAborted()
    if (artifact.source.type !== "provider")
      throw new Error("Hermes can only resolve a provider artifact")
    if (!safeReference(artifact.source.reference))
      throw new Error("Hermes artifact reference is invalid")
    const session = this.#client.session(threadId)
    if (
      !session ||
      session.threadId !== threadId ||
      session.agentId !== agentId ||
      session.profile !== agentId
    )
      throw new Error(
        "Hermes artifact ownership does not match the selected Session"
      )

    const query = new URLSearchParams({
      path: artifact.source.reference,
      profile: session.profile,
      session_id: session.storedSessionId,
    })
    const request = async (route: "read-data-url" | "download") =>
      this.#fetch(absoluteUrl(this.#baseUrl, `/api/fs/${route}?${query}`), {
        credentials: "include",
        headers: {
          accept:
            route === "read-data-url"
              ? "application/json"
              : "application/octet-stream",
        },
        redirect: "error",
        signal,
      })

    const preview = await request("read-data-url")
    if (preview.ok) return dataUrlBlob(await preview.json())
    if (preview.status !== 413)
      throw new Error(`Hermes artifact read failed (${preview.status})`)

    const download = await request("download")
    if (!download.ok)
      throw new Error(`Hermes artifact download failed (${download.status})`)
    return download.blob()
  }
}
