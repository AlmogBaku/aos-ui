import {
  AssistantRuntimeProvider,
  type AttachmentAdapter,
  type AssistantRuntime,
  type ChatModelAdapter,
  type ThreadMessage,
  type ThreadMessageLike,
  useAuiState,
  useExternalStoreRuntime,
  useLocalRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react"
import { cleanup, fireEvent, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useImperativeHandle, useMemo, useState, type Ref } from "react"
import { createPortal } from "react-dom"
import { vi } from "vitest"
import {
  Thread,
  type ThreadComponents,
  type ThreadComposerOverrideProps,
  type ThreadLabels,
} from "./thread.aui"
import {
  RichToolRenderer,
  ToolUiLocaleProvider,
  type ToolUiLocale,
} from "@/components/tool-ui"
import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"
import {
  threadHistoryExtras,
  type ThreadHistoryState,
} from "@/runtime-adapters/thread-history"

const TOUCH_PRIMARY_QUERY = "(pointer: coarse) and (not (any-pointer: fine))"
const matchMediaDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "matchMedia"
)

export function setTouchPrimary(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: query === TOUCH_PRIMARY_QUERY ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    }),
  })
}

/** Restores what a test changed: the DOM and the pointer media query. */
export function resetThreadTestEnvironment() {
  cleanup()
  if (matchMediaDescriptor) {
    Object.defineProperty(window, "matchMedia", matchMediaDescriptor)
  } else {
    Reflect.deleteProperty(window, "matchMedia")
  }
}

export const TURN_TIMING = {
  streamStartTime: Date.parse("2026-09-03T09:11:31.000Z"),
  totalStreamTime: 29_000,
  totalChunks: 48,
  toolCallCount: 3,
}

export const INITIAL_MESSAGES = [
  {
    id: "message-user",
    role: "user" as const,
    content: [
      { type: "text" as const, text: "Review this image" },
      {
        type: "image" as const,
        image:
          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
        filename: "reference.svg",
      },
    ],
  },
  {
    id: "message-assistant",
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "The reference is ready." }],
  },
]

/** A run that parks until the runtime aborts it, so a cancel is observable. */
export function parkedRun(stop: () => void): ChatModelAdapter {
  return {
    async *run({ abortSignal }) {
      yield { content: [{ type: "text", text: "Waiting on native run" }] }
      await new Promise<void>((resolve) =>
        abortSignal.addEventListener(
          "abort",
          () => {
            stop()
            resolve()
          },
          { once: true }
        )
      )
    },
  }
}

/** Sends one message through `parkedRun` and returns the composer input. */
export async function startParkedRun(user: ReturnType<typeof userEvent.setup>) {
  const input = await screen.findByRole("textbox", { name: "Message input" })
  await user.type(input, "Run")
  await user.click(screen.getByRole("button", { name: "Send message" }))
  await screen.findByText("Waiting on native run")
  return input
}

/**
 * Two overlays with the same dialog role: one inside the Thread, one whose DOM
 * leaves it through a portal while its React events still bubble to the
 * viewport.
 */
export function OverlayComposer({ fallback }: ThreadComposerOverrideProps) {
  return (
    <>
      {fallback}
      <div role="dialog" aria-label="Inline overlay" />
      {createPortal(
        <div role="dialog" aria-label="Portaled overlay" />,
        document.body
      )}
    </>
  )
}

export function messageText(message: ThreadMessage | ThreadMessageLike) {
  const content =
    typeof message.content === "string"
      ? [{ type: "text" as const, text: message.content }]
      : message.content
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
}

export function LocalThread({
  labels,
  direction,
  model = { run: async () => ({ content: [] }) },
  exposeRuntime,
  initialMessages = INITIAL_MESSAGES,
  toolFallback,
  composer,
  composerFeatures,
  enableMessageQueue = false,
  attachmentAdapter,
  messageRewind,
  locale,
}: {
  labels?: Partial<ThreadLabels>
  direction?: "ltr" | "rtl"
  locale?: ToolUiLocale
  model?: ChatModelAdapter
  exposeRuntime?: (runtime: AssistantRuntime) => void
  initialMessages?: readonly ThreadMessageLike[]
  toolFallback?: typeof RichToolRenderer
  composer?: ThreadComponents["Composer"]
  composerFeatures?: ComposerFeatureViewModel
  enableMessageQueue?: boolean
  attachmentAdapter?: AttachmentAdapter
  messageRewind?:
    | false
    | {
        runConfig(sourceUserId: string): {
          custom: Record<string, unknown>
        }
      }
}) {
  const runtime = useLocalRuntime(model, {
    initialMessages,
    unstable_enableMessageQueue: enableMessageQueue,
    unstable_queueClearOnCancel: false,
    adapters: attachmentAdapter
      ? { attachments: attachmentAdapter }
      : undefined,
  })
  exposeRuntime?.(runtime)

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ToolUiLocaleProvider locale={locale}>
        <Thread
          labels={labels}
          direction={direction}
          autoFocus={false}
          composerFeatures={composerFeatures}
          components={{ ToolFallback: toolFallback, Composer: composer }}
          messageRewind={messageRewind}
        />
      </ToolUiLocaleProvider>
    </AssistantRuntimeProvider>
  )
}

export type PagedThreadHandle = {
  prepend(older: readonly ThreadMessageLike[]): void
  /** Replaces the latest message's text, as a streaming turn grows it. */
  stream(text: string): void
}

export function historyState(
  overrides: Partial<ThreadHistoryState> = {}
): ThreadHistoryState & { loadOlder: ReturnType<typeof vi.fn> } {
  return {
    hasOlder: true,
    truncated: false,
    loading: false,
    failed: false,
    loadOlder: vi.fn(async () => {}),
    ...overrides,
  } as ThreadHistoryState & { loadOlder: ReturnType<typeof vi.fn> }
}

export function olderMessages(count: number): ThreadMessageLike[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `older-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `Older message ${index}` }],
  }))
}

const asMessage = (message: ThreadMessageLike) => message

/**
 * An external-store thread whose older history the test controls: it offers
 * the given history state and prepends the pages the test hands it.
 */
export function PagedThread({
  initialMessages,
  history,
  labels,
  running = false,
  ref,
}: {
  initialMessages: readonly ThreadMessageLike[]
  history?: ThreadHistoryState
  labels?: Partial<ThreadLabels>
  running?: boolean
  ref?: Ref<PagedThreadHandle>
}) {
  const [messages, setMessages] = useState(initialMessages)
  const extras = useMemo(
    () =>
      history === undefined
        ? undefined
        : threadHistoryExtras.provide({ history }),
    [history]
  )
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: asMessage,
    onNew: async () => {},
    isRunning: running,
    extras,
  })
  useImperativeHandle(ref, () => ({
    prepend: (older) => setMessages((current) => [...older, ...current]),
    stream: (text) =>
      setMessages((current) => {
        const latest = current.at(-1)
        return latest
          ? [
              ...current.slice(0, -1),
              { ...latest, content: [{ type: "text", text }] },
            ]
          : current
      }),
  }))
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread autoFocus={false} labels={labels} />
    </AssistantRuntimeProvider>
  )
}

const MULTI_SESSION_MESSAGES: Record<string, readonly ThreadMessageLike[]> = {
  "session-one": [],
  "session-two": [
    {
      id: "session-two-history",
      role: "user",
      content: [{ type: "text", text: "Session two history" }],
    },
  ],
}

const multiSessionAdapter = {
  list: async () => ({
    threads: ["session-one", "session-two"].map((remoteId) => ({
      remoteId,
      status: "regular" as const,
    })),
  }),
  fetch: async (remoteId: string) => ({
    remoteId,
    status: "regular" as const,
  }),
  initialize: async (threadId: string) => ({
    remoteId: threadId,
  }),
  rename: async () => undefined,
  updateCustom: async () => undefined,
  archive: async () => undefined,
  unarchive: async () => undefined,
  delete: async () => undefined,
  generateTitle: async () =>
    new ReadableStream({
      start(controller) {
        controller.close()
      },
    }),
}

export function MultiSessionThread({
  exposeRuntime,
}: {
  exposeRuntime?: (runtime: AssistantRuntime) => void
}) {
  const runtime = useRemoteThreadListRuntime({
    adapter: multiSessionAdapter,
    initialThreadId: "session-one",
    runtimeHook: useMultiSessionRuntime,
  })
  exposeRuntime?.(runtime)
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread autoFocus={false} />
    </AssistantRuntimeProvider>
  )
}

/*
 * Keep the runtime hook named so eslint can verify that the hooks it calls
 * follow the Rules of Hooks. The remote runtime invokes it inside a thread
 * scope, where threadListItem.remoteId is available.
 */
function useMultiSessionRuntime() {
  const threadId = useAuiState((state) => state.threadListItem.remoteId)
  return useLocalRuntime(
    { run: async () => ({ content: [] }) },
    { initialMessages: MULTI_SESSION_MESSAGES[threadId ?? "session-one"] }
  )
}

/** A right click lands wherever the reader pressed, inside the message. */
export async function openMessageMenu(text: string) {
  fireEvent.contextMenu(await screen.findByText(text), {
    clientX: 24,
    clientY: 48,
  })
  return screen.findByRole("menu")
}
