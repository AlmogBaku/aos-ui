import { describe, expect, it } from "vitest"

import {
  matchLocalCommand,
  menuSlashCommands,
  resolveLocalCommand,
  type ComposerLocalCommand,
  type LocalCommandResolution,
} from "./composer-features"

const open: ComposerLocalCommand = { name: "new", run: () => {} }
const model: ComposerLocalCommand = {
  name: "model",
  argument: { required: true, hint: "<model>" },
  knownFlags: [{ name: "reasoning", takesValue: true }],
  run: () => {},
}
const branch: ComposerLocalCommand = {
  name: "branch",
  aliases: ["fork"],
  knownFlags: [
    { name: "here", takesValue: false },
    { name: "title", takesValue: true },
  ],
  run: () => {},
}

describe("resolveLocalCommand", () => {
  it.each<[string, string, Omit<LocalCommandResolution, "command">, string]>([
    [
      "hands the trimmed trailing text over as arguments",
      "  /new  plan the launch \n",
      { args: "plan the launch", flags: {}, outcome: "run" },
      "new",
    ],
    [
      "holds back a command whose required argument is missing",
      "/model",
      { args: "", flags: {}, outcome: "missing-argument" },
      "model",
    ],
    [
      "records a flag that takes no value",
      "/branch --here",
      { args: "", flags: { here: true }, outcome: "run" },
      "branch",
    ],
    [
      "gives a flag the word after it as its value",
      "/model --reasoning high sonnet",
      { args: "sonnet", flags: { reasoning: "high" }, outcome: "run" },
      "model",
    ],
    [
      "counts a value flag with no value as a missing argument",
      "/branch --title",
      { args: "", flags: {}, outcome: "missing-argument" },
      "branch",
    ],
    [
      "stops at the first unknown flag",
      "/branch --here --fast name",
      { args: "--fast name", flags: { here: true }, outcome: "unknown-flag" },
      "branch",
    ],
    [
      "matches an alias",
      "/fork notes",
      { args: "notes", flags: {}, outcome: "run" },
      "branch",
    ],
    [
      "matches a name case-insensitively",
      "/MODEL sonnet",
      { args: "sonnet", flags: {}, outcome: "run" },
      "model",
    ],
  ])("%s", (_case, text, expected, name) => {
    expect(resolveLocalCommand(text, [open, model, branch])).toEqual({
      command: [open, model, branch].find((command) => command.name === name),
      ...expected,
    })
  })
})

describe("matchLocalCommand", () => {
  it("leaves other slash commands and prose to the runtime", () => {
    expect(matchLocalCommand("/newer thing", [open])).toBeUndefined()
    expect(matchLocalCommand("/review", [open])).toBeUndefined()
    expect(matchLocalCommand("new session please", [open])).toBeUndefined()
    expect(matchLocalCommand("/new", undefined)).toBeUndefined()
  })
})

describe("menuSlashCommands", () => {
  it("lists local commands first, once each by name with its aliases, and drops a provider namesake of any alias", () => {
    expect(
      menuSlashCommands({
        slashCommands: [
          { name: "New", description: "provider" },
          { name: "Fork", description: "provider" },
          { name: "review", description: "Review the diff" },
        ],
        localCommands: [
          { ...open, description: "Start a new Session" },
          { ...branch, description: "Fork this Session" },
        ],
      })
    ).toEqual([
      { name: "new", description: "Start a new Session" },
      { name: "branch", description: "Fork this Session", aliases: ["fork"] },
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
