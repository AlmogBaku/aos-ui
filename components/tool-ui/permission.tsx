"use client"

import { useRef, useState } from "react"
import type { PermissionPayload } from "./payloads/permission"

import { Button } from "@/components/ui/button"

import { ToolChrome } from "./common"
import { normalizeRichToolState } from "./lifecycle"
import { useToolUiLocale } from "./locale"
import type { RichToolPart, RichToolPhase } from "./types"

type ApprovalOption = NonNullable<RichToolPart["approval"]>["options"] extends
  readonly (infer T)[] | undefined
  ? T
  : never

export function PermissionTool({
  part,
  payload,
}: {
  part: RichToolPart
  payload: PermissionPayload
}) {
  const [localPhase, setLocalPhase] = useState<
    Extract<RichToolPhase, "submitting" | "answered" | "failed"> | undefined
  >()
  const [confirmOption, setConfirmOption] = useState<ApprovalOption>()
  const [failedOption, setFailedOption] = useState<ApprovalOption>()
  const submissionInFlight = useRef(false)
  const { labels } = useToolUiLocale()
  const providerState = normalizeRichToolState(part, { interactive: true })
  const options = getVisibleOptions(part)
  const state = normalizeRichToolState(part, {
    interactive: true,
    overridePhase:
      providerState.phase === "pending"
        ? options.length === 0
          ? "unavailable"
          : localPhase
        : undefined,
  })

  async function answer(option: ApprovalOption) {
    if (
      !isAnswerableOption(option) ||
      !providerState.canRespond ||
      submissionInFlight.current ||
      localPhase === "answered"
    ) {
      return
    }

    submissionInFlight.current = true
    setFailedOption(option)
    setLocalPhase("submitting")
    try {
      await part.respondToApproval({ optionId: option.id })
      setLocalPhase("answered")
      setConfirmOption(undefined)
      setFailedOption(undefined)
    } catch {
      submissionInFlight.current = false
      setLocalPhase("failed")
    }
  }

  return (
    <ToolChrome
      title={labels.permission.title}
      description={part.approval?.prompt ?? payload.args.action}
      state={state}
    >
      {state.phase === "pending" && confirmOption ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-3">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold">
              {labels.permission.keepPermission}
            </p>
            <p className="text-sm text-muted-foreground">
              {labels.permission.persistentExplanation}
            </p>
          </div>
          <ScopeList grants={confirmOption.grants ?? []} />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void answer(confirmOption)}
            >
              {labels.permission.confirmAlways}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setConfirmOption(undefined)}
            >
              {labels.permission.back}
            </Button>
          </div>
        </div>
      ) : null}

      {state.phase === "pending" && !confirmOption ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {options.map((option) => (
              <Button
                key={option.id}
                type="button"
                size="sm"
                variant={option.kind.startsWith("reject") ? "ghost" : "outline"}
                onClick={() => {
                  if (option.kind === "allow-always") setConfirmOption(option)
                  else void answer(option)
                }}
              >
                <bdi dir="auto">
                  {option.label ?? defaultOptionLabel(option.kind, labels)}
                </bdi>
              </Button>
            ))}
          </div>
          {options
            .filter((option) => option.kind === "allow-always")
            .map((option) => (
              <ScopeList key={option.id} grants={option.grants ?? []} />
            ))}
        </div>
      ) : null}

      {state.phase === "submitting" ? (
        <p className="text-sm text-muted-foreground">
          {labels.permission.sending}
        </p>
      ) : null}
      {state.phase === "answered" ? (
        <p className="text-sm">{labels.permission.answered}</p>
      ) : null}
      {state.phase === "expired" ? (
        <p className="text-sm text-muted-foreground">
          {labels.permission.expired}
        </p>
      ) : null}
      {state.phase === "unavailable" ? (
        <p className="text-sm text-muted-foreground">
          {labels.permission.unavailable}
        </p>
      ) : null}
      {state.phase === "failed" ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-destructive">{labels.permission.failed}</p>
          {providerState.phase === "pending" && failedOption ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void answer(failedOption)}
            >
              {labels.common.retry}
            </Button>
          ) : null}
        </div>
      ) : null}
    </ToolChrome>
  )
}

function getVisibleOptions(part: RichToolPart): ApprovalOption[] {
  const supplied = part.approval?.options
  if (!supplied?.length) return []

  return supplied.filter(
    (option) =>
      isAnswerableOption(option) &&
      (option.kind !== "allow-always" || Boolean(option.grants?.length))
  )
}

function isAnswerableOption(option: ApprovalOption) {
  return typeof option.id === "string" && option.id.trim().length > 0
}

function defaultOptionLabel(
  kind: string,
  labels: ReturnType<typeof useToolUiLocale>["labels"]
) {
  if (kind === "allow-once") return labels.permission.allowOnce
  if (kind === "allow-always") return labels.permission.allowAlways
  if (kind === "reject-always") return labels.permission.rejectAlways
  return labels.permission.reject
}

function ScopeList({ grants }: { grants: readonly string[] }) {
  const { labels } = useToolUiLocale()

  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground">
        {labels.permission.scopeTitle}
      </p>
      <ul
        className="flex flex-col gap-1"
        aria-label={labels.permission.scopeLabel}
      >
        {grants.map((grant) => (
          <li key={grant}>
            <code
              className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
              dir="ltr"
            >
              {grant}
            </code>
          </li>
        ))}
      </ul>
    </div>
  )
}
