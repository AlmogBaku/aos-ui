import type { ReactNode } from "react"
import { useCallback, useState } from "react"

import type { ThreadMessageLike } from "@assistant-ui/react"

import type {
  RuntimeBundle,
  WorkspaceAdapter,
} from "@/runtime-adapters/contracts"
import {
  useFixtureRuntimeBundle,
  type FixtureRuntimeBundleOptions,
} from "@/runtime-adapters/fixture/fixture-runtime"
import {
  createFixtureWorkspace,
  type FixtureWorkspaceOptions,
} from "@/runtime-adapters/fixture/fixture-workspace"

type ControlledWorkspaceFixtureProps = {
  initialThreadId: string
  workspace?: FixtureWorkspaceOptions
  messagesByThread?: Readonly<Record<string, readonly ThreadMessageLike[]>>
  workspaceOverrides?: Partial<WorkspaceAdapter>
  onThreadIdChange?: (threadId: string | undefined) => void
  children: (bundle: RuntimeBundle) => ReactNode
}

/**
 * A deliberately small test-only workspace. Tests opt into rich messages
 * explicitly, so ordinary lifecycle coverage cannot accidentally depend on
 * the public fixture's prose, artifacts, or chart renderer.
 */
export function ControlledWorkspaceFixture({
  initialThreadId,
  workspace: workspaceOptions,
  messagesByThread = {},
  workspaceOverrides,
  onThreadIdChange,
  children,
}: ControlledWorkspaceFixtureProps) {
  const [threadId, setThreadId] = useState<string | undefined>(initialThreadId)
  const [workspace] = useState(() =>
    createFixtureWorkspace({
      clock: () => new Date("2026-09-03T12:00:00.000Z"),
      enableAgentCreator: false,
      ...workspaceOptions,
    })
  )
  const changeThreadId = useCallback(
    (nextThreadId: string | undefined) => {
      setThreadId(nextThreadId)
      onThreadIdChange?.(nextThreadId)
    },
    [onThreadIdChange]
  )
  const fixture = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: changeThreadId,
    streamDelayMs: 0,
    testOnly: {
      workspace,
      messagesForThread: (id) =>
        messagesByThread[id] ?? [
          {
            id: `${id}-user`,
            role: "user",
            content: "Test request",
          },
          {
            id: `${id}-assistant`,
            role: "assistant",
            content: "Test response",
          },
        ],
    },
  } satisfies FixtureRuntimeBundleOptions)

  const bundle: RuntimeBundle = workspaceOverrides
    ? {
        ...fixture,
        workspace: Object.assign(
          Object.create(fixture.workspace),
          workspaceOverrides
        ) as WorkspaceAdapter,
      }
    : fixture

  return <>{children(bundle)}</>
}
