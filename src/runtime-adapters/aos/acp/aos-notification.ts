import type { z } from "zod"

import type { AcpConnection } from "./types"

/** Runs `handler` for every notification of `method` the proxy sends. */
export function onAosNotification<Value>(
  connection: Pick<AcpConnection, "onNotification">,
  method: string,
  schema: Pick<z.ZodType<Value>, "safeParse">,
  handler: (value: Value) => void
) {
  return connection.onNotification(method, (params) => {
    const parsed = schema.safeParse(params)
    if (parsed.success) handler(parsed.data)
  })
}
