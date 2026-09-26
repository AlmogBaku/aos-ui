import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { runProxyCli } from "./cli/program"
import { createProxyLogger } from "./cli/logger"
import { CredentialValues } from "./redaction"
import { createStaticHandler } from "./static"

export { runProxyCli } from "./cli/program"

/** The build a static root carries, which a development root has none of. */
function readBuildId(root: string) {
  const path = resolve(root, "build-id")
  return existsSync(path)
    ? readFileSync(path, "utf8").trim() || undefined
    : undefined
}

if (import.meta.main) {
  const credentials = new CredentialValues()
  // Writes a start failure before the configuration, and so its level, has loaded.
  const bootstrapLogger = createProxyLogger({ level: "info", credentials })
  const root = process.env.AOS_UI_STATIC_ROOT ?? "/app/dist"
  const staticHandler = createStaticHandler({
    root,
    runtimeConfig:
      process.env.AOS_UI_RUNTIME_CONFIG_FILE ??
      "/run/aos-ui/runtime-config.json",
  })
  void runProxyCli(process.argv, {
    createLogger: (level) => createProxyLogger({ level, credentials }),
    credentials,
    staticHandler,
    buildId: readBuildId(root),
    // The only reader of the real environment.
    getenv: (name: string) => process.env[name],
  }).catch((error: unknown) => {
    bootstrapLogger.error({ event: "proxy.start_failed", error })
    process.exitCode = 1
  })
}
