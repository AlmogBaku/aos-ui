import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { format } from "prettier"
import { presentationCatalog } from "../shared/presentation/tools"
import {
  buildProviderInstructions,
  hermesHarnessCapabilities,
} from "../shared/presentation/manifests"

const root = fileURLToPath(new URL("../", import.meta.url))
const generated = resolve(root, "integrations/hermes/aos_hermes/_generated")
await mkdir(generated, { recursive: true })
await writeFile(
  resolve(generated, "presentation.json"),
  JSON.stringify(
    {
      tools: presentationCatalog(),
      instructions: buildProviderInstructions(hermesHarnessCapabilities),
    },
    null,
    2
  ) + "\n"
)
await writeFile(
  resolve(generated, "agent-creator.md"),
  await readFile(resolve(root, "shared/agent-creator/SKILL.md"))
)
await writeFile(
  resolve(generated, "invite-link.md"),
  await readFile(resolve(root, "shared/invite-link/SKILL.md"))
)
console.log(
  "Generated portable Hermes presentation, creator, and invite assets"
)
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
const inviteLinkSkill = await readFile(
  resolve(root, "shared/invite-link/SKILL.md"),
  "utf8"
)
await writeFile(
  resolve(root, "integrations/opencode/invite-link.generated.ts"),
  await format(
    `// Generated from shared/invite-link/SKILL.md by scripts/build-integrations.ts.\nexport const inviteLinkSkill = ${JSON.stringify(inviteLinkSkill)}\n`,
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
