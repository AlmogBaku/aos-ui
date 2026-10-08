// @vitest-environment node
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { ESLint } from "eslint"
import { beforeAll, describe, expect, it } from "vitest"

import { productionSources } from "../support/production-sources"

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

/** Block comments, and line comments that start a line or follow whitespace. */
function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|\s)\/\/.*$/gmu, "$1")
}

const RUNTIME_NAME_LITERAL =
  /["'`][^"'`\n]*(?:hermes|openclaw|opencode)[^"'`\n]*["'`]/iu

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
    ["packages/tools-mcp/example.ts", 'import { cn } from "@/lib/utils"'],
    ["packages/tools-mcp/example.ts", 'import "../../src/main"'],
    [
      "packages/tools-mcp/views/example.tsx",
      'import { Button } from "@/components/ui/button"',
    ],
    [
      "src/runtime-adapters/aos/acp/example.ts",
      'import { Button } from "@/components/ui/button"',
    ],
  ])(
    "keeps each package out of code it must not import: %s %s",
    async (filePath, code) => {
      expect(await restrictedImportErrors(filePath, code)).toHaveLength(1)
    }
  )

  it.each([
    [
      "packages/tools-mcp/example.ts",
      'import { presentationToolDefinitions } from "../../shared/presentation/tools"',
    ],
  ])("allows the sanctioned package imports: %s %s", async (filePath, code) => {
    expect(await restrictedImportErrors(filePath, code)).toEqual([])
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
        "src/components/aos-ui-workspace.test-helpers.tsx",
        'import { AosRemoteClient } from "@/runtime-adapters/aos/aos-client"'
      )
    ).toHaveLength(1)
  })
  it("reports no-floating-promises and no-misused-promises on a virtual browser adapter file", async () => {
    // A floating promise (no await, return, or catch) and a misused promise
    // (async function passed where a void-return callback is expected) must both
    // be flagged by the type-aware rules enabled for the web server and the
    // browser runtime adapters.
    const code = `
      async function doWork(): Promise<void> {}
      doWork()
      function run(cb: () => void) { cb() }
      run(async () => { await doWork() })
    `
    const [result] = await eslint.lintText(code, {
      filePath: "src/runtime-adapters/aos/example.ts",
    })
    const ruleIds = result!.messages.map(({ ruleId }) => ruleId)
    expect(ruleIds).toContain("@typescript-eslint/no-floating-promises")
    expect(ruleIds).toContain("@typescript-eslint/no-misused-promises")
  })

  it("keeps runtime vocabulary out of the browser outside the fixture", async () => {
    const fixtureRoot = join("src", "runtime-adapters", "fixture")
    const files = (await productionSources("src")).filter(
      ([path]) => !path.startsWith(fixtureRoot)
    )
    expect(files.length).toBeGreaterThan(0)

    for (const [path, text] of files) {
      expect(
        stripComments(text).match(RUNTIME_NAME_LITERAL)?.[0],
        `${path} names a runtime`
      ).toBeUndefined()
    }
  })

  it("keeps provider-native code out of the browser", async () => {
    for (const [path, source] of await productionSources("src")) {
      expect(source, path).not.toMatch(
        /(?:from\s+|import\s*\()["'][^"']*(?:hermes|@opencode-ai\/sdk|@openclaw\/gateway-)[^"']*["']/iu
      )
      expect(source, path).not.toMatch(/\bHermes(?:Rpc|Http|Server|Session)/u)
    }
  })
})
