import { ErrorResponseSchema } from "../../protocol"

export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "revision_conflict"
  | "turn_conflict"
  | "turn_capacity_exceeded"
  | "registration_limit_exceeded"
  | "runtime_authentication_required"
  | "temporarily_unavailable"
  | "connection_interrupted"
  | "uncertain_mutation"
  | "internal_error"

const errorDescriptions: Record<ErrorCode, string> = {
  unauthenticated: "Sign in to AOS to continue.",
  forbidden: "You do not have permission to do that.",
  invalid_request: "The request could not be processed.",
  not_found: "The requested item was not found.",
  revision_conflict: "This item changed. Refresh and try again.",
  turn_conflict: "A turn is already active for this session.",
  turn_capacity_exceeded: "AOS is at capacity. Please try again shortly.",
  registration_limit_exceeded:
    "This account already has the maximum number of devices registered for notifications. Remove one to add another.",
  runtime_authentication_required:
    "The configured runtime credentials were rejected. Check the gateway configuration.",
  temporarily_unavailable:
    "The service is temporarily unavailable. Please try again.",
  connection_interrupted:
    "The connection was interrupted. AOS will reconcile before continuing.",
  uncertain_mutation:
    "The runtime may have accepted the request. Refresh to reconcile before trying again.",
  internal_error: "Something went wrong. Please try again.",
}

export function errorResponse(code: ErrorCode, status: number) {
  return new Response(
    JSON.stringify(
      ErrorResponseSchema.parse({
        error: { code, description: errorDescriptions[code] },
      })
    ),
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
