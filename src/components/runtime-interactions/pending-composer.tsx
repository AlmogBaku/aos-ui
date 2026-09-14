import {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import {
  useAgUiInterrupts,
  useAgUiSubmitInterruptResponses,
  type AgUiInterrupt,
  type AgUiResumeEntry,
} from "@assistant-ui/react-ag-ui"
import type { Locale } from "@/lib/i18n/config"
import type {
  RuntimeInteractionAdapter,
  RuntimeQuestion,
  RuntimeQuestionRequest,
} from "@/runtime-adapters/contracts"
import { RuntimeQuestionComposer } from "./question-composer"

const noop = () => {}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function options(value: unknown) {
  const schema = record(value)
  return Array.isArray(schema?.enum)
    ? schema.enum.flatMap((option) =>
        typeof option === "string" && option.trim() ? [{ label: option }] : []
      )
    : []
}

type InterruptGroup = {
  interrupt: AgUiInterrupt
  offset: number
  count: number
  payload: "answers" | "choice"
}

/**
 * Projects only the public AG-UI interrupt schema into the shared question
 * controls. The inverse projector always produces one response per interrupt.
 */
export function createAgUiInterruptRequest(
  interrupts: readonly AgUiInterrupt[]
) {
  const groups: InterruptGroup[] = []
  const questions: RuntimeQuestion[] = []
  for (const interrupt of interrupts) {
    const schema = record(interrupt.responseSchema)
    const properties = record(schema?.properties)
    const answers = record(properties?.answers)
    const prefixItems = Array.isArray(answers?.prefixItems)
      ? answers.prefixItems
      : undefined
    const offset = questions.length
    if (prefixItems?.length) {
      for (const [index, item] of prefixItems.entries()) {
        const question = record(item)
        questions.push({
          header:
            typeof question?.title === "string"
              ? question.title
              : `Question ${index + 1}`,
          prompt:
            typeof question?.title === "string"
              ? question.title
              : (interrupt.message ?? "Question"),
          options: options(record(question?.items)),
          multiple: question?.maxItems !== 1,
          custom: !options(record(question?.items)).length,
        })
      }
      groups.push({
        interrupt,
        offset,
        count: prefixItems.length,
        payload: "answers",
      })
      continue
    }
    const choices = options(schema)
    questions.push({
      header:
        interrupt.reason === "approval" || interrupt.reason === "confirmation"
          ? "Permission"
          : "Question",
      prompt: interrupt.message ?? "Question",
      options: choices,
      multiple: false,
      custom: choices.length === 0,
    })
    groups.push({
      interrupt,
      offset,
      count: 1,
      payload: schema?.type === "string" ? "choice" : "answers",
    })
  }
  const request: RuntimeQuestionRequest = {
    kind: "question",
    requestId: interrupts.map(({ id }) => id).join("-"),
    // AG-UI scopes interrupts to the mounted thread; this field satisfies the
    // shared question composer contract used by non-AG-UI runtimes.
    sessionId: "ag-ui",
    questions,
  }
  return {
    request,
    resolve(answerSets: readonly string[][]): AgUiResumeEntry[] {
      return groups.map(({ interrupt, offset, count, payload }) => {
        const answers = answerSets.slice(offset, offset + count)
        return {
          interruptId: interrupt.id,
          status: "resolved",
          ...(payload === "choice"
            ? { payload: answers[0]?.[0] ?? "" }
            : { payload: { answers } }),
        }
      })
    },
    cancel(): AgUiResumeEntry[] {
      return interrupts.map(({ id }) => ({
        interruptId: id,
        status: "cancelled",
      }))
    },
  }
}

/** Uses the public AG-UI hooks; no provider-specific interaction endpoint. */
export function AgUiInterruptComposer({
  locale,
  fallback,
}: {
  locale: Locale
  fallback: ReactNode
}) {
  const interrupts = useAgUiInterrupts()
  const submit = useAgUiSubmitInterruptResponses()
  const [submittingInterrupts, setSubmittingInterrupts] = useState<
    readonly AgUiInterrupt[] | undefined
  >()
  const visibleInterrupts = useMemo(
    () => (interrupts.length > 0 ? interrupts : (submittingInterrupts ?? [])),
    [interrupts, submittingInterrupts]
  )
  const projected = useMemo(
    () => createAgUiInterruptRequest(visibleInterrupts),
    [visibleInterrupts]
  )
  const interactions = useMemo(() => {
    const submitVisible = async (responses: readonly AgUiResumeEntry[]) => {
      setSubmittingInterrupts(visibleInterrupts)
      try {
        await submit(responses)
      } finally {
        setSubmittingInterrupts(undefined)
      }
    }
    return {
      respond: async (
        _request: RuntimeQuestionRequest,
        response: { kind: "question"; answers: string[][] }
      ) => submitVisible(projected.resolve(response.answers)),
      reject: async () => submitVisible(projected.cancel()),
    }
  }, [projected, submit, visibleInterrupts])
  if (visibleInterrupts.length === 0) return fallback
  return (
    <RuntimeQuestionComposer
      key={projected.request.requestId}
      locale={locale}
      request={projected.request}
      interactions={interactions}
      onDismissExpired={noop}
      onResponsePending={noop}
      onResolved={noop}
    />
  )
}

/** Reads only the selected Session; provider subscriptions own reconciliation. */
export function PendingInteractionComposer({
  locale,
  threadId,
  interactions,
  fallback,
}: {
  locale: Locale
  threadId: string
  interactions: RuntimeInteractionAdapter
  fallback: ReactNode
}) {
  const subscribe = useCallback(
    (listener: () => void) => interactions.subscribe(threadId, listener),
    [interactions, threadId]
  )
  const getSnapshot = useCallback(
    () => interactions.getPending(threadId),
    [interactions, threadId]
  )
  const request = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (!request || request.sessionId !== threadId) return fallback
  const composer = (
    <RuntimeQuestionComposer
      key={`${threadId}:${request.requestId}`}
      locale={locale}
      request={request}
      interactions={interactions}
      expired={request.status === "expired"}
      recovered={request.status === "recovered"}
      onDismissExpired={() => interactions.dismiss?.(request)}
      onResponsePending={noop}
      onResolved={noop}
    />
  )
  return request.status === "recovered" ? (
    <>
      <div className="mx-auto flex w-full max-w-2xl px-4 pb-3">{composer}</div>
      {fallback}
    </>
  ) : (
    composer
  )
}
