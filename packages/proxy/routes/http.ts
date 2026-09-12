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

export function storedSessionId(agentId: string, sessionId: string) {
  if (!validIdentifier(agentId) || sessionId.length > 1_024) return undefined
  const match = /^hermes:([^:]+):(.+)$/u.exec(sessionId)
  if (!match) return undefined
  try {
    const owner = decodeURIComponent(match[1])
    const storedId = decodeURIComponent(match[2])
    return owner === agentId && validIdentifier(storedId) ? storedId : undefined
  } catch {
    return undefined
  }
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
    if (!/^(?:0|[1-9]\d*)$/u.test(rawLength)) return undefined
    const contentLength = Number(rawLength)
    if (!Number.isSafeInteger(contentLength) || contentLength > maxBytes)
      return undefined
  }
  try {
    const text = await request.text()
    if (!text || new TextEncoder().encode(text).byteLength > maxBytes)
      return undefined
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
