// @vitest-environment node
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { ESLint } from "eslint"
import { beforeAll, describe, expect, it } from "vitest"

const eslint = new ESLint()
async function boundaryErrors(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath })
  return result!.messages.filter(
    ({ ruleId }) => ruleId === "aos/runtime-package-boundaries"
  )
}

async function restrictedImportErrors(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath })
  return result!.messages.filter(
    ({ ruleId }) => ruleId === "no-restricted-imports"
  )
}

/** Any module specifier, however it is written: import, export, or require. */
const AG_UI_SPECIFIER =
  /["'`](?:@ag-ui\/[^"'`]*|@assistant-ui\/react-ag-ui)["'`]/u

describe("runtime package import boundaries", () => {
  beforeAll(async () => {
    await eslint.calculateConfigForFile("src/components/example.tsx")
  }, 15_000)

  it.each([
    'import { runtimeAdapter } from "@/runtime-adapters/aos/composition"',
    'export { AosRemoteClient } from "../runtime-adapters/aos/aos-client"',
    'export * from "@/runtime-adapters/aos/aos-client"',
    'const adapter = import("@/runtime-adapters/aos/composition")',
    'type Client = import("@/runtime-adapters/aos/aos-client").AosRemoteClient',
    'const adapter = import("../runtime-adapters/aos/../aos/composition")',
    "const adapter = import(`@/runtime-adapters/aos/composition`)",
    'const adapter = require("@/runtime-adapters/aos/composition")',
  ])("rejects production access to provider internals: %s", async (code) => {
    expect(
      await boundaryErrors("src/components/example.tsx", code)
    ).toHaveLength(1)
  })

  it.each([
    'import { runtimeAdapter } from "../aos"',
    'import { runtimeAdapter } from "@/runtime-adapters/aos"',
    'const adapter = import("../aos/index.ts")',
    'import type { AosRemoteClient } from "../aos/aos-client"',
  ])("rejects imports between provider packages: %s", async (code) => {
    expect(
      await boundaryErrors("src/runtime-adapters/fixture/example.ts", code)
    ).toHaveLength(1)
  })

  it.each([
    'import { runtimeAdapter } from "@/runtime-adapters/aos"',
    'import { runtimeAdapter } from "../runtime-adapters/aos/index"',
    'const adapter = import("../runtime-adapters/aos/index.ts")',
  ])("allows consumers to use public package indexes: %s", async (code) => {
    expect(await boundaryErrors("src/components/example.tsx", code)).toEqual([])
  })

  it("keeps the retired AG-UI browser packages out of the frontend", async () => {
    const files = (await readdir("src", { recursive: true })).filter((entry) =>
      /\.tsx?$/u.test(entry)
    )
    expect(files.length).toBeGreaterThan(0)
    const importers: string[] = []
    for (const file of files) {
      const path = join("src", file)
      if (AG_UI_SPECIFIER.test(await readFile(path, "utf8")))
        importers.push(path)
    }

    // The browser speaks ACP v2 to the proxy and the proxy owns its own run
    // vocabulary, so no AG-UI package belongs anywhere in the repository.
    expect(importers).toEqual([])
  })

  it("allows internal imports inside the owning package", async () => {
    expect(
      await boundaryErrors(
        "src/runtime-adapters/aos/example.ts",
        'import { AosRemoteClient } from "./aos-client"'
      )
    ).toEqual([])
  })

  it.each([
    ["src/components/example.tsx", 'import "../../packages/tools-mcp/server"'],
    [
      "src/components/example.test.tsx",
      'import "../../packages/tools-mcp/server"',
    ],
    [
      "packages/proxy/example.ts",
      'import { createToolsServer } from "../tools-mcp/server"',
    ],
    ["packages/proxy/acp/example.ts", 'import "../../tools-mcp/cli"'],
    ["packages/tools-mcp/example.ts", 'import { cn } from "@/lib/utils"'],
    ["packages/tools-mcp/example.ts", 'import "../../src/main"'],
    [
      "packages/tools-mcp/views/example.tsx",
      'import { Button } from "@/components/ui/button"',
    ],
    [
      "packages/tools-mcp/example.ts",
      'import { runProxyCli } from "../proxy/cli"',
    ],
    [
      "packages/tools-mcp/example.ts",
      'import { redactForLog } from "../proxy/redaction"',
    ],
  ])(
    "keeps the tools MCP server apart from browser and proxy code: %s %s",
    async (filePath, code) => {
      expect(await restrictedImportErrors(filePath, code)).toHaveLength(1)
    }
  )

  it("lets the tools MCP server import shared contracts", async () => {
    expect(
      await restrictedImportErrors(
        "packages/tools-mcp/example.ts",
        'import { presentationToolDefinitions } from "../../shared/presentation/tools"'
      )
    ).toEqual([])
  })

  it.each(["vite.config.ts", "shared/example.ts"])(
    "enforces the package seam for non-UI consumers in %s",
    async (filePath) => {
      expect(
        await boundaryErrors(
          filePath,
          'const adapter = import("@/runtime-adapters/aos/composition")'
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
        'import { AosRemoteClient } from "@/runtime-adapters/aos/aos-client"'
      )
    ).toHaveLength(1)
  })
})
