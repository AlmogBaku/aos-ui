import type { AssistantRuntime } from "@assistant-ui/react"

/** Assistant UI parks the queue before delegating the exact native interrupt. */
export async function stopCurrentHermesRun(runtime: AssistantRuntime) {
  await runtime.thread.cancelRun()
}
