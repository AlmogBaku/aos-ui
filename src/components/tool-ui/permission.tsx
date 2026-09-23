"use client"

import { useRef, useState } from "react"
import {
  readPermissionAction,
  type PermissionPayload,
} from "./payloads/permission"

import { AOS_PERMISSION_KIND_SESSION } from "@aos/protocol/acp"

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
  /** The option last sent, retried if it failed and named once answered. */
  const [sentOption, setSentOption] = useState<ApprovalOption>()
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
    setSentOption(option)
    setLocalPhase("submitting")
    try {
      await part.respondToApproval(approvalResponse(option))
      setLocalPhase("answered")
      setConfirmOption(undefined)
    } catch {
      submissionInFlight.current = false
      setLocalPhase("failed")
    }
  }

  const prompt = part.approval?.prompt ?? payload.args.action
  // The operation itself, unless the provider asked with nothing more.
  const action = readPermissionAction(part)
  const operation = action === prompt ? undefined : action
  const chosen =
    options.find(({ id }) => id === part.approval?.optionId) ?? sentOption

  return (
    <ToolChrome
      title={labels.permission.title}
      description={prompt}
      state={state}
    >
      {operation ? (
        <code
          className="block rounded-md bg-muted p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
          dir="ltr"
        >
          {operation}
        </code>
      ) : null}
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
          {confirmOption.grants?.length ? (
            <ScopeList grants={confirmOption.grants} />
          ) : null}
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
          <div
            role="group"
            aria-label={prompt}
            className="flex flex-wrap gap-2"
          >
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
                <bdi dir="auto">{optionLabel(option, labels)}</bdi>
              </Button>
            ))}
          </div>
          {options.map((option) =>
            option.kind === "allow-always" && option.grants?.length ? (
              <ScopeList key={option.id} grants={option.grants} />
            ) : null
          )}
        </div>
      ) : null}

      {state.phase === "submitting" ? (
        <p className="text-sm text-muted-foreground">
          {labels.permission.sending}
        </p>
      ) : null}
      {state.phase === "answered" ? (
        <p className="text-sm" dir="auto">
          {chosen
            ? labels.permission.answeredWith(optionLabel(chosen, labels))
            : labels.permission.answered}
        </p>
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
          {providerState.phase === "pending" && sentOption ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void answer(sentOption)}
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

  return supplied.filter(isAnswerableOption)
}

function isAnswerableOption(option: ApprovalOption) {
  return typeof option.id === "string" && option.id.trim().length > 0
}

const STANDARD_KINDS = new Set([
  "allow-once",
  "allow-always",
  "reject-once",
  "reject-always",
])

/** Assistant UI decides a standard kind itself; any other needs it spelled out. */
function approvalResponse(option: ApprovalOption) {
  return STANDARD_KINDS.has(option.kind)
    ? { optionId: option.id }
    : { optionId: option.id, approved: !option.kind.includes("reject") }
}

function optionLabel(
  { kind, label }: ApprovalOption,
  labels: ReturnType<typeof useToolUiLocale>["labels"]
) {
  if (label !== undefined) return label
  if (kind === "allow-once") return labels.permission.allowOnce
  if (kind === "allow-always") return labels.permission.allowAlways
  if (kind === AOS_PERMISSION_KIND_SESSION)
    return labels.permission.allowSession
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
