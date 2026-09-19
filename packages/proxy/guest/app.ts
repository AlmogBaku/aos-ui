import { Hono } from "hono"

import { guestErrorDescription } from "../auth/guest-projection"
import {
  createGuestRoutes,
  emptyError,
  guestSecurityHeaders,
  type GuestAppOptions,
} from "./context"
import { registerGuestContentRoutes } from "./routes/content"
import { registerGuestRuntimeRoute } from "./routes/runtime"

export type { GuestAppOptions } from "./context"

export function createGuestApp(options: GuestAppOptions) {
  const app = new Hono()
  const routes = createGuestRoutes(options)

  app.use("*", async (context, next) => {
    await next()
    for (const [name, value] of Object.entries(guestSecurityHeaders))
      context.header(name, value)
  })

  registerGuestRuntimeRoute(app, routes)
  registerGuestContentRoutes(app, routes)

  app.onError(() =>
    Response.json(
      {
        error: {
          code: "temporarily_unavailable",
          description: guestErrorDescription("temporarily_unavailable"),
        },
      },
      { status: 503 }
    )
  )
  app.notFound(() => emptyError(404))
  return app
}
