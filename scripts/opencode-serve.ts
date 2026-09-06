import { spawn } from "node:child_process"
import { connect } from "node:net"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  createManagementProvider,
  startManagementServer,
} from "./opencode-management"

import {
  buildOpenCodeConfigContent,
  createOpenCodeChildEnvironment,
  createOpenCodeServeArguments,
  parseCorsOrigins,
} from "./opencode-config"

const forwardedSignals = ["SIGTERM", "SIGINT"] as const

type OpenCodeChild = {
  kill(signal: (typeof forwardedSignals)[number]): boolean
  once(event: "error", listener: (error: Error) => void): unknown
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown
}

type SignalSource = {
  on(signal: (typeof forwardedSignals)[number], listener: () => void): unknown
  off(signal: (typeof forwardedSignals)[number], listener: () => void): unknown
}

export function waitForOpenCodeExit(
  child: OpenCodeChild,
  signalSource: SignalSource = process
) {
  return new Promise<number>((resolveExit) => {
    let settled = false
    const signalListeners = new Map<
      (typeof forwardedSignals)[number],
      () => void
    >()

    const cleanup = () => {
      for (const [signal, listener] of signalListeners) {
        signalSource.off(signal, listener)
      }
      signalListeners.clear()
    }

    const finish = (code: number) => {
      if (settled) return
      settled = true
      cleanup()
      resolveExit(code)
    }

    for (const signal of forwardedSignals) {
      const forward = () => {
        child.kill(signal)
      }
      signalListeners.set(signal, forward)
      signalSource.on(signal, forward)
    }

    child.once("error", (error) => {
      console.error(`Unable to start OpenCode: ${error.message}`)
      finish(1)
    })
    child.once("exit", (code, signal) =>
      finish(
        code ?? (signal === "SIGTERM" ? 143 : signal === "SIGINT" ? 130 : 1)
      )
    )
  })
}

function isPortOccupied(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port })
    let settled = false

    const finish = (occupied: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(occupied)
    }

    socket.setTimeout(500)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))
  })
}

export async function main() {
  const host = process.env.AOS_UI_OPENCODE_HOST?.trim() || "127.0.0.1"
  const rawPort = process.env.AOS_UI_OPENCODE_PORT?.trim() || "4096"
  const port = Number(rawPort)
  const managementPort = Number(
    process.env.AOS_UI_OPENCODE_MANAGEMENT_PORT ?? "4097"
  )
  const corsOrigins = parseCorsOrigins(process.env.AOS_UI_OPENCODE_CORS_ORIGINS)
  const configContent = buildOpenCodeConfigContent(process.env)

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    console.error(
      `AOS_UI_OPENCODE_PORT must be an integer from 1 to 65535; received ${JSON.stringify(rawPort)}.`
    )
    return 1
  }
  if (
    !Number.isInteger(managementPort) ||
    managementPort < 1 ||
    managementPort > 65_535 ||
    managementPort === port
  ) {
    console.error(
      "AOS_UI_OPENCODE_MANAGEMENT_PORT must be a distinct port from 1 to 65535."
    )
    return 1
  }

  if (await isPortOccupied(host, port)) {
    console.error(
      [
        `OpenCode cannot start because ${host}:${port} is already in use.`,
        "Another OpenCode server may already be running. Reuse it, or stop that process and retry.",
        `Inspect the listener with: lsof -nP -iTCP:${port} -sTCP:LISTEN`,
      ].join("\n")
    )
    return 1
  }

  const providerHost =
    host === "0.0.0.0"
      ? "127.0.0.1"
      : host === "::"
        ? "[::1]"
        : host.includes(":")
          ? `[${host}]`
          : host
  const management = await startManagementServer({
    host,
    port: managementPort,
    worktree: process.cwd(),
    origins: corsOrigins,
    provider: createManagementProvider(
      `http://${providerHost}:${port}`,
      process.cwd()
    ),
  })
  console.info(`AOS Agent management listening on ${host}:${managementPort}`)
  const child = spawn(
    "opencode",
    createOpenCodeServeArguments(host, port, corsOrigins),
    {
      env: createOpenCodeChildEnvironment(process.env, configContent),
      stdio: "inherit",
    }
  )

  try {
    return await waitForOpenCodeExit(child)
  } finally {
    await management.close()
  }
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  process.exit(await main())
}
