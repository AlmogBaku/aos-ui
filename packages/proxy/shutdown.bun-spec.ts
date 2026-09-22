import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { stringify } from "yaml"

import { AOS_ACP_OPERATOR_PATH } from "../protocol/acp"

/**
 * A real `serve` process, a real ACP peer, and a real provider socket: only a
 * spawned Bun process can show that SIGTERM ends the proxy inside its grace.
 */
const SHUTDOWN_GRACE_MS = 1_000
const EXIT_MARGIN_MS = 2_000
const REPOSITORY_ROOT = join(import.meta.dir, "..", "..")

type FakeHermes = {
  baseUrl: string
  connected: Promise<void>
  stop(): void
}

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function freePort() {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null) })
  const { port } = probe
  await probe.stop(true)
  if (port === undefined) throw new Error("Bun reported no listening port")
  return port
}

/** Answers the native WebSocket handshake so the proxy holds a live provider socket. */
function fakeHermes(): FakeHermes {
  let announceConnected!: () => void
  const connected = new Promise<void>((resolve) => {
    announceConnected = resolve
  })
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      if (new URL(request.url).pathname !== "/api/ws")
        return Response.json({ items: [] })
      return server.upgrade(request)
        ? undefined
        : new Response(null, { status: 400 })
    },
    websocket: {
      open() {
        announceConnected()
      },
      message(socket, raw) {
        const frame = JSON.parse(String(raw)) as { id?: string }
        if (frame.id === undefined) return
        socket.send(
          JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} })
        )
      },
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    connected,
    stop: () => void server.stop(true),
  }
}

async function proxyConfig(port: number, hermesBaseUrl: string) {
  const directory = await mkdtemp(join(tmpdir(), "aos-proxy-shutdown-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const tokenFile = join(directory, "hermes-token")
  await writeFile(tokenFile, "shutdown-spec-token", { mode: 0o600 })
  const configFile = join(directory, "proxy.yaml")
  await writeFile(
    configFile,
    stringify({
      version: 1,
      deploymentId: "shutdown-spec",
      listen: { host: "127.0.0.1", port },
      publicOrigin: `http://127.0.0.1:${port}`,
      runtime: {
        id: "hermes-main",
        kind: "hermes",
        baseUrl: hermesBaseUrl,
        tokenFile,
        sessionIdleMs: 300_000,
      },
      limits: {
        activeExecutions: 8,
        guestActiveExecutions: 4,
        operatorEventPeers: 8,
        subscriberEvents: 64,
        subscriberBytes: 1_048_576,
      },
      shutdownGraceMs: SHUTDOWN_GRACE_MS,
    }),
    // A default mode under `umask 002` is group-writable, which the loader refuses.
    { mode: 0o600 }
  )
  return { configFile, directory }
}

/**
 * The spawned proxy reads the real environment, so the spec hands it one with
 * every configuration override removed and points it at the spec's own file.
 */
function scrubbedEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("AOS_UI_PROXY_")
    )
  )
}

/** Collects one spawned stream without blocking the spec on its end. */
function collect(stream: ReadableStream<Uint8Array>, sink: { text: string }) {
  void (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) sink.text += decoder.decode(chunk)
  })()
}

async function waitFor(condition: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) return false
    await Bun.sleep(25)
  }
  return true
}

describe("proxy shutdown under SIGTERM", () => {
  it("exits inside the grace with an ACP peer and a provider socket attached", async () => {
    const hermes = fakeHermes()
    cleanups.push(() => hermes.stop())
    const port = await freePort()
    const { configFile, directory } = await proxyConfig(port, hermes.baseUrl)

    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        "packages/proxy/cli.ts",
        "serve",
        "--config",
        configFile,
      ],
      cwd: REPOSITORY_ROOT,
      env: { ...scrubbedEnvironment(), AOS_UI_STATIC_ROOT: directory },
      stdout: "pipe",
      stderr: "pipe",
    })
    cleanups.push(() => {
      if (child.exitCode === null) child.kill("SIGKILL")
    })
    const output = { text: "" }
    const errors = { text: "" }
    collect(child.stdout, output)
    collect(child.stderr, errors)

    expect(
      await waitFor(() => output.text.includes("proxy.started"), 10_000),
      `${output.text}${errors.text}`
    ).toBe(true)

    // Attach the provider socket the way a live deployment does.
    const readiness = await fetch(
      `http://127.0.0.1:${port}/api/aos/v1/readyz`
    ).catch(() => undefined)
    expect(readiness).toBeDefined()
    await hermes.connected

    // Hold one ACP connection open, with a live SDK session behind it.
    const origin = `http://127.0.0.1:${port}`
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}${AOS_ACP_OPERATOR_PATH}`,
      {
        headers: { Origin: origin },
      }
    )
    const answered = new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () =>
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: 2,
              info: { name: "shutdown-spec", version: "0" },
            },
          })
        )
      )
      socket.addEventListener("message", () => resolve())
      socket.addEventListener("error", reject)
    })
    await answered

    const startedAt = performance.now()
    child.kill("SIGTERM")
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(SHUTDOWN_GRACE_MS + EXIT_MARGIN_MS).then(() => "timed-out"),
    ])
    const elapsedMs = performance.now() - startedAt

    expect(exitCode, `${output.text}${errors.text}`).not.toBe("timed-out")
    expect(elapsedMs).toBeLessThan(SHUTDOWN_GRACE_MS + EXIT_MARGIN_MS)
    expect(output.text).toContain("proxy.shutdown.started")
    expect(output.text).toContain("proxy.shutdown.completed")
    expect(exitCode, `${output.text}${errors.text}`).toBe(0)
  })
})
