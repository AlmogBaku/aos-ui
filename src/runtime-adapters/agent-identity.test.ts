import { describe, expect, it } from "vitest"
import { getAgentCreator, isRosterAgent } from "./agent-identity"
import type { AgentSummary } from "./contracts"

const agent: AgentSummary = { kind: "ready", id: "native", name: "Native" }

describe("native Agent identity", () => {
  it("does not infer a creator from its name", () => {
    expect(getAgentCreator([{ ...agent, id: "agent-builder" }])).toBeUndefined()
  })
  it("derives the creator from native metadata", () => {
    const creator = {
      ...agent,
      role: "creator" as const,
      visibility: "hidden" as const,
    }
    expect(getAgentCreator([agent, creator])).toBe(creator)
    expect(isRosterAgent(creator)).toBe(false)
  })
  it("rejects ambiguous creator configuration", () => {
    expect(() =>
      getAgentCreator([
        { ...agent, role: "creator" },
        { ...agent, id: "another", role: "creator" },
      ])
    ).toThrow("Multiple creator Agents")
  })
  it("keeps hidden identities out of the roster without discarding them", () => {
    expect(isRosterAgent(agent)).toBe(true)
    expect(isRosterAgent({ ...agent, visibility: "hidden" })).toBe(false)
    expect(isRosterAgent({ ...agent, role: "creator" })).toBe(false)
  })
})
