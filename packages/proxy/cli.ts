import { runProxyCli } from "./cli/program"
import { createProxyLogger } from "./cli/logger"
import { CredentialValues } from "./redaction"
import { createStaticHandler } from "./static"

export { runProxyCli } from "./cli/program"

if (import.meta.main) {
  const credentials = new CredentialValues()
  // Writes a start failure before the configuration, and so its level, has loaded.
  const bootstrapLogger = createProxyLogger({ level: "info", credentials })
  const staticHandler = createStaticHandler({
    root: process.env.AOS_UI_STATIC_ROOT ?? "/app/dist",
    runtimeConfig:
      process.env.AOS_UI_RUNTIME_CONFIG_FILE ??
      "/run/aos-ui/runtime-config.json",
  })
  void runProxyCli(process.argv, {
    createLogger: (level) => createProxyLogger({ level, credentials }),
    credentials,
    staticHandler,
    // The only reader of the real environment.
    getenv: (name: string) => process.env[name],
  }).catch((error: unknown) => {
    bootstrapLogger.error({ event: "proxy.start_failed", error })
    process.exitCode = 1
  })
}
