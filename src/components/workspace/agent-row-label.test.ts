import { describe, expect, it } from "vitest"

import { attentionLevel } from "@/lib/attention-level"
import { en } from "@/lib/i18n/dictionaries/en"

import { agentRowCopy, agentRowLabel } from "./agent-row-label"

const copy = agentRowCopy(en)
const agent = {
  id: "travel",
  name: "Travel Planner",
  description: "Trip planning",
}

describe("an Agent row's accessible name", () => {
  it.each([
    [
      "states every count, beyond the one color its badge shows",
      {
        ...agent,
        attention: { count: 2, waiting: 1, failed: 0, top: "waiting" },
      },
      false,
      "Travel Planner, Trip planning, 2 unread, 1 waiting for you",
    ],
    [
      "names a run only while nothing is counted",
      { ...agent, attention: attentionLevel([{ status: "running" }]) },
      false,
      "Travel Planner, Trip planning, Running",
    ],
    [
      "drops the run once something is counted, and ends with selection",
      {
        ...agent,
        attention: attentionLevel([
          { status: "running" },
          { status: "failed", unread: true },
        ]),
      },
      true,
      "Travel Planner, Trip planning, 1 unread, 1 failed, Selected Agent",
    ],
    [
      "calls a draft a draft instead of reading out its start time",
      {
        id: "draft:interview",
        name: "New Agent",
        description: "Draft · Sep 5, 2026, 12:00 PM",
        attention: attentionLevel([{ status: "waiting-for-input" }]),
      },
      false,
      "New Agent, draft, 1 unread, 1 waiting for you",
    ],
    [
      "says a muted Agent is muted, beside the count its badge keeps",
      {
        ...agent,
        muted: true,
        attention: { count: 2, waiting: 1, failed: 0, top: "waiting" },
      },
      false,
      "Travel Planner, Trip planning, 2 unread, 1 waiting for you, Notifications muted",
    ],
    [
      "keeps an Agent whose status could not be read saying so",
      { ...agent, status: "unknown", attention: attentionLevel([]) },
      false,
      "Travel Planner, Trip planning, Status unavailable",
    ],
    [
      "says nothing more for an Agent with nothing to report",
      { ...agent, attention: attentionLevel([{ status: "idle" }]) },
      false,
      "Travel Planner, Trip planning",
    ],
  ] as const)("%s", (_rule, row, selected, name) => {
    expect(agentRowLabel(row, selected, copy)).toBe(name)
  })
})
