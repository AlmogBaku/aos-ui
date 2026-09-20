import {
  PushInfoSchema,
  PushRegistrationSchema,
  PushUnregistrationSchema,
} from "../../protocol/push"
import type { ProxyAppOptions } from "../app"
import { parsePushEndpoint } from "../push/endpoint"
import { PushRegistrationLimitError } from "../push/registrations"
import { boundedJson, errorResponse } from "./http"
import type { ProxyRouteApp } from "./types"

const PUSH_PATH = "/api/aos/v1/push"
const SUBSCRIPTIONS_PATH = `${PUSH_PATH}/subscriptions`

/**
 * The operator's own push registrations. A deployment without push answers the
 * discovery read with `not-configured` so the browser can stay quiet about a
 * capability it does not have, and refuses the writes outright.
 */
export function registerPushRoutes(
  app: ProxyRouteApp,
  options: ProxyAppOptions,
  resolvePrincipal: (request: Request) => string
) {
  const { push } = options

  app.get(PUSH_PATH, (context) =>
    context.json(
      PushInfoSchema.parse(
        push
          ? { status: "available", publicKey: push.publicKey }
          : { status: "not-configured" }
      )
    )
  )

  app.put(SUBSCRIPTIONS_PATH, async (context) => {
    if (context.req.header("origin") !== options.publicOrigin)
      return errorResponse("forbidden", 403)
    if (!push) return errorResponse("not_found", 404)
    const body = PushRegistrationSchema.safeParse(
      await boundedJson(context.req.raw)
    )
    if (!body.success) return errorResponse("invalid_request", 400)
    // The proxy will post to this endpoint unattended, so it is checked here
    // rather than only when the first notification is owed.
    try {
      parsePushEndpoint(body.data.subscription.endpoint)
    } catch {
      return errorResponse("invalid_request", 400)
    }
    try {
      await push.registrations.put(resolvePrincipal(context.req.raw), body.data)
    } catch (cause) {
      if (cause instanceof PushRegistrationLimitError)
        return errorResponse("run_capacity_exceeded", 409)
      throw cause
    }
    return new Response(null, { status: 204 })
  })

  app.delete(SUBSCRIPTIONS_PATH, async (context) => {
    if (context.req.header("origin") !== options.publicOrigin)
      return errorResponse("forbidden", 403)
    if (!push) return errorResponse("not_found", 404)
    const body = PushUnregistrationSchema.safeParse(
      await boundedJson(context.req.raw)
    )
    if (!body.success) return errorResponse("invalid_request", 400)
    await push.registrations.remove(
      resolvePrincipal(context.req.raw),
      body.data.endpoint
    )
    return new Response(null, { status: 204 })
  })
}
