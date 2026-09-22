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

if (import.meta.main) {
  const staticHandler = createStaticHandler({
    root: process.env.AOS_UI_STATIC_ROOT ?? "/app/dist",
    runtimeConfig:
      process.env.AOS_UI_RUNTIME_CONFIG_FILE ??
      "/run/aos-ui/runtime-config.json",
  })
  void runProxyCli(process.argv, {
    logger,
    staticHandler,
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
