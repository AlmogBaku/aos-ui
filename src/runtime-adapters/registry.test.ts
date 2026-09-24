import { expect, it } from "vitest"
import { getRuntimeAdapter } from "./registry"

it("does not load a default provider for an unknown mode", () => {
  expect(getRuntimeAdapter("unconfigured")).toBeUndefined()
  expect(getRuntimeAdapter("toString")).toBeUndefined()
  expect(getRuntimeAdapter(undefined)).toBeUndefined()
})

it("resolves each browser runtime to its adapter", () => {
  for (const mode of ["fixture", "aos"]) {
    expect(getRuntimeAdapter(mode)?.mode).toBe(mode)
  }
})
