import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { format } from "prettier"
import { presentationCatalog } from "../shared/presentation/tools"
import {
  buildProviderInstructions,
  openCodeHarnessCapabilities,
} from "../shared/presentation/manifests"

const root = fileURLToPath(new URL("../", import.meta.url))
const generated = resolve(root, "integrations/hermes/aos_hermes/_generated")
await mkdir(generated, { recursive: true })
await writeFile(
  resolve(generated, "presentation.json"),
  JSON.stringify(
    {
      tools: presentationCatalog(),
      instructions: buildProviderInstructions({
        ...openCodeHarnessCapabilities,
        askUserQuestionTool: undefined,
      }),
    },
    null,
    2
  ) + "\n"
)
await writeFile(
  resolve(generated, "agent-creator.md"),
  await readFile(resolve(root, "shared/agent-creator/SKILL.md"))
)
console.log("Generated portable Hermes presentation and creator assets")
const creatorSkill = await readFile(
  resolve(root, "shared/agent-creator/SKILL.md"),
  "utf8"
)
await writeFile(
  resolve(root, "integrations/opencode/creator-skill.generated.ts"),
  await format(
    `// Generated from shared/agent-creator/SKILL.md by scripts/build-integrations.ts.\nexport const agentCreatorSkill = ${JSON.stringify(creatorSkill)}\n`,
    { parser: "typescript", semi: false, trailingComma: "es5", printWidth: 80 }
  )
)
const build = await Bun.build({
  entrypoints: [resolve(root, "integrations/opencode/plugin.ts")],
  outdir: resolve(root, "integrations/opencode/dist"),
  naming: "aos-ui-plugin.js",
  target: "bun",
  format: "esm",
})
if (!build.success)
  throw new AggregateError(build.logs, "OpenCode integration build failed")
