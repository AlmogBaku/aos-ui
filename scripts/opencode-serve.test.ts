// @vitest-environment node

import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

import { describe, expect, it, vi } from "vitest"

import { waitForOpenCodeExit } from "./opencode-serve"

const projectRoot = path.resolve(import.meta.dirname, "..")

async function runServePreflight(port: number) {
  const worktree = await mkdtemp(path.join(tmpdir(), "aos-ui-opencode-serve-"))
  return new Promise<{ code: number | null; stderr: string }>(
    (resolve, reject) => {
      const child = spawn("bun", ["run", "scripts/opencode-serve.ts"], {
        cwd: projectRoot,
        env: {
          ...process.env,
          AOS_UI_OPENCODE_PORT: String(port),
          AOS_UI_OPENCODE_WORKTREE: worktree,
        },
        stdio: ["ignore", "ignore", "pipe"],
      })
      let stderr = ""
      const timeout = setTimeout(() => {
        child.kill("SIGTERM")
        reject(new Error("OpenCode serve preflight did not exit"))
      }, 5_000)

      child.stderr.setEncoding("utf8")
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk
      })
      child.on("error", reject)
      child.on("exit", (code) => {
        clearTimeout(timeout)
        resolve({ code, stderr })
      })
    }
  )
}

describe("OpenCode server startup", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "forwards %s, awaits the child exit, and removes both signal listeners",
    async (signal) => {
      const signalSource = new EventEmitter()
      const kill = vi.fn<(signal: "SIGTERM" | "SIGINT") => boolean>(() => true)
      const child = Object.assign(new EventEmitter(), { kill })
      let settled = false

      const exit = waitForOpenCodeExit(child, signalSource).then((code) => {
        settled = true
        return code
      })

      signalSource.emit(signal)
      await Promise.resolve()

      expect(kill).toHaveBeenCalledExactlyOnceWith(signal)
      expect(settled).toBe(false)

      child.emit("exit", 23, null)

      await expect(exit).resolves.toBe(23)
      expect(signalSource.listenerCount("SIGTERM")).toBe(0)
      expect(signalSource.listenerCount("SIGINT")).toBe(0)
    }
  )

  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const)("maps a child %s exit to status %i", async (signal, status) => {
    const signalSource = new EventEmitter()
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => true),
    })
    const exit = waitForOpenCodeExit(child, signalSource)

    child.emit("exit", null, signal)

    await expect(exit).resolves.toBe(status)
  })

  it("explains which address is occupied before invoking OpenCode", async () => {
    const blocker = createServer()
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject)
      blocker.listen(0, "127.0.0.1", resolve)
    })

    try {
      const address = blocker.address()
      if (!address || typeof address === "string") {
        throw new Error("Expected an assigned TCP port")
      }

      const result = await runServePreflight(address.port)

      expect(result.code).toBe(1)
      expect(result.stderr).toContain(
        `OpenCode cannot start because 127.0.0.1:${address.port} is already in use.`
      )
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })
})
