import type { Logger } from "../../lifecycle"

/**
 * The process-level I/O surface used by the handler installer.
 * The real `process` satisfies this; tests supply a fake.
 */
export type ProcessLike = {
  on(event: "unhandledRejection", handler: (reason: unknown) => void): void
  on(event: "uncaughtException", handler: (error: unknown) => void): void
  exit(code: number): void
}

/**
 * Installs process-level fault handlers:
 * - `unhandledRejection`: logs one warn line and keeps serving.
 * - `uncaughtException`: logs one error line and exits 1 so the supervisor
 *   restarts the process.
 *
 * An unhandled rejection in Bun 1.3.10 terminates the process and drops every
 * socket; this handler intercepts it before Bun's default action.
 */
export function installProcessHandlers(
  logger: Logger,
  proc: ProcessLike = process
): void {
  proc.on("unhandledRejection", (reason: unknown) => {
    logger.warn({ err: reason }, "proxy.unhandled_rejection")
  })
  proc.on("uncaughtException", (error: unknown) => {
    logger.error({ err: error }, "proxy.uncaught_exception")
    proc.exit(1)
  })
}
