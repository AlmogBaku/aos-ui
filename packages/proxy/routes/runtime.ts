import { RuntimeInfoSchema } from "../../protocol"
import type { ServerRuntime } from "../core/runtime"
import type { ProxyRouteApp } from "./types"

/**
 * Runtime discovery stays on REST: the browser reads it before it has an ACP
 * connection, to decide whether the normalized runtime is reachable at all.
 */
export function registerRuntimeRoute(
  app: ProxyRouteApp,
  requireRuntime: (request: Request) => Promise<ServerRuntime>
) {
  app.get("/api/aos/v1/runtime", async (context) => {
    const runtime = await requireRuntime(context.req.raw)
    return context.json(RuntimeInfoSchema.parse(await runtime.runtimeInfo()))
  })
}
