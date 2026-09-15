import type { Hono } from "hono"

export type ProxyRouteApp = Hono<{ Variables: { requestId: string } }>
