"use client"

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"

import {
  OptionList,
  ToolChrome,
  ToolUiLocaleProvider,
  type RichToolState,
} from "@/components/tool-ui"
import { Button } from "@/components/ui/button"
import type { Locale } from "@/lib/i18n/config"

export type PendingQuestionOption = {
  label: string
  description: string
}

export type PendingQuestion = {
  header: string
  question: string
  options: readonly PendingQuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export type PendingQuestionRequest = {
  id: string
  questions: readonly PendingQuestion[]
}

export type PendingQuestionAnswer = string[]

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

export const pendingQuestionCopy: Record<Locale, QuestionCopy> = {
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
    loadFailed: "Pending questions could not be loaded.",
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
    loadFailed: "לא ניתן לטעון שאלות ממתינות.",
    expired: "תוקף השאלה פג לפני שנשמרה תשובה.",
    dismiss: "סגירה",
  },
}
type AnswerDraft = {
  selected: readonly string[]
  custom: string
  customActive: boolean
}

export function PendingQuestionForm({
  locale,
  request,
  expired,
  recovered,
  onDismissExpired,
  onResponsePending,
  onResolved,
  onReply,
  onReject,
}: {
  locale: Locale
  request: PendingQuestionRequest
  expired?: boolean
  recovered?: boolean
  onDismissExpired?: () => void
  onResponsePending?: (pending: boolean) => void
  onResolved?: () => void
  onReply: (answers: PendingQuestionAnswer[]) => Promise<void>
  onReject: () => Promise<void>
}) {
  const copy = pendingQuestionCopy[locale]
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
  ]) satisfies PendingQuestionAnswer[]
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

    inFlight.current = true
    onResponsePending?.(true)
    setFailedAction(action)
    setPhase(action === "reply" ? "submitting" : "rejecting")
    try {
      if (action === "reply") {
        await onReply(answers)
      } else {
        await onReject()
      }
      onResponsePending?.(false)
      setPhase("answered")
      onResolved?.()
    } catch {
      inFlight.current = false
      onResponsePending?.(false)
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
                onClick={() => onDismissExpired?.()}
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
