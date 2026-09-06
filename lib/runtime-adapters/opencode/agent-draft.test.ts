import { describe, expect, it } from "vitest"

import {
  createAgentDraftMetadata,
  draftAgentId,
  draftIcon,
  nextAgentDraftMetadata,
  projectAgentDraft,
  readAgentDraftMetadata,
  readDraftThreadId,
} from "./agent-draft"

describe("OpenCode Agent draft projection", () => {
  it("accepts only versioned nested metadata", () => {
    const draft = createAgentDraftMetadata()
    expect(readAgentDraftMetadata({ aos_ui: draft })).toEqual(draft)
    expect(readAgentDraftMetadata(draft)).toBeUndefined()
    expect(
      readAgentDraftMetadata({ aos_ui: { ...draft, version: 2 } })
    ).toBeUndefined()
  })

  it("projects a persistent provisional Agent independent of age", () => {
    const projected = projectAgentDraft(
      "thread-old",
      createAgentDraftMetadata()
    )
    expect(projected).toMatchObject({
      kind: "provisional",
      id: "draft:thread-old",
      builderThreadId: "thread-old",
      phase: "interview",
    })
  })

  it("round-trips localized app-created labels in provider metadata", () => {
    const draft = createAgentDraftMetadata({
      draftTitle: "סוכן חדש",
      draftDescription: "יוצרים את הסוכן שלכם",
      firstSessionTitle: "שיחה חדשה",
    })

    expect(readAgentDraftMetadata({ aos_ui: draft })).toEqual(draft)
    expect(projectAgentDraft("thread-he", draft)).toMatchObject({
      name: "סוכן חדש",
      description: "יוצרים את הסוכן שלכם",
    })
  })

  it("excludes promoted and deleted drafts", () => {
    expect(
      projectAgentDraft("thread", {
        ...createAgentDraftMetadata(),
        phase: "promoted",
      })
    ).toBeUndefined()
    expect(
      projectAgentDraft("thread", {
        ...createAgentDraftMetadata(),
        phase: "deleted",
      })
    ).toBeUndefined()
  })

  it("uses reversible projected IDs and deterministic icon tones", () => {
    expect(readDraftThreadId(draftAgentId("thread-1"))).toBe("thread-1")
    expect(draftIcon("thread-1")).toEqual(draftIcon("thread-1"))
    expect(draftIcon("thread-1")).toMatchObject({ symbol: "unassigned" })
  })

  it("increments persisted revisions monotonically", () => {
    expect(
      nextAgentDraftMetadata(createAgentDraftMetadata(), {
        phase: "start-failed",
        lastError: "offline",
      })
    ).toMatchObject({ revision: 2, phase: "start-failed" })
  })

  it("rejects unsafe persisted activation candidates", () => {
    const draft = {
      ...createAgentDraftMetadata(),
      phase: "activating" as const,
      candidate: {
        agentId: "../escape",
        name: "Unsafe",
        description: "Must never be activated",
        callId: "call-1",
      },
    }
    expect(readAgentDraftMetadata({ aos_ui: draft })).toBeUndefined()
  })
})
