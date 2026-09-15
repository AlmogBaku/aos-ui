export const FIXTURE_SLASH_COMMANDS = [
  { name: "help", description: "Show fixture runtime help" },
  { name: "status", description: "Show fixture Session status" },
] as const

export function fixtureSlashCommand(text: string) {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/u.exec(text)
  if (!match || !FIXTURE_SLASH_COMMANDS.some(({ name }) => name === match[1]))
    return undefined
  const args = match[2]?.trim() ?? ""
  return match[1] === "help"
    ? `Fixture commands: /help and /status.${args ? ` Arguments: ${args}` : ""}`
    : "The fixture Session is ready."
}
