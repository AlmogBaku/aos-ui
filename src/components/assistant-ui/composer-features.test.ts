import { describe, expect, it } from "vitest"

import {
  matchLocalCommand,
  menuSlashCommands,
  type ComposerLocalCommand,
} from "./composer-features"

const open: ComposerLocalCommand = { name: "new", run: () => {} }

describe("matchLocalCommand", () => {
  it("matches the command alone, case-insensitively, with surrounding space", () => {
    expect(matchLocalCommand("  /New \n", [open])).toEqual({
      command: open,
      args: "",
    })
  })

  it("hands the trimmed rest of the draft to the command as arguments", () => {
    expect(matchLocalCommand("/new  plan the launch ", [open])?.args).toBe(
      "plan the launch"
    )
  })

  it("leaves other slash commands and prose to the runtime", () => {
    expect(matchLocalCommand("/newer thing", [open])).toBeUndefined()
    expect(matchLocalCommand("/review", [open])).toBeUndefined()
    expect(matchLocalCommand("new session please", [open])).toBeUndefined()
    expect(matchLocalCommand("/new", undefined)).toBeUndefined()
  })
})

describe("menuSlashCommands", () => {
  it("lists local commands first and drops a provider namesake", () => {
    expect(
      menuSlashCommands({
        slashCommands: [
          { name: "New", description: "provider" },
          { name: "review", description: "Review the diff" },
        ],
        localCommands: [{ ...open, description: "Start a new Session" }],
      })
    ).toEqual([
      { name: "new", description: "Start a new Session" },
      { name: "review", description: "Review the diff" },
    ])
  })

  it("hides an unavailable local command yet keeps shadowing its provider namesake", () => {
    expect(
      menuSlashCommands({
        slashCommands: [
          { name: "new", description: "provider" },
          { name: "review", description: "Review the diff" },
        ],
        localCommands: [{ ...open, available: false }],
      })
    ).toEqual([{ name: "review", description: "Review the diff" }])
  })
})
