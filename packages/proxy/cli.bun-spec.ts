/**
 * The process-level fault handlers over a real Bun process. Runs under `bun test` (not vitest) because the relevant
 * behavior — Bun 1.3.10 exiting on an unhandled rejection before the handler
 * intercepts it — can only be verified in a real process.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPOSITORY_ROOT = join(import.meta.dir, "..", "..")

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "aos-proxy-handlers-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Collects all output from a spawned stream into a string sink. */
function collect(stream: ReadableStream<Uint8Array>, sink: { text: string }) {
  void (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) sink.text += decoder.decode(chunk)
  })()
}

/** A minimal structured logger that writes JSON lines to stdout. */
const INLINE_LOGGER = `
const log = (level, fields, msg) =>
  process.stdout.write(JSON.stringify({ level, msg, ...fields }) + "\\n")
const logger = {
  debug: (f, m) => log("debug", f, m),
  info:  (f, m) => log("info",  f, m),
  warn:  (f, m) => log("warn",  f, m),
  error: (f, m) => log("error", f, m),
  child() { return this },
}
`

describe("process handlers (bun process)", () => {
  it("unhandledRejection: process logs and keeps serving (does not exit)", async () => {
    const dir = await tempDir()
    // A script that installs the handlers then creates an unhandled rejection;
    // it waits 200 ms (long enough for Bun to fire the event) then exits 0.
    const script = join(dir, "rejection.ts")
    await writeFile(
      script,
      `
import { installProcessHandlers } from "${REPOSITORY_ROOT}/packages/proxy/cli/process-handlers.ts"
${INLINE_LOGGER}
installProcessHandlers(logger)
// Create an unhandled rejection: no .catch(), not awaited.
Promise.reject(new Error("test-rejection"))
// Give Bun time to fire the event, then exit normally.
setTimeout(() => process.exit(0), 200)
`,
      { mode: 0o600 }
    )

    const child = Bun.spawn({
      cmd: [process.execPath, "run", script],
      cwd: REPOSITORY_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
    cleanups.push(() => {
      if (child.exitCode === null) child.kill("SIGKILL")
    })
    const out = { text: "" }
    const err = { text: "" }
    collect(child.stdout, out)
    collect(child.stderr, err)

    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(2_000).then(() => "timed-out" as const),
    ])

    expect(exitCode, `stdout: ${out.text}\nstderr: ${err.text}`).toBe(0)
    // The combined output carries the warn line the handler wrote.
    expect(out.text + err.text).toContain("proxy.unhandled_rejection")
  })

  it("uncaughtException: process logs and exits 1", async () => {
    const dir = await tempDir()
    const script = join(dir, "exception.ts")
    await writeFile(
      script,
      `
import { installProcessHandlers } from "${REPOSITORY_ROOT}/packages/proxy/cli/process-handlers.ts"
${INLINE_LOGGER}
installProcessHandlers(logger)
// Throw synchronously outside any try-catch to trigger uncaughtException.
setTimeout(() => { throw new Error("test-exception") }, 0)
`,
      { mode: 0o600 }
    )

    const child = Bun.spawn({
      cmd: [process.execPath, "run", script],
      cwd: REPOSITORY_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
    cleanups.push(() => {
      if (child.exitCode === null) child.kill("SIGKILL")
    })
    const out = { text: "" }
    const err = { text: "" }
    collect(child.stdout, out)
    collect(child.stderr, err)

    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(2_000).then(() => "timed-out" as const),
    ])

    expect(exitCode, `stdout: ${out.text}\nstderr: ${err.text}`).toBe(1)
    expect(out.text + err.text).toContain("proxy.uncaught_exception")
  })
})
