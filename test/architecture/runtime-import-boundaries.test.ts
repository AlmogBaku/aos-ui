// @vitest-environment node
import { spawnSync } from "node:child_process"
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"

import { productionSources } from "../support/production-sources"

interface LintCase {
  path: string
  code: string
}

const lintCases: LintCase[] = []
let findings = new Map<LintCase, string[]>()

/** Registers code to lint as if it sat at `path`; the run happens before the tests. */
function lintCase(path: string, code: string): LintCase {
  const entry = { path, code }
  lintCases.push(entry)
  return entry
}

/**
 * Lints every case in one Oxlint run over a scratch copy of the lint setup:
 * the real config and rules, and the runtime package directories the boundary
 * rule reads. Nothing is written into the repository, so a case may name a
 * file that exists there. A case whose path an earlier case took gets a
 * numbered sibling, which matches the same globs and resolves the same
 * relative imports.
 */
async function lintAll(cases: readonly LintCase[]) {
  const root = await mkdtemp(join(tmpdir(), "aos-lint-"))
  try {
    await cp(".oxlintrc.json", join(root, ".oxlintrc.json"))
    await cp("scripts/lint-rules.mjs", join(root, "scripts/lint-rules.mjs"))
    await symlink(resolve("node_modules"), join(root, "node_modules"))
    const runtimeRoot = join("src", "runtime-adapters")
    for (const entry of await readdir(runtimeRoot, { withFileTypes: true }))
      if (entry.isDirectory())
        await mkdir(join(root, runtimeRoot, entry.name), { recursive: true })

    const files = new Map<string, LintCase>()
    for (const entry of cases) {
      const file = files.has(entry.path)
        ? join(
            dirname(entry.path),
            basename(entry.path).replace(
              /^[^.]*/u,
              (stem) => `${stem}-${files.size}`
            )
          )
        : entry.path
      files.set(file, entry)
      await mkdir(join(root, dirname(file)), { recursive: true })
      await writeFile(join(root, file), entry.code)
    }

    const run = spawnSync(
      resolve("node_modules/.bin/oxlint"),
      ["--format", "json", ...files.keys()],
      { cwd: root, encoding: "utf8" }
    )
    // Oxlint exits 1 when it reports an error; anything else is a failed run.
    if (run.status !== 0 && run.status !== 1)
      throw new Error(`oxlint failed: ${run.stderr}`)
    const report: {
      number_of_files: number
      diagnostics: { filename: string; code: string }[]
    } = JSON.parse(run.stdout)
    if (report.number_of_files !== cases.length)
      throw new Error(
        `oxlint linted ${report.number_of_files} of ${cases.length} cases`
      )

    const result = new Map<LintCase, string[]>(
      cases.map((entry) => [entry, []])
    )
    for (const { filename, code } of report.diagnostics) {
      const entry = files.get(filename)
      if (!entry)
        throw new Error(`oxlint reported an unknown file: ${filename}`)
      result.get(entry)?.push(code)
    }
    return result
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** The rules Oxlint reported for a case, one entry per finding. */
function reported(entry: LintCase) {
  const codes = findings.get(entry)
  if (!codes) throw new Error(`${entry.path} was not linted`)
  return codes
}

const boundaryErrors = (entry: LintCase) =>
  reported(entry).filter((code) => code === "aos(runtime-package-boundaries)")
const restrictedImportErrors = (entry: LintCase) =>
  reported(entry).filter((code) => code === "eslint(no-restricted-imports)")

/** The server-only SDK entry, which browser code never imports. */
const SERVER_ONLY_IMPORT =
  'import { artifactFileId } from "@harness-gw/sdk/node"'

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
    findings = await lintAll(lintCases)
  })

  it.each(
    [
      'import { runtimeAdapter } from "@/runtime-adapters/aos/composition"',
      'export { AosRemoteClient } from "../runtime-adapters/aos/aos-client"',
      'export * from "@/runtime-adapters/aos/aos-client"',
      'const adapter = import("@/runtime-adapters/aos/composition")',
      'type Client = import("@/runtime-adapters/aos/aos-client").AosRemoteClient',
      'const adapter = import("../runtime-adapters/aos/../aos/composition")',
      "const adapter = import(`@/runtime-adapters/aos/composition`)",
      'const adapter = require("@/runtime-adapters/aos/composition")',
    ].map((code) => lintCase("src/components/example.tsx", code))
  )("rejects production access to provider internals: $code", (entry) => {
    expect(boundaryErrors(entry)).toHaveLength(1)
  })

  it.each(
    [
      'import { runtimeAdapter } from "../aos"',
      'import { runtimeAdapter } from "@/runtime-adapters/aos"',
      'const adapter = import("../aos/index.ts")',
      'import type { AosRemoteClient } from "../aos/aos-client"',
    ].map((code) => lintCase("src/runtime-adapters/fixture/example.ts", code))
  )("rejects imports between provider packages: $code", (entry) => {
    expect(boundaryErrors(entry)).toHaveLength(1)
  })

  it.each(
    [
      'import { runtimeAdapter } from "@/runtime-adapters/aos"',
      'import { runtimeAdapter } from "../runtime-adapters/aos/index"',
      'const adapter = import("../runtime-adapters/aos/index.ts")',
    ].map((code) => lintCase("src/components/example.tsx", code))
  )("allows consumers to use public package indexes: $code", (entry) => {
    expect(boundaryErrors(entry)).toEqual([])
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

    // The browser speaks ACP v2 to the gateway and the gateway owns its own run
    // vocabulary, so no AG-UI package belongs anywhere in the repository.
    expect(importers).toEqual([])
  })

  const ownPackageImport = lintCase(
    "src/runtime-adapters/aos/example.ts",
    'import { AosRemoteClient } from "./aos-client"'
  )
  it("allows internal imports inside the owning package", () => {
    expect(boundaryErrors(ownPackageImport)).toEqual([])
  })

  it.each(
    [
      [
        "src/components/example.tsx",
        'import "../../packages/tools-mcp/server"',
      ],
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
      ...[
        "src/components/example.tsx",
        "src/runtime-adapters/aos/acp/example.ts",
        "packages/tools-mcp/views/example.tsx",
        "shared/example.ts",
      ].map((path) => [path, SERVER_ONLY_IMPORT]),
    ].map(([path, code]) => lintCase(path, code))
  )(
    "keeps each package out of code it must not import: $path $code",
    (entry) => {
      expect(restrictedImportErrors(entry)).toHaveLength(1)
    }
  )

  it.each(
    [
      [
        "packages/tools-mcp/example.ts",
        'import { presentationToolDefinitions } from "../../shared/presentation/tools"',
      ],
      // The server computes stable origin keys and fileIds; a test may check a
      // literal against them.
      ["packages/tools-mcp/example.ts", SERVER_ONLY_IMPORT],
      ["src/runtime-adapters/fixture/example.test.ts", SERVER_ONLY_IMPORT],
      ["packages/tools-mcp/views/example.test.tsx", SERVER_ONLY_IMPORT],
    ].map(([path, code]) => lintCase(path, code))
  )("allows the sanctioned package imports: $path $code", (entry) => {
    expect(restrictedImportErrors(entry)).toEqual([])
  })

  it.each(
    ["vite.config.ts", "shared/example.ts"].map((path) =>
      lintCase(
        path,
        'const adapter = import("@/runtime-adapters/aos/composition")'
      )
    )
  )("enforces the package seam for non-UI consumers in $path", (entry) => {
    expect(boundaryErrors(entry)).toHaveLength(1)
  })

  const documentedFixtureTest = lintCase(
    "src/components/test-utils/controlled-workspace-fixture.tsx",
    'import { useFixtureRuntimeBundle } from "@/runtime-adapters/fixture/fixture-runtime"'
  )
  const arbitraryFixtureTest = lintCase(
    "src/components/example.test.tsx",
    'import { useFixtureRuntimeBundle } from "@/runtime-adapters/fixture/fixture-runtime"'
  )
  const documentedTestOtherProvider = lintCase(
    "src/components/aos-ui-workspace.test-helpers.tsx",
    'import { AosRemoteClient } from "@/runtime-adapters/aos/aos-client"'
  )
  it("allows only documented fixture-test access, not arbitrary tests or other providers", () => {
    expect(boundaryErrors(documentedFixtureTest)).toEqual([])
    expect(boundaryErrors(arbitraryFixtureTest)).toHaveLength(1)
    expect(boundaryErrors(documentedTestOtherProvider)).toHaveLength(1)
  })

  // A floating promise (no await, return, or catch) and a misused promise
  // (async function passed where a void-return callback is expected) must both
  // be flagged by the type-aware rules enabled for the web server and the
  // browser runtime adapters.
  const promiseMisuse = lintCase(
    "src/runtime-adapters/aos/example.ts",
    `
      async function doWork(): Promise<void> {}
      doWork()
      function run(cb: () => void) { cb() }
      run(async () => { await doWork() })
    `
  )
  it("reports no-floating-promises and no-misused-promises on a virtual browser adapter file", () => {
    expect(reported(promiseMisuse)).toContain(
      "typescript(no-floating-promises)"
    )
    expect(reported(promiseMisuse)).toContain("typescript(no-misused-promises)")
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
