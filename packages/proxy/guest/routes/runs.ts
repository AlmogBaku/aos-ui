import { RunAgentInputSchema } from "@ag-ui/core"
import type { Hono } from "hono"

import type {
  GuestOperation,
  VerifiedGuestIdentity,
} from "../../auth/guest-invitation"
import {
  createGuestRunAccess,
  projectGuestError,
} from "../../auth/guest-runtime-projection"
import { guestControllerId } from "../../auth/guest-request"
import { ServerRunConflictError } from "../../core/runtime"
import { boundedJson, validIdentifier } from "../../routes/http"
import { createRunStreamResponse, prepareRunInput } from "../../routes/runs"
import { emptyError, invitationError, type GuestRoutes } from "../context"

function runAuthorizations(
  routes: GuestRoutes,
  identity: VerifiedGuestIdentity,
  agentId: string,
  ref: string,
  operation: GuestOperation
) {
  const primary = routes.authorize(identity, agentId, ref, operation)
  const read = routes.authorize(identity, agentId, ref, "messages:read")
  const errors = routes.authorize(identity, agentId, ref, "errors:read")
  return primary && read && errors ? { primary, read, errors } : undefined
}

function guestResumeAllowed(
  routes: GuestRoutes,
  scope: { agentId: string; sessionId: string },
  input: { resume?: ReadonlyArray<{ interruptId: string; payload?: unknown }> }
) {
  if (!input.resume) return true
  const interrupts = routes.options.runtime.sessions.snapshot(scope).interrupts
  return input.resume.every((response) => {
    const interrupt = interrupts.find(({ id }) => id === response.interruptId)
    return !(interrupt?.reason === "approval" && response.payload === "always")
  })
}

export function registerGuestRunRoutes(app: Hono, routes: GuestRoutes) {
  app.post(
    "/api/guest/v1/agents/:agentId/sessions/:sessionId/runs",
    async (context) => {
      if (context.req.header("origin") !== routes.options.publicOrigin)
        return emptyError(403)
      const identity = await routes.authenticate(context.req.raw)
      if (!identity) return invitationError()
      const agentId = context.req.param("agentId")
      const ref = context.req.param("sessionId")
      if (identity.agentId !== agentId || identity.ref !== ref)
        return emptyError(401)
      const candidate = await boundedJson(context.req.raw, 1_100_000)
      const parsed = RunAgentInputSchema.safeParse(candidate)
      if (!parsed.success) return emptyError(400)
      const prepared = await prepareRunInput(candidate, {
        agentId,
        threadId: ref,
        attachmentStages: routes.attachmentStages,
      })
      if (!prepared) return emptyError(400)
      const { input, stage } = prepared
      const operation: GuestOperation = input.resume
        ? "interactions:respond"
        : "messages:create"
      const grants = runAuthorizations(
        routes,
        identity,
        agentId,
        ref,
        operation
      )
      if (!grants) return emptyError(401)
      const resolved =
        await routes.options.runtime.runtime.resolveInvitedSession(
          agentId,
          ref,
          input.resume
            ? undefined
            : {
                ...(identity.firstTurn?.instruction
                  ? { firstTurnInstruction: identity.firstTurn.instruction }
                  : {}),
              }
        )
      if (!resolved) {
        await stage?.cleanup().catch(() => undefined)
        return emptyError(404)
      }
      const scope = { agentId, sessionId: resolved.sessionId, threadId: ref }
      if (!guestResumeAllowed(routes, scope, input)) {
        await stage?.cleanup().catch(() => undefined)
        return emptyError(400)
      }
      const releaseStream = routes.acquireStream(grants.read.tokenId)
      if (!releaseStream) {
        await stage?.cleanup().catch(() => undefined)
        return routes.projectedError(
          identity,
          agentId,
          ref,
          "rate_limited",
          true,
          503
        )
      }
      try {
        await routes.options.runtime.runtime.getSession(
          agentId,
          resolved.sessionId
        )
        const subscription = await routes.options.runtime.sessions.start(
          scope,
          input,
          createGuestRunAccess(
            grants.read,
            grants.errors,
            scope,
            input.runId,
            routes.now,
            routes.nextSubscriberId(grants.read.tokenId)
          ),
          stage
        )
        return createRunStreamResponse(subscription, {
          signal: context.req.raw.signal,
          expiresAt: identity.authorizationExpiresAt * 1_000,
          now: routes.now,
          schedule: routes.schedule,
          cancel: routes.cancel,
          onClose: releaseStream,
        })
      } catch (cause) {
        releaseStream()
        await stage?.cleanup().catch(() => undefined)
        return cause instanceof ServerRunConflictError
          ? projectGuestError(grants.errors, "request_failed", false, 409)
          : projectGuestError(
              grants.errors,
              "temporarily_unavailable",
              true,
              503
            )
      }
    }
  )

  app.post(
    "/api/guest/v1/agents/:agentId/sessions/:sessionId/runs/reconnect",
    async (context) => {
      if (context.req.header("origin") !== routes.options.publicOrigin)
        return emptyError(403)
      const identity = await routes.authenticate(context.req.raw)
      if (!identity) return invitationError()
      const agentId = context.req.param("agentId")
      const ref = context.req.param("sessionId")
      const grants = runAuthorizations(
        routes,
        identity,
        agentId,
        ref,
        "messages:read"
      )
      if (!grants) return emptyError(401)
      const candidate = await boundedJson(context.req.raw, 16_384)
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        Array.isArray(candidate) ||
        typeof (candidate as { runId?: unknown }).runId !== "string" ||
        !validIdentifier((candidate as { runId: string }).runId) ||
        (candidate as { threadId?: unknown }).threadId !== ref ||
        Object.keys(candidate).some(
          (key) => key !== "threadId" && key !== "runId" && key !== "after"
        ) ||
        ((candidate as { after?: unknown }).after !== undefined &&
          (!Number.isSafeInteger((candidate as { after: number }).after) ||
            (candidate as { after: number }).after < 0))
      )
        return emptyError(400)
      const resolved =
        await routes.options.runtime.runtime.resolveInvitedSession(agentId, ref)
      if (!resolved) return emptyError(404)
      const runId = (candidate as { runId: string }).runId
      const scope = { agentId, sessionId: resolved.sessionId, threadId: ref }
      const releaseStream = routes.acquireStream(grants.read.tokenId)
      if (!releaseStream)
        return routes.projectedError(
          identity,
          agentId,
          ref,
          "rate_limited",
          true,
          503
        )
      try {
        const subscription = await routes.options.runtime.sessions.recover(
          scope,
          {
            threadId: ref,
            runId,
            ...((candidate as { after?: number }).after === undefined
              ? {}
              : { after: (candidate as { after: number }).after }),
          },
          createGuestRunAccess(
            grants.read,
            grants.errors,
            scope,
            runId,
            routes.now,
            routes.nextSubscriberId(grants.read.tokenId)
          )
        )
        return createRunStreamResponse(subscription, {
          signal: context.req.raw.signal,
          expiresAt: identity.authorizationExpiresAt * 1_000,
          now: routes.now,
          schedule: routes.schedule,
          cancel: routes.cancel,
          onClose: releaseStream,
        })
      } catch (cause) {
        releaseStream()
        return cause instanceof ServerRunConflictError
          ? projectGuestError(grants.errors, "request_failed", false, 409)
          : projectGuestError(
              grants.errors,
              "temporarily_unavailable",
              true,
              503
            )
      }
    }
  )

  app.post(
    "/api/guest/v1/agents/:agentId/sessions/:sessionId/runs/stop",
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
        "messages:stop"
      )
      if (!authorization) return emptyError(401)
      const resolved =
        await routes.options.runtime.runtime.resolveInvitedSession(agentId, ref)
      if (!resolved) return emptyError(404)
      try {
        const status = await routes.options.runtime.sessions.stop(
          { agentId, sessionId: resolved.sessionId },
          guestControllerId(authorization)
        )
        return Response.json(
          { status },
          { status: status === "stopping" ? 202 : 200 }
        )
      } catch {
        return emptyError(404)
      }
    }
  )
}
