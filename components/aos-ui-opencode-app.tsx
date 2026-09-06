"use client"

import { AssistantRuntimeProvider } from "@assistant-ui/react"
import {
  OpenCodeEventSource,
  useOpenCodeQuestions,
  useOpenCodeRuntimeExtras,
  useOpenCodeSession,
  type OpenCodeQuestionRequest,
  type OpencodeClient,
  type QuestionAnswer,
} from "@assistant-ui/react-opencode"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react"

import type { ThreadComposerOverrideProps } from "@/components/assistant-ui/elements/thread.aui"
import { AosUiWorkspace } from "@/components/aos-ui-workspace"
import {
  OptionList,
  ToolChrome,
  ToolUiLocaleProvider,
  type RichToolState,
} from "@/components/tool-ui"
import { Button } from "@/components/ui/button"
import type { Locale } from "@/lib/i18n/config"
import type { Dictionary } from "@/lib/i18n/dictionary"
import { useOpenCodeRuntimeBundle } from "@/lib/runtime-adapters/opencode"
import { findOrphanedOpenCodeQuestion } from "@/lib/runtime-adapters/opencode/orphaned-question"

const REQUEST_OPTIONS = { throwOnError: true } as const
const emptyQuestionIds = new Set<string>()

type QuestionCopy = {
  questionsLabel: string
  answerFor: (header: string) => string
  typeAnswer: string
  customPlaceholder: string
  send: string
  sending: string
  discard: string
  discarding: string
  back: string
  next: string
  retry: string
  replyFailed: string
  rejectFailed: string
  loadFailed: string
  expired: string
  dismiss: string
}

const questionCopy: Record<Locale, QuestionCopy> = {
  en: {
    questionsLabel: "Questions",
    answerFor: (header: string) => `Your answer for ${header}`,
    typeAnswer: "Type an answer",
    customPlaceholder: "Type your answer…",
    send: "Send answer",
    sending: "Sending…",
    discard: "Discard",
    discarding: "Discarding…",
    back: "Back",
    next: "Next",
    retry: "Try again",
    replyFailed: "Your answer could not be sent.",
    rejectFailed: "The request could not be discarded.",
    loadFailed: "Pending OpenCode questions could not be loaded.",
    expired: "This question expired before an answer was recorded.",
    dismiss: "Dismiss",
  },
  he: {
    questionsLabel: "שאלות",
    answerFor: (header: string) => `התשובה שלך עבור ${header}`,
    typeAnswer: "הקלדת תשובה",
    customPlaceholder: "אפשר להקליד תשובה…",
    send: "שליחת תשובה",
    sending: "שולח…",
    discard: "ביטול",
    discarding: "מבטל…",
    back: "חזרה",
    next: "הבא",
    retry: "ניסיון חוזר",
    replyFailed: "לא ניתן לשלוח את התשובה.",
    rejectFailed: "לא ניתן לבטל את הבקשה.",
    loadFailed: "לא ניתן לטעון שאלות ממתינות מ-OpenCode.",
    expired: "תוקף השאלה פג לפני שנשמרה תשובה.",
    dismiss: "סגירה",
  },
}

type QuestionListSnapshot = {
  sessionId: string
  questions: readonly OpenCodeQuestionRequest[]
  error: Error | null
}

function toError(reason: unknown) {
  return reason instanceof Error ? reason : new Error(String(reason))
}

function mergePendingQuestions(
  sessionId: string,
  official: readonly OpenCodeQuestionRequest[],
  listed: readonly OpenCodeQuestionRequest[],
  resolvedIds: ReadonlySet<string>
) {
  const byId = new Map<string, OpenCodeQuestionRequest>()
  for (const question of [...listed, ...official]) {
    if (question.sessionID === sessionId && !resolvedIds.has(question.id)) {
      byId.set(question.id, question)
    }
  }
  return [...byId.values()].sort(
    (left, right) =>
      left.askedAt - right.askedAt || left.id.localeCompare(right.id)
  )
}

function addQuestionId(
  ids: ReadonlySet<string>,
  requestId: string
): ReadonlySet<string> {
  const next = new Set(ids)
  next.add(requestId)
  return next
}

type AnswerDraft = {
  selected: readonly string[]
  custom: string
  customActive: boolean
}

type QuestionRequestIdentity = {
  requestId: string
  sessionId: string
}

function QuestionRequestForm({
  locale,
  request,
  expired,
  recovered,
  onDismissExpired,
  onResponsePending,
  onResolved,
}: {
  locale: Locale
  request: OpenCodeQuestionRequest
  expired?: boolean
  recovered?: boolean
  onDismissExpired: () => void
  onResponsePending: (
    identity: QuestionRequestIdentity,
    pending: boolean
  ) => void
  onResolved: (identity: QuestionRequestIdentity) => void
}) {
  const copy = questionCopy[locale]
  const { replyToQuestion, rejectQuestion } = useOpenCodeRuntimeExtras()
  const [drafts, setDrafts] = useState<readonly AnswerDraft[]>(() =>
    request.questions.map(() => ({
      selected: [],
      custom: "",
      customActive: false,
    }))
  )
  const [questionIndex, setQuestionIndex] = useState(0)
  const [phase, setPhase] = useState<
    "pending" | "submitting" | "rejecting" | "answered" | "failed"
  >("pending")
  const [failedAction, setFailedAction] = useState<"reply" | "reject">("reply")
  const inFlight = useRef(false)
  const questionPanelRef = useRef<HTMLDivElement>(null)
  const focusAfterNavigation = useRef<number | null>(null)
  const focusAfterCustomActivation = useRef<number | null>(null)

  useEffect(() => {
    if (questionPanelRef.current) questionPanelRef.current.scrollTop = 0
  }, [questionIndex])

  const focusAnswerControl = useCallback(
    (index: number) => {
      const panel = document.getElementById(`${request.id}-panel-${index}`)
      const control = panel?.querySelector<HTMLElement>(
        '[role="option"], input, [data-question-custom-trigger]'
      )
      control?.focus()
    },
    [request.id]
  )

  useEffect(() => {
    if (focusAfterNavigation.current !== questionIndex) return
    focusAfterNavigation.current = null
    focusAnswerControl(questionIndex)
  }, [focusAnswerControl, questionIndex])

  const answers = drafts.map(({ selected, custom, customActive }) => [
    ...selected,
    ...(customActive && custom.trim() ? [custom.trim()] : []),
  ]) satisfies QuestionAnswer[]
  const activeQuestion = request.questions[questionIndex]
  const activeDraft = drafts[questionIndex]
  const isLastQuestion = questionIndex === request.questions.length - 1

  useEffect(() => {
    if (
      focusAfterCustomActivation.current !== questionIndex ||
      !activeDraft?.customActive
    ) {
      return
    }
    focusAfterCustomActivation.current = null
    document.getElementById(`${request.id}-custom-${questionIndex}`)?.focus()
  }, [activeDraft?.customActive, questionIndex, request.id])

  function selectOptions(questionIndex: number, selected: readonly string[]) {
    setDrafts((current) =>
      current.map((draft, index) => {
        if (index !== questionIndex) return draft
        return {
          selected,
          custom: draft.custom,
          customActive: activeQuestion?.multiple ? draft.customActive : false,
        }
      })
    )
  }

  function activateCustom(questionIndex: number) {
    focusAfterCustomActivation.current = questionIndex
    setDrafts((current) =>
      current.map((draft, index) => {
        if (index !== questionIndex) return draft
        return {
          selected: activeQuestion?.multiple ? draft.selected : [],
          custom: draft.custom,
          customActive: true,
        }
      })
    )
  }

  function writeCustom(questionIndex: number, value: string) {
    setDrafts((current) =>
      current.map((draft, index) =>
        index === questionIndex
          ? {
              selected: draft.selected,
              custom: value,
              customActive: true,
            }
          : draft
      )
    )
  }

  function finishCustom(questionIndex: number) {
    setDrafts((current) =>
      current.map((draft, index) =>
        index === questionIndex && !draft.custom.trim()
          ? { ...draft, customActive: false }
          : draft
      )
    )
  }

  function goToQuestion(nextIndex: number, focusAnswer = false) {
    const boundedIndex = Math.max(
      0,
      Math.min(request.questions.length - 1, nextIndex)
    )
    if (focusAnswer) focusAfterNavigation.current = boundedIndex
    setQuestionIndex(boundedIndex)
  }

  async function respond(action: "reply" | "reject") {
    if (expired || recovered || inFlight.current) return

    const identity: QuestionRequestIdentity = {
      requestId: request.id,
      sessionId: request.sessionID,
    }
    inFlight.current = true
    onResponsePending(identity, true)
    setFailedAction(action)
    setPhase(action === "reply" ? "submitting" : "rejecting")
    try {
      if (action === "reply") {
        await replyToQuestion(request.id, answers)
      } else {
        await rejectQuestion(request.id)
      }
      onResponsePending(identity, false)
      setPhase("answered")
      onResolved(identity)
    } catch {
      inFlight.current = false
      onResponsePending(identity, false)
      setPhase("failed")
    }
  }

  const busy = phase === "submitting" || phase === "rejecting"
  const toolState: RichToolState = {
    phase:
      expired || recovered
        ? "expired"
        : phase === "rejecting" || phase === "submitting"
          ? "submitting"
          : phase,
    label: "",
    canRespond: !expired && !recovered && !busy && phase !== "answered",
  }

  const optionEntries: Array<{
    id: string
    label: string
    description?: string
    disabled: boolean
  }> = (activeQuestion?.options ?? []).map((option, optionIndex) => ({
    id: `${request.id}-${questionIndex}-${optionIndex}`,
    label: option.label,
    description: option.description,
    disabled: busy || Boolean(recovered),
  }))
  const customAllowed = activeQuestion ? activeQuestion.custom !== false : false
  const optionIdByLabel = new Map(
    optionEntries.map((option) => [option.label, option.id])
  )
  const optionLabelById = new Map(
    optionEntries.map((option) => [option.id, option.label])
  )

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    tabIndex: number
  ) {
    const lastIndex = request.questions.length - 1
    const direction = locale === "he" ? -1 : 1
    const nextIndex =
      event.key === "ArrowRight"
        ? (tabIndex + direction + request.questions.length) %
          request.questions.length
        : event.key === "ArrowLeft"
          ? (tabIndex - direction + request.questions.length) %
            request.questions.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? lastIndex
              : null

    if (nextIndex == null) return
    event.preventDefault()
    goToQuestion(nextIndex)
    document.getElementById(`${request.id}-tab-${nextIndex}`)?.focus()
  }

  return (
    <section
      aria-label={copy.questionsLabel}
      className="w-full"
      data-slot="question-composer"
    >
      <ToolUiLocaleProvider locale={locale}>
        <ToolChrome
          title={copy.questionsLabel}
          state={toolState}
          showHeader={false}
        >
          {expired ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground" role="status">
                {copy.expired}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={onDismissExpired}
              >
                {copy.dismiss}
              </Button>
            </div>
          ) : (
            <form
              className="flex max-h-[min(28rem,calc(100dvh-16rem))] min-h-0 flex-col gap-4"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return
                event.preventDefault()
                event.stopPropagation()
              }}
              onSubmit={(event) => {
                event.preventDefault()
                if (phase === "failed") {
                  void respond(failedAction)
                  return
                }
                if (!isLastQuestion) {
                  goToQuestion(questionIndex + 1, true)
                  return
                }
                void respond("reply")
              }}
            >
              {request.questions.length > 1 ? (
                <div
                  aria-label={copy.questionsLabel}
                  className="flex w-full gap-1 overflow-x-auto rounded-lg bg-muted/50 p-1"
                  role="tablist"
                >
                  {request.questions.map((question, index) => {
                    const selected = index === questionIndex
                    const answered = Boolean(answers[index]?.length)
                    return (
                      <button
                        key={`${request.id}-tab-${index}`}
                        id={`${request.id}-tab-${index}`}
                        type="button"
                        role="tab"
                        aria-controls={`${request.id}-panel-${index}`}
                        aria-selected={selected}
                        data-answered={answered ? "true" : "false"}
                        disabled={busy}
                        tabIndex={selected ? 0 : -1}
                        className="flex min-h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors outline-none hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-xs"
                        onClick={() => goToQuestion(index)}
                        onKeyDown={(event) => handleTabKeyDown(event, index)}
                      >
                        <span
                          aria-hidden="true"
                          className="flex size-4 items-center justify-center rounded-full border border-current text-[10px] tabular-nums data-[answered=true]:bg-primary data-[answered=true]:text-primary-foreground"
                          data-answered={answered ? "true" : "false"}
                        >
                          {index + 1}
                        </span>
                        <bdi dir="auto">{question.header}</bdi>
                      </button>
                    )
                  })}
                </div>
              ) : null}

              <div
                ref={questionPanelRef}
                className="min-h-0 space-y-4 overflow-y-auto pe-1"
                data-slot="question-carousel-panel"
              >
                {activeQuestion && activeDraft ? (
                  <fieldset
                    id={`${request.id}-panel-${questionIndex}`}
                    className="space-y-3"
                    role={request.questions.length > 1 ? "tabpanel" : undefined}
                    aria-labelledby={
                      request.questions.length > 1
                        ? `${request.id}-tab-${questionIndex}`
                        : undefined
                    }
                  >
                    <legend className="space-y-1">
                      {request.questions.length === 1 ? (
                        <span className="block text-xs font-medium tracking-wide text-muted-foreground">
                          <bdi dir="auto">{activeQuestion.header}</bdi>
                        </span>
                      ) : null}
                      <span className="block text-sm font-medium" dir="auto">
                        {activeQuestion.question}
                      </span>
                    </legend>

                    {optionEntries.length > 0 || customAllowed ? (
                      <div
                        className="overflow-hidden rounded-xl border bg-card"
                        data-slot="question-answer-block"
                      >
                        {optionEntries.length > 0 ? (
                          <OptionList
                            id={`${request.id}-${questionIndex}`}
                            ariaLabel={activeQuestion.header}
                            options={optionEntries}
                            selectionMode={
                              activeQuestion.multiple ? "multi" : "single"
                            }
                            value={
                              activeQuestion.multiple
                                ? activeDraft.selected.flatMap((label) => {
                                    const id = optionIdByLabel.get(label)
                                    return id ? [id] : []
                                  })
                                : (optionIdByLabel.get(
                                    activeDraft.selected[0] ?? ""
                                  ) ?? null)
                            }
                            onChange={(value) => {
                              const selectedIds =
                                value == null
                                  ? []
                                  : typeof value === "string"
                                    ? [value]
                                    : value
                              selectOptions(
                                questionIndex,
                                selectedIds.flatMap((id) => {
                                  const label = optionLabelById.get(id)
                                  return label ? [label] : []
                                })
                              )
                            }}
                            actions={[]}
                            className="max-w-none min-w-0 gap-0 [&>[role=listbox]]:rounded-none [&>[role=listbox]]:border-0 [&>[role=listbox]]:bg-transparent [&>[role=listbox]]:shadow-none"
                          />
                        ) : null}
                        {customAllowed ? (
                          <div
                            className={
                              optionEntries.length > 0 ? "border-t" : undefined
                            }
                          >
                            {activeDraft.customActive ? (
                              <input
                                aria-label={copy.answerFor(
                                  activeQuestion.header
                                )}
                                id={`${request.id}-custom-${questionIndex}`}
                                type="text"
                                className="min-h-[50px] w-full bg-transparent ps-11 pe-4 text-base font-medium text-foreground outline-none placeholder:font-normal placeholder:text-muted-foreground disabled:pointer-events-none disabled:opacity-50 sm:text-sm"
                                dir="auto"
                                disabled={busy || recovered}
                                value={activeDraft.custom}
                                placeholder={copy.customPlaceholder}
                                onBlur={() => finishCustom(questionIndex)}
                                onChange={(event) =>
                                  writeCustom(
                                    questionIndex,
                                    event.currentTarget.value
                                  )
                                }
                                onKeyDown={(event) => {
                                  if (event.key !== "Enter") return
                                  if (
                                    event.repeat ||
                                    event.nativeEvent.isComposing ||
                                    event.nativeEvent.keyCode === 229
                                  ) {
                                    return
                                  }
                                  event.preventDefault()
                                  event.stopPropagation()
                                  event.currentTarget.blur()
                                  const actionId =
                                    phase === "failed"
                                      ? "retry"
                                      : isLastQuestion
                                        ? "send"
                                        : "next"
                                  document
                                    .getElementById(`${request.id}-${actionId}`)
                                    ?.focus()
                                }}
                              />
                            ) : (
                              <button
                                type="button"
                                data-question-custom-trigger
                                className="flex min-h-[50px] w-full items-center bg-transparent ps-11 pe-4 text-start text-base font-normal text-muted-foreground transition-colors outline-none hover:bg-primary/5 hover:text-foreground focus-visible:bg-primary/5 focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50 sm:text-sm"
                                disabled={busy || recovered}
                                onClick={() => activateCustom(questionIndex)}
                              >
                                <span dir="auto">{copy.typeAnswer}</span>
                              </button>
                            )}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </fieldset>
                ) : null}
              </div>

              {phase === "failed" ? (
                <p className="text-sm text-destructive" role="alert">
                  {failedAction === "reply"
                    ? copy.replyFailed
                    : copy.rejectFailed}
                </p>
              ) : null}

              {!recovered ? (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void respond("reject")}
                  >
                    {phase === "rejecting" ? copy.discarding : copy.discard}
                  </Button>
                  <div className="flex items-center gap-2">
                    {request.questions.length > 1 ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy || questionIndex === 0}
                        id={`${request.id}-back`}
                        onClick={() => goToQuestion(questionIndex - 1, true)}
                      >
                        {copy.back}
                      </Button>
                    ) : null}
                    <Button
                      id={`${request.id}-${
                        phase === "failed"
                          ? "retry"
                          : isLastQuestion
                            ? "send"
                            : "next"
                      }`}
                      type="submit"
                      disabled={busy}
                    >
                      {phase === "submitting"
                        ? copy.sending
                        : phase === "failed"
                          ? copy.retry
                          : isLastQuestion
                            ? copy.send
                            : copy.next}
                    </Button>
                  </div>
                </div>
              ) : null}
            </form>
          )}
        </ToolChrome>
      </ToolUiLocaleProvider>
    </section>
  )
}

export function OpenCodeQuestionBridge({
  locale,
  client,
  fallback = null,
}: {
  locale: Locale
  client: OpencodeClient
  fallback?: ReactNode
}) {
  const session = useOpenCodeSession()
  const officialQuestions = useOpenCodeQuestions()
  const { state } = useOpenCodeRuntimeExtras()
  const [reloadKey, setReloadKey] = useState(0)
  const [listedSnapshot, setListedSnapshot] = useState<QuestionListSnapshot>({
    sessionId: "",
    questions: [],
    error: null,
  })
  const [resolvedSnapshot, setResolvedSnapshot] = useState<{
    sessionId: string
    ids: ReadonlySet<string>
  }>({ sessionId: "", ids: emptyQuestionIds })
  const [expiredSnapshot, setExpiredSnapshot] = useState<{
    sessionId: string
    request: OpenCodeQuestionRequest
  } | null>(null)
  const locallyPending = useRef({ sessionId: "", ids: new Set<string>() })
  const locallyResolved = useRef({ sessionId: "", ids: new Set<string>() })
  const [presentedQuestion, setPresentedQuestion] = useState<{
    sessionId: string
    requestId: string | null
  }>({ sessionId: "", requestId: null })
  const visibleQuestions = useRef<{
    sessionId: string
    questions: readonly OpenCodeQuestionRequest[]
  }>({ sessionId: "", questions: [] })
  const sessionId = session?.id ?? ""

  useEffect(() => {
    if (!sessionId) return
    let active = true

    void client.question
      .list(undefined, REQUEST_OPTIONS)
      .then((response) => {
        if (!active) return
        const now = Date.now()
        setListedSnapshot({
          sessionId,
          questions: (response.data ?? [])
            .filter((question) => question.sessionID === sessionId)
            .map((question, index) => ({
              ...question,
              askedAt: now + index,
            })),
          error: null,
        })
      })
      .catch((reason: unknown) => {
        if (!active) return
        setListedSnapshot({
          sessionId,
          questions: [],
          error: toError(reason),
        })
      })

    return () => {
      active = false
    }
  }, [client, reloadKey, sessionId])

  const listedQuestions = useMemo(
    () =>
      listedSnapshot.sessionId === sessionId ? listedSnapshot.questions : [],
    [listedSnapshot.questions, listedSnapshot.sessionId, sessionId]
  )
  const resolvedIds =
    resolvedSnapshot.sessionId === sessionId
      ? resolvedSnapshot.ids
      : emptyQuestionIds
  const questions = mergePendingQuestions(
    sessionId,
    officialQuestions,
    listedQuestions,
    resolvedIds
  )
  const activeQuestion =
    (presentedQuestion.sessionId === sessionId && presentedQuestion.requestId
      ? questions.find(({ id }) => id === presentedQuestion.requestId)
      : undefined) ?? questions[0]

  useEffect(() => {
    // The provider question list is external state. Keep the visible request
    // stable while new requests arrive, then advance only when it resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPresentedQuestion((current) => {
      if (
        current.sessionId === sessionId &&
        ((current.requestId &&
          questions.some(({ id }) => id === current.requestId)) ||
          (!current.requestId && questions.length === 0))
      ) {
        return current
      }
      return { sessionId, requestId: questions[0]?.id ?? null }
    })
  }, [questions, sessionId])
  const expiredQuestion =
    expiredSnapshot?.sessionId === sessionId
      ? expiredSnapshot.request
      : undefined
  const loadError =
    listedSnapshot.sessionId === sessionId ? listedSnapshot.error : null
  const orphanedQuestion =
    listedSnapshot.sessionId === sessionId && !loadError
      ? findOrphanedOpenCodeQuestion(state)
      : null

  useEffect(() => {
    visibleQuestions.current = { sessionId, questions }
    if (
      !sessionId ||
      listedSnapshot.sessionId !== sessionId ||
      listedSnapshot.error
    ) {
      return
    }
    const current = locallyResolved.current
    if (current.sessionId !== sessionId) return
    const providerQuestionIds = new Set(
      [...officialQuestions, ...listedQuestions]
        .filter((question) => question.sessionID === sessionId)
        .map((question) => question.id)
    )
    for (const requestId of current.ids) {
      if (!providerQuestionIds.has(requestId)) current.ids.delete(requestId)
    }
    setResolvedSnapshot((snapshot) => {
      if (snapshot.sessionId !== sessionId) return snapshot
      const ids = new Set(
        [...snapshot.ids].filter((requestId) =>
          providerQuestionIds.has(requestId)
        )
      )
      return ids.size === snapshot.ids.size ? snapshot : { sessionId, ids }
    })
  }, [listedQuestions, listedSnapshot, officialQuestions, questions, sessionId])

  function resolveQuestion(identity: QuestionRequestIdentity) {
    if (identity.sessionId !== sessionId) return
    if (locallyResolved.current.sessionId !== sessionId) {
      locallyResolved.current = { sessionId, ids: new Set() }
    }
    locallyResolved.current.ids.add(identity.requestId)
    setResolvedSnapshot((current) => {
      const ids =
        current.sessionId === sessionId ? current.ids : emptyQuestionIds
      return {
        sessionId,
        ids: addQuestionId(ids, identity.requestId),
      }
    })
  }

  function setResponsePending(
    identity: QuestionRequestIdentity,
    pending: boolean
  ) {
    if (identity.sessionId !== sessionId) return
    if (locallyPending.current.sessionId !== sessionId) {
      locallyPending.current = { sessionId, ids: new Set() }
    }
    if (pending) locallyPending.current.ids.add(identity.requestId)
    else locallyPending.current.ids.delete(identity.requestId)
  }

  useEffect(() => {
    if (!sessionId) return
    const source = new OpenCodeEventSource(client)
    const unsubscribe = source.subscribe((event) => {
      if (event.sessionId !== sessionId) return
      if (
        event.type === "question.asked" ||
        event.type === "stream.reconnected"
      ) {
        setReloadKey((key) => key + 1)
        return
      }
      if (
        event.type !== "question.replied" &&
        event.type !== "question.rejected"
      ) {
        return
      }
      const requestId = event.properties.requestID
      if (typeof requestId !== "string") return
      if (
        locallyPending.current.sessionId === sessionId &&
        locallyPending.current.ids.has(requestId)
      ) {
        return
      }
      if (
        locallyResolved.current.sessionId === sessionId &&
        locallyResolved.current.ids.has(requestId)
      ) {
        return
      }
      const current = visibleQuestions.current
      const request =
        current.sessionId === sessionId
          ? current.questions.find(({ id }) => id === requestId)
          : undefined
      if (!request) return

      setResolvedSnapshot((snapshot) => {
        const ids =
          snapshot.sessionId === sessionId ? snapshot.ids : emptyQuestionIds
        return { sessionId, ids: addQuestionId(ids, requestId) }
      })
      setExpiredSnapshot({ sessionId, request })
      setReloadKey((key) => key + 1)
    })
    return () => {
      unsubscribe()
      source.dispose()
    }
  }, [client, sessionId])

  if (expiredQuestion || activeQuestion) {
    const presentedQuestion = expiredQuestion ?? activeQuestion!
    return (
      <QuestionRequestForm
        key={`${presentedQuestion.sessionID}:${presentedQuestion.id}`}
        locale={locale}
        request={presentedQuestion}
        expired={Boolean(expiredQuestion)}
        onDismissExpired={() => setExpiredSnapshot(null)}
        onResponsePending={setResponsePending}
        onResolved={resolveQuestion}
      />
    )
  }

  if (loadError) {
    const copy = questionCopy[locale]
    return (
      <>
        {fallback}
        <div
          className="fixed start-1/2 bottom-4 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border bg-popover px-4 py-3 text-sm shadow-lg rtl:translate-x-1/2"
          role="alert"
        >
          <span>{copy.loadFailed}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            {copy.retry}
          </Button>
        </div>
      </>
    )
  }

  if (orphanedQuestion) {
    return (
      <>
        <div className="mx-auto flex w-full max-w-2xl px-4 pb-3">
          <QuestionRequestForm
            locale={locale}
            request={{
              id: orphanedQuestion.callId,
              sessionID: sessionId,
              askedAt: orphanedQuestion.askedAt,
              questions: orphanedQuestion.questions,
            }}
            recovered
            onDismissExpired={() => {}}
            onResponsePending={() => {}}
            onResolved={() => {}}
          />
        </div>
        {fallback}
      </>
    )
  }

  return fallback
}

export function OpenCodeAosUiApp({
  locale,
  dictionary,
  baseUrl,
  managementUrl,
  defaultModel,
  nowIso,
}: {
  locale: Locale
  dictionary: Dictionary
  baseUrl: string
  managementUrl?: string
  defaultModel?: { providerID: string; modelID: string }
  nowIso: string
}) {
  const bundle = useOpenCodeRuntimeBundle({
    baseUrl,
    managementUrl,
    defaultModel,
  })
  const [now] = useState(() => new Date(nowIso))
  const composer = useMemo(
    () =>
      function OpenCodeComposer({ fallback }: ThreadComposerOverrideProps) {
        return (
          <OpenCodeQuestionBridge
            locale={locale}
            client={bundle.client}
            fallback={fallback}
          />
        )
      },
    [bundle.client, locale]
  )

  return (
    <AssistantRuntimeProvider runtime={bundle.assistantRuntime}>
      <AosUiWorkspace
        locale={locale}
        dictionary={dictionary}
        bundle={bundle}
        now={now}
        composer={composer}
      />
    </AssistantRuntimeProvider>
  )
}
