// @vitest-environment node

import { readFile } from "node:fs/promises"
import path from "node:path"
import { build } from "vite"
import { expect, it, vi } from "vitest"

/**
 * The worker's listener registration has no jsdom equivalent, so this asserts
 * the one thing that matters about it: the shipped bundle. The outer build does
 * not need to be written, because `vite-plugin-pwa` builds the worker itself.
 */
it("ships a push-only worker that takes over from its predecessor", async () => {
  vi.stubEnv("NODE_ENV", "production")
  await build({ build: { write: false }, logLevel: "silent" }).finally(() =>
    vi.unstubAllEnvs()
  )
  const worker = await readFile(
    path.resolve(import.meta.dirname, "../../dist/sw.js"),
    "utf8"
  )

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
}, 90_000)
