"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react"
import { Menu } from "@base-ui/react/menu"
import {
  ComposerPrimitive,
  QueueItemPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CornerDownRightIcon,
  EllipsisIcon,
  LoaderCircleIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react"

import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button"
import { Button } from "@/components/ui/button"
import { MenuPopup, type MenuPopupEntry } from "@/components/ui/menu-popup"
import { Textarea } from "@/components/ui/textarea"
import { keyboardEventSafetyReason } from "@/lib/keyboard"
import { steerMessageId } from "@/lib/message-parts"
import { cn } from "@/lib/utils"
import {
  queueControlsExtras,
  type QueueControls,
} from "@/runtime-adapters/queue-controls"

export type MessageQueueLabels = {
  readonly region: string
  readonly steer: string
  readonly steerLabel: string
  readonly removeLabel: string
  readonly steering: string
  readonly failed: string
  readonly actions: string
  readonly moveUp: string
  readonly moveDown: string
  readonly moved: (position: number, count: number) => string
  readonly edit: string
  readonly save: string
  readonly cancel: string
  readonly editor: string
}

/** The queued message open for editing, and where focus returns after. */
export type QueueEditing = {
  readonly id: string
  readonly returnTo: "row" | "composer"
}

export type UnconfirmedDelivery = {
  readonly requestId: string
  readonly text: string
}

function queueItemText(
  parts: readonly { type: string; text?: string | undefined }[]
) {
  return parts
    .flatMap((part) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : []
    )
    .join("\n\n")
}

export function isUncertainDelivery(error: unknown) {
  if (!error || typeof error !== "object") return false
  const value = error as { code?: unknown; kind?: unknown }
  return (
    value.code === "uncertain_mutation" ||
    value.kind === "connection-interrupted"
  )
}

/**
 * The row's text as a field. It holds the queue while it is open, so a turn
 * ending meanwhile sends nothing until the edit is saved or cancelled.
 */
function QueueEditor({
  labels,
  initialText,
  hold,
  fieldRef,
  onSave,
  onCancel,
}: {
  labels: MessageQueueLabels
  initialText: string
  hold: QueueControls["hold"]
  fieldRef: RefObject<HTMLTextAreaElement | null>
  onSave(text: string): void
  onCancel(): void
}) {
  const [text, setText] = useState(initialText)
  useEffect(() => hold(), [hold])
  useLayoutEffect(() => {
    const field = fieldRef.current
    field?.focus()
    field?.setSelectionRange(field.value.length, field.value.length)
  }, [fieldRef])
  const blank = text.trim() === ""
  const save = () => {
    if (!blank) onSave(text)
  }
  return (
    <>
      <Textarea
        ref={fieldRef}
        dir="auto"
        rows={1}
        aria-label={labels.editor}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (keyboardEventSafetyReason(event)) return
          if (event.key === "Escape") {
            event.preventDefault()
            onCancel()
          } else if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey
          ) {
            event.preventDefault()
            save()
          }
        }}
        className="min-h-8 min-w-0 flex-1 resize-none px-2 py-1"
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={blank}
        className="shrink-0 [@media(pointer:coarse)]:min-h-11"
        onClick={save}
      >
        {labels.save}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="shrink-0 [@media(pointer:coarse)]:min-h-11"
        onClick={onCancel}
      >
        {labels.cancel}
      </Button>
    </>
  )
}

/** Where a row sits in the queue, and its neighbours to move around. */
type QueuePlace = {
  readonly position: number
  readonly previousId: string | undefined
  readonly nextId: string | undefined
}

function QueueRow({
  labels,
  steer,
  onUnconfirmed,
  direction,
  placeOf,
  onMoved,
  controls,
  editing,
  onEditingChange,
}: {
  labels: MessageQueueLabels
  steer: NonNullable<ComposerFeatureViewModel["steer"]> | undefined
  onUnconfirmed(delivery: UnconfirmedDelivery): void
  direction: "ltr" | "rtl"
  placeOf(id: string): QueuePlace
  onMoved(position: number): void
  controls: QueueControls | undefined
  editing: QueueEditing | undefined
  onEditingChange(editing: QueueEditing | undefined): void
}) {
  const aui = useAui()
  const originThreadId = useAuiState((state) => state.threads.mainThreadId)
  const requestId = useAuiState((state) => state.queueItem.id)
  const parts = useAuiState((state) => state.queueItem.parts)
  const text = queueItemText(parts)
  const running = useAuiState((state) => state.thread.isRunning)
  const acknowledged = useAuiState((state) =>
    state.thread.messages.some(
      (message) => message.id === steerMessageId(requestId)
    )
  )
  const acknowledgedRef = useRef(false)
  const [status, setStatus] = useState<"idle" | "pending" | "error">("idle")

  useEffect(() => {
    if (!acknowledged) return
    if (aui.threads.getState().mainThreadId !== originThreadId) return
    acknowledgedRef.current = true
    aui.queueItem.remove()
  }, [acknowledged, aui, originThreadId])

  const submitSteering = useCallback(async () => {
    if (!steer || status === "pending") return
    setStatus("pending")
    try {
      await steer({ requestId, text })
      if (aui.threads.getState().mainThreadId !== originThreadId) return
      acknowledgedRef.current = true
      aui.queueItem.remove()
    } catch (error) {
      if (aui.threads.getState().mainThreadId !== originThreadId) return
      if (acknowledgedRef.current) return
      if (isUncertainDelivery(error)) {
        onUnconfirmed({ requestId, text })
        aui.queueItem.remove()
        return
      }
      setStatus("error")
    }
  }, [aui, onUnconfirmed, originThreadId, requestId, status, steer, text])

  const { position, previousId, nextId } = placeOf(requestId)
  // React moves a keyed row's node, which drops focus: whatever held focus
  // in the row takes it back once the row lands.
  const refocusRef = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    refocusRef.current?.focus()
    refocusRef.current = null
  }, [position])
  const move = (by: -1 | 1, focused: HTMLElement | null) => {
    const anchor = by < 0 ? previousId : nextId
    if (anchor === undefined) return
    refocusRef.current = focused
    aui.queueItem.move(
      by < 0 ? { insertBefore: anchor } : { insertAfter: anchor }
    )
    onMoved(position + by)
  }
  const moveOnKey = (event: KeyboardEvent<HTMLLIElement>) => {
    if (
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      (event.key !== "ArrowUp" && event.key !== "ArrowDown")
    )
      return
    event.preventDefault()
    const focused = document.activeElement
    move(
      event.key === "ArrowUp" ? -1 : 1,
      focused instanceof HTMLElement && event.currentTarget.contains(focused)
        ? focused
        : null
    )
  }
  const moreRef = useRef<HTMLButtonElement>(null)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const isEditing = editing?.id === requestId
  const edit = () => onEditingChange({ id: requestId, returnTo: "row" })
  // Focus goes back to More once the row leaves edit mode it opened.
  const returnToMoreRef = useRef(false)
  useLayoutEffect(() => {
    if (isEditing || !returnToMoreRef.current) return
    returnToMoreRef.current = false
    moreRef.current?.focus()
  }, [isEditing])
  const closeEditor = () => {
    returnToMoreRef.current = editing?.returnTo === "row"
    onEditingChange(undefined)
  }
  const menuEntries: MenuPopupEntry[] = [
    ...(controls
      ? [
          {
            id: "edit",
            label: labels.edit,
            icon: <PencilIcon aria-hidden="true" />,
            onSelect: edit,
          },
        ]
      : []),
    {
      id: "move-up",
      label: labels.moveUp,
      icon: <ArrowUpIcon aria-hidden="true" />,
      disabled: previousId === undefined,
      onSelect: () => move(-1, moreRef.current),
    },
    {
      id: "move-down",
      label: labels.moveDown,
      icon: <ArrowDownIcon aria-hidden="true" />,
      disabled: nextId === undefined,
      onSelect: () => move(1, moreRef.current),
    },
  ]

  const canSteer = running && steer !== undefined
  const pending = status === "pending"
  return (
    <li
      data-slot="aui_message-queue-item"
      className="flex min-h-10 min-w-0 items-center gap-2 rounded-xl border border-border/60 bg-background px-2.5 py-1.5 text-sm shadow-xs motion-reduce:transition-none"
      // The field keeps Alt+Arrow keys: on macOS they move the caret.
      onKeyDown={isEditing ? undefined : moveOnKey}
    >
      <CornerDownRightIcon
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      {isEditing && controls ? (
        <QueueEditor
          labels={labels}
          initialText={text}
          hold={controls.hold}
          fieldRef={fieldRef}
          onSave={(edited) => {
            controls.editText(requestId, edited)
            closeEditor()
          }}
          onCancel={closeEditor}
        />
      ) : (
        <QueueItemPrimitive.Text
          dir="auto"
          className={cn(
            "min-w-0 flex-1 truncate text-start text-foreground/85",
            controls && "cursor-text"
          )}
          // A pointer shortcut for the menu's Edit, which keyboards reach.
          onClick={controls ? edit : undefined}
        />
      )}
      {status === "error" ? (
        <span className="shrink-0 text-xs text-destructive" role="status">
          {labels.failed}
        </span>
      ) : null}
      {canSteer ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={labels.steerLabel}
          disabled={pending || isEditing}
          className="shrink-0 [@media(pointer:coarse)]:min-h-11"
          onClick={() => void submitSteering()}
        >
          {pending ? (
            <LoaderCircleIcon
              data-icon="inline-start"
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
            />
          ) : null}
          {labels.steer}
        </Button>
      ) : null}
      {isEditing ? null : (
        <Menu.Root>
          <Menu.Trigger
          ref={moreRef}
          render={
            <TooltipIconButton
              type="button"
              tooltip={labels.actions}
              aria-label={labels.actions}
              className="size-8 shrink-0 [@media(pointer:coarse)]:size-11"
            />
          }
        >
            <EllipsisIcon aria-hidden="true" />
          </Menu.Trigger>
          <MenuPopup
            entries={{ items: menuEntries }}
            dir={direction}
            finalFocus={() => fieldRef.current ?? moreRef.current}
          />
        </Menu.Root>
      )}
      <QueueItemPrimitive.Remove
        render={
          <TooltipIconButton
            type="button"
            tooltip={labels.removeLabel}
            aria-label={labels.removeLabel}
            disabled={pending}
            className="size-8 shrink-0 [@media(pointer:coarse)]:size-11"
          />
        }
      >
        <Trash2Icon aria-hidden="true" />
      </QueueItemPrimitive.Remove>
      <span className="sr-only" role="status" aria-live="polite">
        {pending ? labels.steering : status === "error" ? labels.failed : ""}
      </span>
    </li>
  )
}

export function MessageQueue({
  labels,
  steer,
  onUnconfirmed,
  direction,
  editing,
  onEditingChange,
}: {
  labels: MessageQueueLabels
  steer: ComposerFeatureViewModel["steer"]
  onUnconfirmed(delivery: UnconfirmedDelivery): void
  direction: "ltr" | "rtl"
  editing: QueueEditing | undefined
  onEditingChange(editing: QueueEditing | undefined): void
}) {
  const items = useAuiState((state) => state.composer.queue)
  const controls = queueControlsExtras.use(
    (extras) => extras.queueControls,
    undefined
  )
  const placeOf = useCallback(
    (id: string): QueuePlace => {
      const index = items.findIndex((item) => item.id === id)
      return {
        position: index + 1,
        previousId: items[index - 1]?.id,
        nextId: items[index + 1]?.id,
      }
    },
    [items]
  )
  const [moved, setMoved] = useState<number>()
  return (
    <div
      data-slot="aui_message-queue"
      role="region"
      aria-label={labels.region}
      className="mb-2"
    >
      <ul className="flex min-w-0 flex-col gap-1">
        <ComposerPrimitive.Queue>
          {() => (
            <QueueRow
              labels={labels}
              steer={steer}
              onUnconfirmed={onUnconfirmed}
              direction={direction}
              placeOf={placeOf}
              onMoved={setMoved}
              controls={controls}
              editing={editing}
              onEditingChange={onEditingChange}
            />
          )}
        </ComposerPrimitive.Queue>
      </ul>
      <span className="sr-only" role="status" aria-live="polite">
        {moved === undefined ? "" : labels.moved(moved, items.length)}
      </span>
    </div>
  )
}
