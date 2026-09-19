"use client"

import { useRef, useState } from "react"
import type { QuestionPayload } from "./payloads/question-flow"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useOutOfBandQuestions } from "@/components/runtime-interactions/pending-interaction-context"

import { OptionList } from "./option-list"
import { QuestionFlow } from "./question-flow/index"
import { ToolChrome } from "./common"
import { normalizeRichToolState } from "./lifecycle"
import { useToolUiLocale } from "./locale"
import type { RichToolPart, RichToolPhase, RichToolState } from "./types"

type LocalSubmission = {
  phase?: Extract<RichToolPhase, "submitting" | "answered" | "failed">
  answer?: string
}

type QuestionOption = {
  id: string
  label: string
  description?: string
}

type AskedQuestion = {
  /** Absent when the chrome title already states the one question verbatim. */
  text?: string
  options: readonly QuestionOption[]
}

type QuestionToolProps = {
  part: RichToolPart
  payload: QuestionPayload
}

/**
 * Runtimes that expose `HarnessRuntime.interactions` raise their questions out
 * of band and answer them beside the composer, so the transcript keeps the
 * call inspectable instead of collecting a second answer of its own.
 */
export function QuestionFlowTool(props: QuestionToolProps) {
  return useOutOfBandQuestions() ? (
    <QuestionRecord {...props} />
  ) : (
    <AnswerableQuestion {...props} />
  )
}

function QuestionRecord({ part, payload }: QuestionToolProps) {
  const { labels } = useToolUiLocale()
  const state = readQuestionState(part, { interactive: true })
  const recorded = readRecordedAnswers(part)
  const asked = readAskedQuestions(payload)

  return (
    <ToolChrome title={payload.args.question} state={state}>
      <ul className="flex flex-col gap-3 text-sm">
        {asked.map((question, index) => {
          const answers = recorded?.[index]
          return (
            <li
              key={`${part.toolCallId}-asked-${index}`}
              className="flex flex-col gap-1"
            >
              {question.text ? (
                <p className="text-muted-foreground" dir="auto">
                  {question.text}
                </p>
              ) : null}
              {question.options.length ? (
                <ul className="list-disc space-y-0.5 ps-5 text-muted-foreground">
                  {question.options.map((option) => (
                    <li key={option.id} dir="auto">
                      {option.description
                        ? `${option.label} — ${option.description}`
                        : option.label}
                    </li>
                  ))}
                </ul>
              ) : null}
              {answers ? (
                <p>
                  <span className="text-muted-foreground">
                    {labels.question.response}{" "}
                  </span>
                  <bdi className="font-medium" dir="auto">
                    {answers.length
                      ? answers.join(", ")
                      : labels.question.discarded}
                  </bdi>
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>
      {state.phase === "expired" ? (
        <p className="text-sm text-muted-foreground">
          {labels.question.expired}
        </p>
      ) : null}
    </ToolChrome>
  )
}

function AnswerableQuestion({ part, payload }: QuestionToolProps) {
  const [freeform, setFreeform] = useState("")
  const [submission, setSubmission] = useState<LocalSubmission>({})
  const submissionInFlight = useRef(false)
  const { labels } = useToolUiLocale()
  const providerState = normalizeRichToolState(part, { interactive: true })
  const state = readQuestionState(part, {
    interactive: true,
    overridePhase:
      providerState.phase === "pending" ? submission.phase : undefined,
  })
  const responses = readResponses(part.result)
  const providerAnswer = readAnswer(part.result, part.approval)
  const answer = providerAnswer ?? submission.answer
  const normalizedOptions = normalizeOptions(payload.args.options)

  async function submit(answerValue: string) {
    const normalizedAnswer = answerValue.trim()
    if (
      !normalizedAnswer ||
      !providerState.canRespond ||
      submissionInFlight.current ||
      submission.phase === "answered"
    ) {
      return
    }

    submissionInFlight.current = true
    setSubmission({ phase: "submitting", answer: normalizedAnswer })
    try {
      if (part.approval) {
        await part.respondToApproval({ text: normalizedAnswer })
      } else if (part.interrupt) {
        await Promise.resolve(part.resume({ answer: normalizedAnswer }))
      } else {
        await Promise.resolve(part.addResult({ answer: normalizedAnswer }))
      }
      setSubmission({ phase: "answered", answer: normalizedAnswer })
    } catch {
      submissionInFlight.current = false
      setSubmission({ phase: "failed", answer: normalizedAnswer })
    }
  }

  return (
    <ToolChrome
      title={payload.args.question}
      description={labels.question.description}
      state={state}
    >
      {state.phase === "pending" ? (
        <div className="flex flex-col gap-4">
          {normalizedOptions.length > 0 && !payload.args.allowFreeform ? (
            <QuestionFlow
              id={part.toolCallId}
              className="min-w-0"
              step={1}
              title={payload.args.question}
              description={labels.question.description}
              options={normalizedOptions}
              selectionMode="single"
              headingLevel={3}
              onSelect={(ids) => {
                const option = normalizedOptions.find(({ id }) => id === ids[0])
                if (option) void submit(option.label)
              }}
              labels={{
                step: () => labels.question.answerOptions,
                back: "",
                next: labels.question.submit,
                complete: labels.question.submit,
              }}
            />
          ) : null}
          {normalizedOptions.length > 0 && payload.args.allowFreeform ? (
            <OptionList
              id={part.toolCallId}
              className="min-w-0"
              options={normalizedOptions}
              selectionMode="single"
              minSelections={1}
              ariaLabel={labels.question.answerOptions}
              actions={[]}
              onChange={(selection) => {
                if (typeof selection !== "string") return
                const option = normalizedOptions.find(
                  ({ id }) => id === selection
                )
                if (option) void submit(option.label)
              }}
            />
          ) : null}
          {payload.args.allowFreeform ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                void submit(freeform)
              }}
            >
              <label
                htmlFor={`${part.toolCallId}-answer`}
                className="text-sm font-medium"
              >
                {labels.question.answerLabel}
              </label>
              <Textarea
                id={`${part.toolCallId}-answer`}
                value={freeform}
                onChange={(event) => setFreeform(event.currentTarget.value)}
                className="min-h-20 resize-y"
                placeholder={labels.question.placeholder}
                dir="auto"
              />
              <div>
                <Button type="submit" size="sm" disabled={!freeform.trim()}>
                  {labels.question.submit}
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}

      {state.phase === "submitting" ? (
        <p className="text-sm text-muted-foreground">
          {labels.question.recording}
        </p>
      ) : null}
      {(state.phase === "answered" || state.phase === "cancelled") &&
      responses?.length ? (
        <dl className="flex flex-col gap-3 text-sm">
          {responses.map((response, index) => (
            <div key={`${response.question}:${index}`} className="grid gap-0.5">
              <dt className="text-muted-foreground" dir="auto">
                {response.question}
              </dt>
              <dd className="font-medium" dir="auto">
                {response.answers.length
                  ? response.answers.join(", ")
                  : labels.question.discarded}
              </dd>
            </div>
          ))}
        </dl>
      ) : state.phase === "answered" ? (
        <p className="text-sm">
          <span className="text-muted-foreground">
            {labels.question.response}{" "}
          </span>
          <bdi className="font-medium" dir="auto">
            {answer ?? labels.question.recorded}
          </bdi>
        </p>
      ) : null}
      {state.phase === "expired" ? (
        <p className="text-sm text-muted-foreground">
          {labels.question.expired}
        </p>
      ) : null}
      {state.phase === "failed" ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-destructive">{labels.question.failed}</p>
          {providerState.phase === "pending" &&
          submission.phase === "failed" &&
          submission.answer ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void submit(submission.answer!)}
            >
              {labels.common.retry}
            </Button>
          ) : null}
        </div>
      ) : null}
    </ToolChrome>
  )
}

/** A cancelled provider result outranks the lifecycle's completion reading. */
function readQuestionState(
  part: RichToolPart,
  options: Parameters<typeof normalizeRichToolState>[1]
): RichToolState {
  if (readResultStatus(part.result) === "cancelled")
    return { phase: "cancelled", label: "Cancelled", canRespond: false }
  return normalizeRichToolState(part, options)
}

function normalizeOptions(
  options: QuestionPayload["args"]["options"]
): QuestionOption[] {
  return (options ?? []).map((option, index) => ({
    id: typeof option === "string" ? `option-${index}` : option.id,
    label: typeof option === "string" ? option : option.label,
    description: typeof option === "string" ? undefined : option.description,
  }))
}

/**
 * The questions a call put to the operator. A batched call spells each one out
 * beneath the chrome title; a single question is the title itself.
 */
function readAskedQuestions(payload: QuestionPayload): AskedQuestion[] {
  const batched = payload.args.questions ?? []
  if (batched.length)
    return batched.map((question) => ({
      text: question.question,
      options: normalizeOptions(question.options),
    }))
  return [{ options: normalizeOptions(payload.args.options) }]
}

/** Answers the provider recorded, positioned like the questions it asked. */
function readRecordedAnswers(
  part: RichToolPart
): readonly (readonly string[])[] | undefined {
  const responses = readResponses(part.result)
  if (responses) return responses.map((response) => response.answers)
  const answer = readAnswer(part.result, part.approval)
  return answer ? [[answer]] : undefined
}

function readAnswer(
  result: unknown,
  approval: RichToolPart["approval"]
): string | undefined {
  if (approval?.text) return approval.text
  if (typeof result === "string") return result
  if (!result || typeof result !== "object") return undefined

  for (const key of ["answer", "text", "selection", "value"] as const) {
    const value = Reflect.get(result, key)
    if (typeof value === "string" && value.trim()) return value
  }
  return undefined
}

function readResultStatus(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return undefined
  const status = Reflect.get(result, "status")
  return status === "cancelled" ? status : undefined
}

function readResponses(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return undefined
  const candidates = Reflect.get(result, "responses")
  if (!Array.isArray(candidates)) return undefined
  const responses = candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      return []
    const question = Reflect.get(candidate, "question")
    const answers = Reflect.get(candidate, "answers")
    if (
      typeof question !== "string" ||
      !question.trim() ||
      !Array.isArray(answers) ||
      answers.some((answer) => typeof answer !== "string")
    )
      return []
    return [{ question, answers: answers as string[] }]
  })
  return responses.length ? responses : undefined
}
