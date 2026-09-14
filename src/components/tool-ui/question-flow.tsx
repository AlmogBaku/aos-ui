"use client"

import { useRef, useState } from "react"
import type { QuestionPayload } from "./payloads/question-flow"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

import { OptionList } from "./option-list"
import { QuestionFlow } from "./question-flow/index"
import { ToolChrome } from "./common"
import { normalizeRichToolState } from "./lifecycle"
import { useToolUiLocale } from "./locale"
import type { RichToolPart, RichToolPhase } from "./types"

type LocalSubmission = {
  phase?: Extract<RichToolPhase, "submitting" | "answered" | "failed">
  answer?: string
}

export function QuestionFlowTool({
  part,
  payload,
}: {
  part: RichToolPart
  payload: QuestionPayload
}) {
  const [freeform, setFreeform] = useState("")
  const [submission, setSubmission] = useState<LocalSubmission>({})
  const submissionInFlight = useRef(false)
  const { labels } = useToolUiLocale()
  const providerState = normalizeRichToolState(part, { interactive: true })
  const normalizedState = normalizeRichToolState(part, {
    interactive: true,
    overridePhase:
      providerState.phase === "pending" ? submission.phase : undefined,
  })
  const responses = readResponses(part.result)
  const state =
    readResultStatus(part.result) === "cancelled"
      ? { phase: "cancelled" as const, label: "Cancelled", canRespond: false }
      : normalizedState
  const providerAnswer = readAnswer(part.result, part.approval)
  const answer = providerAnswer ?? submission.answer
  const options = payload.args.options ?? []
  const normalizedOptions = options.map((option, index) => ({
    id: typeof option === "string" ? `option-${index}` : option.id,
    label: typeof option === "string" ? option : option.label,
    description: typeof option === "string" ? undefined : option.description,
  }))

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
