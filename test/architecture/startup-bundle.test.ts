// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { build, type Rollup } from "vite"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

// One production build serves both checks. The outer build is not written, but
// `vite-plugin-pwa` builds and writes the worker itself, so it goes to a
// temporary directory instead of overwriting the checkout's `dist/`.
let outDir: string
let chunks: Rollup.OutputChunk[]
let buildId: string | undefined

beforeAll(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "aos-ui-startup-bundle-"))
  vi.stubEnv("NODE_ENV", "production")
  const result = await build({
    build: { write: false, outDir },
    logLevel: "silent",
  }).finally(() => vi.unstubAllEnvs())
  if ("on" in result) throw new Error("Expected a single production build")
  const outputs = Array.isArray(result)
    ? result.flatMap(({ output }) => output)
    : result.output
  chunks = outputs.filter((output) => output.type === "chunk")
  const asset = outputs.find((output) => output.fileName === "build-id")
  buildId = asset?.type === "asset" ? String(asset.source) : undefined
}, 90_000)

afterAll(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true })
})

it("keeps runtime-specific workspace code out of the configuration bootstrap", () => {
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
})

// A tab whose build differs from the proxy's reloads, so the id must change
// with every chunk the page loads: the entry chunk's hash covers them all.
it("names the build by its entry chunk's content hash", () => {
  const entry = chunks.find((chunk) => chunk.isEntry)
  expect(buildId).toMatch(/^[\w-]{8,}$/)
  expect(entry?.fileName).toBe(`assets/${entry?.name}-${buildId}.js`)
})

// The vite-plugin-pwa copies the define block but not the buildIdPlugin's
// generateBundle hook, so the service worker build leaves the placeholder
// untouched. No browser chunk should carry the placeholder after the build.
it("replaces the build-id placeholder in every browser chunk", () => {
  const placeholder = "__AOS_BUILD_ID_PLACEHOLDER__"
  expect(buildId).toBeDefined()
  for (const chunk of chunks) {
    expect(chunk.code, `${chunk.fileName} still has the placeholder`).not.toContain(
      placeholder
    )
  }
})

/**
 * The worker's listener registration has no jsdom equivalent, so this asserts
 * the one thing that matters about it: the shipped bundle.
 */
it("ships a push-only worker that takes over from its predecessor", async () => {
  const worker = await readFile(path.join(outDir, "sw.js"), "utf8")

  // The lifecycle pair below is safe only while nothing here answers a fetch: a
  // caching worker claiming a document mid-flight could serve it half updated.
  const listeners = [
    ...worker.matchAll(/addEventListener\(\s*["'`](\w+)["'`]/g),
  ].map(([, name]) => name)
  expect(new Set(listeners)).toEqual(
    new Set(["install", "activate", "push", "notificationclick"])
  )
  // An updated worker must not install into `waiting` behind the old one, where
  // a fix would stay invisible to an operator who keeps a tab open.
  expect(worker).toContain("skipWaiting")
  expect(worker).toContain("claim")
  // A worker registered without `type: "module"` cannot import anything.
  expect(worker).not.toMatch(/^(?:import|export) /m)
})
