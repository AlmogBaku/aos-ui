import {
  SessionAttachmentStageRequestSchema,
  SessionAttachmentStageResponseSchema,
  SessionAudioResponseSchema,
  SessionInteractionSnapshotResponseSchema,
  SessionSpeechRequestSchema,
  SessionTranscriptionRequestSchema,
  SessionTranscriptionResponseSchema,
} from "../../protocol"
import type { ProxyAppOptions } from "../app"
import type { HermesServerAdapter } from "../runtimes/hermes/adapter"
import { HermesAttachmentStageRegistry } from "../runtimes/hermes/stage-registry"
import { boundedJson, errorResponse, validIdentifier } from "./http"
import type { ProxyRouteApp } from "./types"

function recordingBytes(dataUrl: string, mimeType: string) {
  const prefix = `data:${mimeType};base64,`
  if (!dataUrl.startsWith(prefix)) return undefined
  const encoded = dataUrl.slice(prefix.length)
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
  )
    return undefined
  try {
    return Uint8Array.from(atob(encoded), (character) =>
      character.charCodeAt(0)
    )
  } catch {
    return undefined
  }
}

export function registerContentRoutes(
  app: ProxyRouteApp,
  options: ProxyAppOptions,
  attachmentStages: HermesAttachmentStageRegistry,
  requireRuntime: (request: Request) => Promise<HermesServerAdapter>,
  requireScopedSession: (
    hermes: HermesServerAdapter,
    agentId: string,
    sessionId: string
  ) => Promise<string>
) {
  const sessionContentPath = "/api/aos/v1/agents/:agentId/sessions/:sessionId"

  app.get(`${sessionContentPath}/interactions/pending`, async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    const runIds = new URL(context.req.url).searchParams.getAll("runId")
    if (
      runIds.length > 1 ||
      (runIds[0] !== undefined && !validIdentifier(runIds[0]))
    )
      return errorResponse("invalid_request", 400)
    const agentId = context.req.param("agentId")
    const sessionId = context.req.param("sessionId")
    await requireScopedSession(hermes, agentId, sessionId)
    return context.json(
      SessionInteractionSnapshotResponseSchema.parse(
        await hermes.pendingInteractions(agentId, sessionId, runIds[0])
      )
    )
  })

  app.post(`${sessionContentPath}/attachments/stage`, async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    if (context.req.header("origin") !== options.publicOrigin)
      return errorResponse("forbidden", 403)
    const body = SessionAttachmentStageRequestSchema.safeParse(
      await boundedJson(context.req.raw, 35_500_000)
    )
    if (!body.success) return errorResponse("invalid_request", 400)
    const agentId = context.req.param("agentId")
    const sessionId = context.req.param("sessionId")
    await requireScopedSession(hermes, agentId, sessionId)
    const stage = await hermes.stageAttachments(
      agentId,
      sessionId,
      body.data.attachments
    )
    const stageId = attachmentStages.create(agentId, sessionId, stage)
    if (!stageId) {
      await stage.cleanup().catch(() => undefined)
      return errorResponse("run_capacity_exceeded", 503)
    }
    return context.json(
      SessionAttachmentStageResponseSchema.parse({
        stageId,
        attachments: stage.public,
      }),
      201
    )
  })

  app.get(`${sessionContentPath}/artifacts/:artifactId`, async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    await requireScopedSession(
      hermes,
      context.req.param("agentId"),
      context.req.param("sessionId")
    )
    const artifact = await hermes.artifact(
      context.req.param("agentId"),
      context.req.param("sessionId"),
      context.req.param("artifactId")
    )
    return new Response(Uint8Array.from(artifact.bytes).buffer, {
      headers: {
        "content-type": artifact.mimeType ?? "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
      },
    })
  })

  app.get(`${sessionContentPath}/audio`, async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    await requireScopedSession(
      hermes,
      context.req.param("agentId"),
      context.req.param("sessionId")
    )
    return context.json(
      SessionAudioResponseSchema.parse(
        await hermes.audio(
          context.req.param("agentId"),
          context.req.param("sessionId")
        )
      )
    )
  })

  app.post(`${sessionContentPath}/audio/transcribe`, async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    if (context.req.header("origin") !== options.publicOrigin)
      return errorResponse("forbidden", 403)
    const body = SessionTranscriptionRequestSchema.safeParse(
      await boundedJson(context.req.raw, 7_500_000)
    )
    if (!body.success) return errorResponse("invalid_request", 400)
    const bytes = recordingBytes(body.data.dataUrl, body.data.mimeType)
    if (!bytes) return errorResponse("invalid_request", 400)
    await requireScopedSession(
      hermes,
      context.req.param("agentId"),
      context.req.param("sessionId")
    )
    return context.json(
      SessionTranscriptionResponseSchema.parse({
        transcript: await hermes.transcribe(
          context.req.param("agentId"),
          context.req.param("sessionId"),
          bytes,
          body.data.mimeType,
          context.req.raw.signal
        ),
      })
    )
  })

  app.post(`${sessionContentPath}/audio/speak`, async (context) => {
    const hermes = await requireRuntime(context.req.raw)
    if (context.req.header("origin") !== options.publicOrigin)
      return errorResponse("forbidden", 403)
    const body = SessionSpeechRequestSchema.safeParse(
      await boundedJson(context.req.raw, 40_000)
    )
    if (!body.success) return errorResponse("invalid_request", 400)
    await requireScopedSession(
      hermes,
      context.req.param("agentId"),
      context.req.param("sessionId")
    )
    const speech = await hermes.speak(
      context.req.param("agentId"),
      context.req.param("sessionId"),
      body.data.text,
      context.req.raw.signal
    )
    return new Response(Uint8Array.from(speech.bytes).buffer, {
      headers: { "content-type": speech.mimeType },
    })
  })
}
