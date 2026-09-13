import { ErrorResponseSchema } from "../../protocol"

export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "revision_conflict"
  | "run_conflict"
  | "run_capacity_exceeded"
  | "runtime_authentication_required"
  | "temporarily_unavailable"
  | "internal_error"

export function errorResponse(code: ErrorCode, status: number) {
  return new Response(
    JSON.stringify(ErrorResponseSchema.parse({ error: { code } })),
    {
      status,
      headers: { "content-type": "application/json; charset=UTF-8" },
    }
  )
}

export function validIdentifier(value: string) {
  return (
    value.length >= 1 &&
    value.length <= 256 &&
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
  )
}

export function pageQuery(
  requestUrl: string,
  defaults: { limit: number; offset: number },
  maxLimit: number,
  maxWindow?: number
) {
  const url = new URL(requestUrl)
  if (url.search.length > 2_048) return undefined
  if (
    [...url.searchParams.keys()].some(
      (key) => key !== "limit" && key !== "offset"
    )
  )
    return undefined
  const limitValues = url.searchParams.getAll("limit")
  const offsetValues = url.searchParams.getAll("offset")
  if (limitValues.length > 1 || offsetValues.length > 1) return undefined
  const integer = (value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback
    if (!/^(?:0|[1-9]\d*)$/u.test(value)) return undefined
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  const limit = integer(limitValues[0], defaults.limit)
  const offset = integer(offsetValues[0], defaults.offset)
  if (
    limit === undefined ||
    offset === undefined ||
    limit < 1 ||
    limit > maxLimit ||
    offset < 0 ||
    (maxWindow !== undefined && offset + limit > maxWindow)
  )
    return undefined
  return { limit, offset }
}

export async function boundedJson(request: Request, maxBytes = 16 * 1024) {
  if (
    request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
  )
    return undefined
  const rawLength = request.headers.get("content-length")
  if (rawLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(rawLength)) {
      void request.body?.cancel().catch(() => undefined)
      return undefined
    }
    const contentLength = Number(rawLength)
    if (!Number.isSafeInteger(contentLength) || contentLength > maxBytes) {
      void request.body?.cancel().catch(() => undefined)
      return undefined
    }
  }
  if (!request.body) return undefined
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength > maxBytes - total) {
        await reader.cancel().catch(() => undefined)
        return undefined
      }
      chunks.push(value)
      total += value.byteLength
    }
    if (total === 0) return undefined
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    ) as unknown
  } catch {
    return undefined
  } finally {
    reader.releaseLock()
  }
}
