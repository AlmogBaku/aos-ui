import type { WorkspaceActivityEvent } from "../contracts"

export const fixtureActivityScenarioNames = [
  "run-completed",
  "run-failed",
  "question",
  "permission",
  "resolution",
  "agent-ready",
  "agent-activation-failed",
  "duplicates",
  "stale-target",
  "delayed-non-selected",
] as const

export type FixtureActivityScenarioName =
  (typeof fixtureActivityScenarioNames)[number]

const activityScenarios: Record<
  FixtureActivityScenarioName,
  readonly WorkspaceActivityEvent[]
> = {
  "run-completed": [
    {
      id: "fixture:run:aster-market:completed:started",
      agentId: "agent-aster",
      threadId: "thread-aster-market",
      occurredAt: "2026-09-03T12:01:00.000Z",
      type: "run-started",
      lifecycleId: "fixture:run:aster-market:completed",
    },
    {
      id: "fixture:run:aster-market:completed:finished",
      agentId: "agent-aster",
      threadId: "thread-aster-market",
      occurredAt: "2026-09-03T12:02:00.000Z",
      type: "run-finished",
      lifecycleId: "fixture:run:aster-market:completed",
    },
  ],
  "run-failed": [
    {
      id: "fixture:run:nori-copy:failed:started",
      agentId: "agent-nori",
      threadId: "thread-nori-copy",
      occurredAt: "2026-09-03T12:03:00.000Z",
      type: "run-started",
      lifecycleId: "fixture:run:nori-copy:failed",
    },
    {
      id: "fixture:run:nori-copy:failed:terminal",
      agentId: "agent-nori",
      threadId: "thread-nori-copy",
      occurredAt: "2026-09-03T12:04:00.000Z",
      type: "run-failed",
      lifecycleId: "fixture:run:nori-copy:failed",
    },
  ],
  question: [
    {
      id: "fixture:attention:lumen-roadmap:question:requested",
      agentId: "agent-lumen",
      threadId: "thread-lumen-roadmap",
      occurredAt: "2026-09-03T12:05:00.000Z",
      type: "attention-requested",
      attentionKind: "question",
      requestId: "fixture-question-roadmap",
    },
  ],
  permission: [
    {
      id: "fixture:attention:aster-launch:permission:requested",
      agentId: "agent-aster",
      threadId: "thread-aster-launch",
      occurredAt: "2026-09-03T12:06:00.000Z",
      type: "attention-requested",
      attentionKind: "permission",
      requestId: "fixture-permission-launch",
    },
  ],
  resolution: [
    {
      id: "fixture:attention:lumen-roadmap:question:resolved",
      agentId: "agent-lumen",
      threadId: "thread-lumen-roadmap",
      occurredAt: "2026-09-03T12:07:00.000Z",
      type: "attention-resolved",
      requestId: "fixture-question-roadmap",
    },
  ],
  "agent-ready": [
    {
      id: "fixture:agent:mica:ready",
      agentId: "agent-mica",
      threadId: "thread-mica-quarterly",
      occurredAt: "2026-09-03T12:08:00.000Z",
      type: "agent-ready",
    },
  ],
  "agent-activation-failed": [
    {
      id: "fixture:agent:nori:activation-failed",
      agentId: "agent-nori",
      threadId: "thread-nori-copy",
      occurredAt: "2026-09-03T12:09:00.000Z",
      type: "agent-activation-failed",
    },
  ],
  duplicates: [
    {
      id: "fixture:duplicate:started",
      agentId: "agent-aster",
      threadId: "thread-aster-launch",
      occurredAt: "2026-09-03T12:10:00.000Z",
      type: "run-started",
      lifecycleId: "fixture:duplicate:lifecycle",
    },
    {
      id: "fixture:duplicate:finished",
      agentId: "agent-aster",
      threadId: "thread-aster-launch",
      occurredAt: "2026-09-03T12:10:30.000Z",
      type: "run-finished",
      lifecycleId: "fixture:duplicate:lifecycle",
    },
    {
      id: "fixture:duplicate:finished",
      agentId: "agent-aster",
      threadId: "thread-aster-launch",
      occurredAt: "2026-09-03T12:10:30.000Z",
      type: "run-finished",
      lifecycleId: "fixture:duplicate:lifecycle",
    },
  ],
  "stale-target": [
    {
      id: "fixture:stale-target:started",
      agentId: "agent-deleted",
      threadId: "thread-deleted",
      occurredAt: "2026-09-03T12:10:45.000Z",
      type: "run-started",
      lifecycleId: "fixture:stale-target:lifecycle",
    },
    {
      id: "fixture:stale-target:finished",
      agentId: "agent-deleted",
      threadId: "thread-deleted",
      occurredAt: "2026-09-03T12:11:00.000Z",
      type: "run-finished",
      lifecycleId: "fixture:stale-target:lifecycle",
    },
  ],
  "delayed-non-selected": [
    {
      id: "fixture:delayed:mica-quarterly:started",
      agentId: "agent-mica",
      threadId: "thread-mica-quarterly",
      occurredAt: "2026-09-03T12:12:00.000Z",
      type: "run-started",
      lifecycleId: "fixture:delayed:mica-quarterly",
    },
    {
      id: "fixture:delayed:mica-quarterly:finished",
      agentId: "agent-mica",
      threadId: "thread-mica-quarterly",
      occurredAt: "2026-09-03T12:13:00.000Z",
      type: "run-finished",
      lifecycleId: "fixture:delayed:mica-quarterly",
    },
  ],
}

export function buildFixtureActivityScenario(
  name: FixtureActivityScenarioName
): WorkspaceActivityEvent[] {
  return structuredClone([...activityScenarios[name]])
}
