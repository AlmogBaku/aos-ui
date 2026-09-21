import type { Hono } from "hono"

import {
  SessionAttachmentStageRequestSchema,
  SessionAttachmentStageResponseSchema,
  SessionSpeechRequestSchema,
  SessionTranscriptionRequestSchema,
  SessionTranscriptionResponseSchema,
} from "../../../protocol"
import { projectGuestOutbound } from "../../auth/guest-projection"
import { recordingBytes } from "../../routes/content"
import { boundedJson } from "../../routes/http"
import {
  emptyError,
  encodedFilename,
  invitationError,
  type GuestRoutes,
} from "../context"

export function registerGuestContentRoutes(app: Hono, routes: GuestRoutes) {
  app.post(
    "/api/guest/v1/agents/:agentId/sessions/:sessionId/attachments/stage",
    async (context) => {
      if (context.req.header("origin") !== routes.options.publicOrigin)
        return emptyError(403)
      const identity = await routes.authenticate(context.req.raw)
      if (!identity) return invitationError()
      const agentId = context.req.param("agentId")
      const ref = context.req.param("sessionId")
      const authorization = routes.authorize(
        identity,
        agentId,
        ref,
        "messages:create"
      )
      if (!authorization) return emptyError(401)
      const body = SessionAttachmentStageRequestSchema.safeParse(
        await boundedJson(context.req.raw, 35_500_000)
      )
      if (!body.success) return emptyError(400)
      try {
        const publicAttachments = body.data.attachments.map((attachment) =>
          attachment.type === "image"
            ? attachment
            : {
                type: "file" as const,
                ...(attachment.filename
                  ? { filename: attachment.filename }
                  : {}),
                mimeType:
                  attachment.mimeType ??
                  /^data:([^;,]+)/u.exec(attachment.dataUrl)?.[1] ??
                  "application/octet-stream",
              }
        )
        let materialized:
          | Awaited<
              ReturnType<typeof routes.options.runtime.runtime.stageAttachments>
            >
          | undefined
        const stage = {
          public: publicAttachments,
          async appendTo(text: string) {
            const resolved =
              await routes.options.runtime.runtime.resolveInvitedSession(
                agentId,
                ref,
                {
                  ...(identity.firstTurn?.instruction
                    ? { firstTurnInstruction: identity.firstTurn.instruction }
                    : {}),
                }
              )
            if (!resolved) throw new Error("Invited Session was not resolved")
            materialized =
              await routes.options.runtime.runtime.stageAttachments(
                agentId,
                resolved.sessionId,
                body.data.attachments
              )
            return materialized.appendTo(text)
          },
          async cleanup() {
            await materialized?.cleanup()
          },
        }
        const sizeBytes = body.data.attachments.reduce(
          (total, attachment) => total + attachment.dataUrl.length,
          0
        )
        const stageId = routes.attachmentStages.create(
          agentId,
          ref,
          stage,
          sizeBytes
        )
        if (!stageId) {
          await stage.cleanup().catch(() => undefined)
          return routes.projectedError(
            identity,
            agentId,
            ref,
            "rate_limited",
            true,
            503
          )
        }
        return context.json(
          SessionAttachmentStageResponseSchema.parse({
            stageId,
            attachments: stage.public,
          }),
          201
        )
      } catch {
        return routes.projectedError(
          identity,
          agentId,
          ref,
          "temporarily_unavailable",
          true,
          503
        )
      }
    }
  )

  app.post(
    "/api/guest/v1/agents/:agentId/audio/transcribe",
    async (context) => {
      if (context.req.header("origin") !== routes.options.publicOrigin)
        return emptyError(403)
      const identity = await routes.authenticate(context.req.raw)
      if (!identity) return invitationError()
      const agentId = context.req.param("agentId")
      if (
        !routes.authorize(identity, agentId, identity.ref, "audio:transcribe")
      )
        return emptyError(401)
      const release = routes.audioBudget.acquire(identity.ref)
      if (!release) {
        void context.req.raw.body?.cancel().catch(() => undefined)
        return routes.projectedError(
          identity,
          agentId,
          identity.ref,
          "rate_limited",
          true,
          503
        )
      }
      try {
        const body = SessionTranscriptionRequestSchema.safeParse(
          await boundedJson(context.req.raw, 7_500_000)
        )
        if (!body.success) return emptyError(400)
        const bytes = recordingBytes(body.data.dataUrl, body.data.mimeType)
        if (!bytes) return emptyError(400)
        return context.json(
          SessionTranscriptionResponseSchema.parse({
            transcript: await routes.options.runtime.runtime.transcribe(
              agentId,
              bytes,
              body.data.mimeType,
              context.req.raw.signal
            ),
          })
        )
      } catch {
        return routes.projectedError(
          identity,
          agentId,
          identity.ref,
          "temporarily_unavailable",
          true,
          503
        )
      } finally {
        release()
      }
    }
  )

  app.post("/api/guest/v1/agents/:agentId/audio/speak", async (context) => {
    if (context.req.header("origin") !== routes.options.publicOrigin)
      return emptyError(403)
    const identity = await routes.authenticate(context.req.raw)
    if (!identity) return invitationError()
    const agentId = context.req.param("agentId")
    if (!routes.authorize(identity, agentId, identity.ref, "audio:speak"))
      return emptyError(401)
    const release = routes.audioBudget.acquire(identity.ref)
    if (!release) {
      void context.req.raw.body?.cancel().catch(() => undefined)
      return routes.projectedError(
        identity,
        agentId,
        identity.ref,
        "rate_limited",
        true,
        503
      )
    }
    try {
      const body = SessionSpeechRequestSchema.safeParse(
        await boundedJson(context.req.raw, 40_000)
      )
      if (!body.success) return emptyError(400)
      const speech = await routes.options.runtime.runtime.speak(
        agentId,
        body.data.text,
        context.req.raw.signal
      )
      return new Response(Uint8Array.from(speech.bytes).buffer, {
        headers: { "content-type": speech.mimeType },
      })
    } catch {
      return routes.projectedError(
        identity,
        agentId,
        identity.ref,
        "temporarily_unavailable",
        true,
        503
      )
    } finally {
      release()
    }
  })

  app.get(
    "/api/guest/v1/agents/:agentId/sessions/:sessionId/artifacts/:artifactId",
    async (context) => {
      const identity = await routes.authenticate(context.req.raw)
      if (!identity) return invitationError()
      const agentId = context.req.param("agentId")
      const ref = context.req.param("sessionId")
      const authorization = routes.authorize(
        identity,
        agentId,
        ref,
        "artifacts:read"
      )
      if (!authorization) return emptyError(401)
      const resolved =
        await routes.options.runtime.runtime.resolveInvitedSession(agentId, ref)
      if (!resolved) return emptyError(404)
      try {
        const artifact = await routes.options.runtime.runtime.artifact(
          agentId,
          resolved.sessionId,
          context.req.param("artifactId")
        )
        const projected = projectGuestOutbound(
          {
            transport: "artifact",
            agentId,
            sessionId: ref,
            payload: {
              type: "artifact",
              name: artifact.filename,
              mediaType: artifact.mimeType ?? "application/octet-stream",
              sizeBytes: artifact.bytes.byteLength,
            },
          },
          authorization
        )
        if (projected?.payload.type !== "artifact") return emptyError(503)
        return new Response(Buffer.from(artifact.bytes), {
          headers: {
            "content-type": projected.payload.mediaType,
            "content-length": String(projected.payload.sizeBytes),
            "content-disposition": `attachment; filename*=UTF-8''${encodedFilename(projected.payload.name)}`,
          },
        })
      } catch (error) {
        // The same classification the operator route answers with: an artifact
        // the provider can no longer read is gone, and only an unclassified
        // failure is an outage worth retrying. The projected body carries a
        // fixed description, so neither answer names a native path.
        const gone =
          routes.options.runtime.runtime.publicError(error)?.code ===
          "not_found"
        return routes.projectedError(
          identity,
          agentId,
          ref,
          gone ? "not_found" : "temporarily_unavailable",
          !gone,
          gone ? 404 : 503
        )
      }
    }
  )
}
