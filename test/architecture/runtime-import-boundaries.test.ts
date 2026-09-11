// @vitest-environment node
import { ESLint } from "eslint"
import { beforeAll, describe, expect, it } from "vitest"

const eslint = new ESLint()
async function boundaryErrors(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath })
  return result!.messages.filter(
    ({ ruleId }) => ruleId === "aos/runtime-package-boundaries"
  )
}

describe("runtime package import boundaries", () => {
  beforeAll(async () => {
    await eslint.calculateConfigForFile("src/components/example.tsx")
  }, 15_000)

  it.each([
    'import { runtimeAdapter } from "@/runtime-adapters/hermes/composition"',
    'export { HermesNativeClient } from "../runtime-adapters/hermes/hermes-native-client"',
    'export * from "@/runtime-adapters/hermes/hermes-native-client"',
    'const adapter = import("@/runtime-adapters/hermes/composition")',
    'type Client = import("@/runtime-adapters/hermes/hermes-native-client").HermesNativeClient',
    'const adapter = import("../runtime-adapters/hermes/../hermes/composition")',
    "const adapter = import(`@/runtime-adapters/hermes/composition`)",
    'const adapter = require("@/runtime-adapters/hermes/composition")',
  ])("rejects production access to provider internals: %s", async (code) => {
    expect(
      await boundaryErrors("src/components/example.tsx", code)
    ).toHaveLength(1)
  })

  it.each([
    'import { runtimeAdapter } from "../hermes"',
    'import { runtimeAdapter } from "@/runtime-adapters/hermes"',
    'const adapter = import("../hermes/index.ts")',
    'import type { HermesSession } from "../hermes/hermes-native-client"',
  ])("rejects imports between provider packages: %s", async (code) => {
    expect(
      await boundaryErrors("src/runtime-adapters/opencode/example.ts", code)
    ).toHaveLength(1)
  })

  it.each([
    'import { runtimeAdapter } from "@/runtime-adapters/hermes"',
    'import { runtimeAdapter } from "../runtime-adapters/hermes/index"',
    'const adapter = import("../runtime-adapters/hermes/index.ts")',
  ])("allows consumers to use public package indexes: %s", async (code) => {
    expect(await boundaryErrors("src/components/example.tsx", code)).toEqual([])
  })

  it("allows internal imports inside the owning package", async () => {
    expect(
      await boundaryErrors(
        "src/runtime-adapters/hermes/example.ts",
        'import { HermesNativeClient } from "./hermes-native-client"'
      )
    ).toEqual([])
  })

  it.each(["vite.config.ts", "shared/example.ts"])(
    "enforces the package seam for non-UI consumers in %s",
    async (filePath) => {
      expect(
        await boundaryErrors(
          filePath,
          'const adapter = import("@/runtime-adapters/hermes/composition")'
        )
      ).toHaveLength(1)
    }
  )

  it("allows only documented fixture-test access, not arbitrary tests or other providers", async () => {
    expect(
      await boundaryErrors(
        "src/components/test-utils/controlled-workspace-fixture.tsx",
        'import { useFixtureRuntimeBundle } from "@/runtime-adapters/fixture/fixture-runtime"'
      )
    ).toEqual([])
    expect(
      await boundaryErrors(
        "src/components/example.test.tsx",
        'import { useFixtureRuntimeBundle } from "@/runtime-adapters/fixture/fixture-runtime"'
      )
    ).toHaveLength(1)
    expect(
      await boundaryErrors(
        "src/components/aos-ui-workspace.test.tsx",
        'import { HermesNativeClient } from "@/runtime-adapters/hermes/hermes-native-client"'
      )
    ).toHaveLength(1)
  })
})
