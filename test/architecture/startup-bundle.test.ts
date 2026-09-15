// @vitest-environment node

import { gzipSync } from "node:zlib"
import { build } from "vite"
import { expect, it, vi } from "vitest"

it("keeps runtime-specific workspace code out of the configuration bootstrap", async () => {
  vi.stubEnv("NODE_ENV", "production")
  const result = await build({
    build: { write: false },
    logLevel: "silent",
  }).finally(() => vi.unstubAllEnvs())
  if ("on" in result) throw new Error("Expected a single production build")
  const outputs = Array.isArray(result)
    ? result.flatMap(({ output }) => output)
    : result.output
  const chunks = outputs.filter((output) => output.type === "chunk")
  const entry = chunks.find((chunk) => chunk.isEntry)
  expect(entry).toBeDefined()
  const initial = new Set<string>()
  function visit(filename: string) {
    if (initial.has(filename)) return
    const chunk = chunks.find((candidate) => candidate.fileName === filename)
    if (!chunk) return
    initial.add(filename)
    chunk.imports.forEach(visit)
  }
  visit(entry!.fileName)
  const initialGzipBytes = chunks
    .filter((chunk) => initial.has(chunk.fileName))
    .reduce((bytes, chunk) => bytes + gzipSync(chunk.code).byteLength, 0)

  // Bootstrap, configuration errors, and route selection should not download
  // the conversation before knowing which workspace the deployment serves.
  // Allow headroom above the measured 104 kB compressed bootstrap.
  expect(initialGzipBytes).toBeLessThan(120_000)
}, 60_000)
