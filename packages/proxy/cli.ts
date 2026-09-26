import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { runProxyCli } from "./cli/program"
import { describeStartFailure } from "./config-file"
import { redactForLog } from "./redaction"
import { createStaticHandler } from "./static"

export { runProxyCli } from "./cli/program"

const logger = {
  info(value: unknown) {
    console.info(JSON.stringify(redactForLog(value)))
  },
  error(value: unknown) {
    console.error(JSON.stringify(redactForLog(value)))
  },
}

/** The build a static root carries, which a development root has none of. */
function readBuildId(root: string) {
  const path = resolve(root, "build-id")
  return existsSync(path)
    ? readFileSync(path, "utf8").trim() || undefined
    : undefined
}

if (import.meta.main) {
  const root = process.env.AOS_UI_STATIC_ROOT ?? "/app/dist"
  const staticHandler = createStaticHandler({
    root,
    runtimeConfig:
      process.env.AOS_UI_RUNTIME_CONFIG_FILE ??
      "/run/aos-ui/runtime-config.json",
  })
  void runProxyCli(process.argv, {
    logger,
    staticHandler,
    buildId: readBuildId(root),
    // The only reader of the real environment.
    getenv: (name: string) => process.env[name],
  }).catch((error: unknown) => {
    logger.error({
      event: "proxy.start_failed",
      error: describeStartFailure(error),
    })
    process.exitCode = 1
  })
}
