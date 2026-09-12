import { OperatorAuthStateSchema, RuntimeAuthStateSchema } from "../../protocol"
import {
  GuestInvitationError,
  type GuestInvitationRequest,
} from "../auth/guest-invitation"
import { OperatorAuthError } from "../operator-auth"
import type { ProxyAppOptions } from "../app"
import { boundedJson, errorResponse } from "./http"
import type { ProxyRouteApp } from "./types"

export function registerAuthRoutes(
  app: ProxyRouteApp,
  options: ProxyAppOptions
) {
  const callbackUrl = (requestUrl: string, path: string) => {
    const incoming = new URL(requestUrl)
    return new URL(`${path}${incoming.search}`, options.publicOrigin)
  }
  const requestedReturnPath = (requestUrl: string) => {
    const url = new URL(requestUrl)
    const values = url.searchParams.getAll("return")
    if (values.length > 1) return undefined
    return values[0] ?? "/"
  }
  const operatorSession = async (request: Request) => {
    const session = await options.operatorAuth.session?.(request)
    if (!session) throw new OperatorAuthError()
    return session
  }

  app.get("/api/aos/v1/auth/operator", async (context) =>
    context.json(
      OperatorAuthStateSchema.parse(
        await options.operatorAuth.state(context.req.raw)
      )
    )
  )

  app.post("/api/aos/v1/guest-invitations", async (context) => {
    if (!options.guestInvitations) return errorResponse("not_found", 404)
    await options.operatorAuth.require(context.req.raw)
    if (context.req.header("origin") !== options.publicOrigin)
      return errorResponse("forbidden", 403)
    const request = await boundedJson(context.req.raw, 16_384)
    if (request === undefined) return errorResponse("invalid_request", 400)
    try {
      return context.json(
        await options.guestInvitations.issue(request as GuestInvitationRequest),
        201
      )
    } catch (error) {
      if (error instanceof GuestInvitationError)
        return errorResponse("invalid_request", 400)
      throw error
    }
  })

  app.get("/api/aos/v1/auth/operator/start", async (context) => {
    if (!options.operatorOidc) return errorResponse("not_found", 404)
    const returnPath = requestedReturnPath(context.req.url)
    if (returnPath === undefined) return errorResponse("invalid_request", 400)
    const started = await options.operatorOidc.begin(returnPath)
    return new Response(null, {
      status: 302,
      headers: {
        location: started.authorizationUrl.href,
        "set-cookie": started.flowCookie,
      },
    })
  })

  app.get("/api/aos/v1/auth/operator/callback", async (context) => {
    if (!options.operatorOidc) return errorResponse("not_found", 404)
    const completed = await options.operatorOidc.complete(
      callbackUrl(context.req.url, "/api/aos/v1/auth/operator/callback"),
      context.req.header("cookie") ?? null
    )
    const headers = new Headers({ "set-cookie": completed.flowCookie })
    if (completed.status === "rejected")
      return new Response(null, { status: 401, headers })
    headers.append("set-cookie", completed.sessionCookie)
    headers.set("location", completed.returnPath)
    return new Response(null, { status: 302, headers })
  })

  app.get("/api/aos/v1/auth/runtime", async (context) => {
    const operator = await options.operatorAuth.require(context.req.raw)
    const state = options.runtimeAuth
      ? await options.runtimeAuth.state({
          principalId: operator.operator.id,
          lane: "operator",
        })
      : await options.hermes.authState()
    return context.json(RuntimeAuthStateSchema.parse(state))
  })

  app.get("/api/aos/v1/auth/runtime/start", async (context) => {
    if (!options.runtimeAuth?.begin) return errorResponse("not_found", 404)
    const returnPath = requestedReturnPath(context.req.url)
    if (returnPath === undefined) return errorResponse("invalid_request", 400)
    const session = await operatorSession(context.req.raw)
    const started = await options.runtimeAuth.begin({
      principalId: session.principalId,
      lane: "operator",
      browserSessionId: session.sessionId,
      callbackUrl: `${options.publicOrigin}/api/aos/v1/auth/runtime/upstream/auth/callback`,
      returnPath,
    })
    return started.status === "redirect"
      ? started.response
      : errorResponse("temporarily_unavailable", 503)
  })

  app.get(
    "/api/aos/v1/auth/runtime/upstream/auth/callback",
    async (context) => {
      if (!options.runtimeAuth?.complete) return errorResponse("not_found", 404)
      const session = await operatorSession(context.req.raw)
      const completed = await options.runtimeAuth.complete({
        principalId: session.principalId,
        lane: "operator",
        browserSessionId: session.sessionId,
        callbackUrl: callbackUrl(
          context.req.url,
          "/api/aos/v1/auth/runtime/upstream/auth/callback"
        ).href,
        returnPath: "/",
      })
      return new Response(null, {
        status: 302,
        headers: { location: completed.returnPath },
      })
    }
  )
}
