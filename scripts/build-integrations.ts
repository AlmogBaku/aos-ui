import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { format } from "prettier"

const root = fileURLToPath(new URL("../", import.meta.url))

// The OpenCode launcher installs these shared skill files into the worktree it serves.
for (const [source, target, name] of [
  [
    "shared/agent-creator/SKILL.md",
    "scripts/opencode-creator-skill.generated.ts",
    "agentCreatorSkill",
  ],
  [
    "shared/agent-creator/reference/harness-opencode.md",
    "scripts/opencode-creator-reference.generated.ts",
    "agentCreatorOpenCodeReference",
  ],
  [
    "shared/invite-link/SKILL.md",
    "scripts/opencode-invite-link.generated.ts",
    "inviteLinkSkill",
  ],
] as const) {
  const content = await readFile(resolve(root, source), "utf8")
  await writeFile(
    resolve(root, target),
    await format(
      `// Generated from ${source} by scripts/build-integrations.ts.\nexport const ${name} = ${JSON.stringify(content)}\n`,
      {
        parser: "typescript",
        semi: false,
        trailingComma: "es5",
        printWidth: 80,
      }
    )
  )
}
