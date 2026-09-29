"use client"

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core"
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  ComposerPrimitive,
  QueueItemPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import {
  ArrowUpIcon,
  GripVerticalIcon,
  LoaderCircleIcon,
  XIcon,
} from "lucide-react"

import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button"
import { cn } from "@/lib/utils"

export type MessageQueueLabels = {
  readonly region: string
  readonly count: (count: number) => string
  readonly sendsCombined: string
  readonly editAll: string
  readonly rowHint: string
  readonly steerLabel: string
  readonly removeLabel: string
  readonly steering: string
  readonly failed: string
  readonly moved: (position: number, count: number) => string
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

const plainKey = (event: KeyboardEvent) =>
  !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey

/** Where a row sits in the queue, and its neighbours to move around. */
type QueuePlace = {
  readonly position: number
  readonly previousId: string | undefined
  readonly nextId: string | undefined
}

function QueueRow({
  labels,
  hintId,
  steer,
  onUnconfirmed,
  placeOf,
  onMoved,
  onEdit,
}: {
  labels: MessageQueueLabels
  hintId: string
  steer: NonNullable<ComposerFeatureViewModel["steer"]> | undefined
  onUnconfirmed(delivery: UnconfirmedDelivery): void
  placeOf(id: string): QueuePlace
  onMoved(position: number): void
  onEdit: (() => void) | undefined
}) {
  const aui = useAui()
  const originThreadId = useAuiState((state) => state.threads.mainThreadId)
  const requestId = useAuiState((state) => state.queueItem.id)
  const parts = useAuiState((state) => state.queueItem.parts)
  const text = queueItemText(parts)
  const running = useAuiState((state) => state.thread.isRunning)
  // An accepted steer is a user message under the steer's own request id.
  const acknowledged = useAuiState((state) =>
    state.thread.messages.some((message) => message.id === requestId)
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

  const pending = status === "pending"
  const {
    setNodeRef,
    listeners,
    transform,
    transition,
    isDragging,
    isSorting,
  } = useSortable({ id: requestId, disabled: pending })

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
  // Editing a row edits the whole queue, in the composer.
  const edit = () => {
    if (!pending) onEdit?.()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
    if (
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      event.preventDefault()
      const focused = document.activeElement
      move(
        event.key === "ArrowUp" ? -1 : 1,
        focused instanceof HTMLElement && event.currentTarget.contains(focused)
          ? focused
          : null
      )
    } else if (
      event.key === "Enter" &&
      plainKey(event) &&
      event.target === event.currentTarget
    ) {
      event.preventDefault()
      edit()
    }
  }

  const canSteer = running && steer !== undefined
  return (
    <li
      ref={setNodeRef}
      data-slot="aui_message-queue-item"
      tabIndex={0}
      aria-describedby={onEdit ? hintId : undefined}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group/queue-row flex min-h-9 min-w-0 items-center gap-1.5 rounded-xl py-0.5 ps-1.5 pe-1 text-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none",
        "cursor-grab hover:bg-foreground/[0.04]",
        isSorting && !isDragging && "hover:bg-transparent",
        isDragging &&
          "relative z-10 cursor-grabbing bg-background shadow-[0_6px_16px_-6px] shadow-foreground/25 dark:bg-popover"
      )}
      onKeyDown={onKeyDown}
      onDoubleClick={(event) => {
        if (event.target instanceof Element && event.target.closest("button"))
          return
        edit()
      }}
      {...listeners}
    >
      <span
        aria-hidden="true"
        className="grid w-5 shrink-0 place-items-center text-xs text-muted-foreground tabular-nums"
      >
        <span className="group-hover/queue-row:hidden group-focus-visible/queue-row:hidden [@media(pointer:coarse)]:inline">
          {position}
        </span>
        <GripVerticalIcon className="hidden size-3.5 group-hover/queue-row:block group-focus-visible/queue-row:block [@media(pointer:coarse)]:hidden" />
      </span>
      <QueueItemPrimitive.Text
        dir="auto"
        className="min-w-0 flex-1 truncate py-1 text-start text-foreground/75"
      />
      {status === "error" ? (
        <span className="shrink-0 text-xs text-destructive" role="status">
          {labels.failed}
        </span>
      ) : null}
      {canSteer ? (
        <TooltipIconButton
          type="button"
          tooltip={labels.steerLabel}
          aria-label={labels.steerLabel}
          disabled={pending}
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:size-11"
          onClick={() => void submitSteering()}
        >
          {pending ? (
            <LoaderCircleIcon
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
            />
          ) : (
            <ArrowUpIcon aria-hidden="true" />
          )}
        </TooltipIconButton>
      ) : null}
      <QueueItemPrimitive.Remove
        render={
          <TooltipIconButton
            type="button"
            tooltip={labels.removeLabel}
            aria-label={labels.removeLabel}
            disabled={pending}
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:size-11"
          />
        }
      >
        <XIcon aria-hidden="true" />
      </QueueItemPrimitive.Remove>
      <span className="sr-only" role="status" aria-live="polite">
        {pending ? labels.steering : status === "error" ? labels.failed : ""}
      </span>
    </li>
  )
}

// Rows only travel up and down the queue.
const alongQueue: Modifier = ({ transform }) => ({ ...transform, x: 0 })

// Dragging is a pointer affordance; keyboards move rows with Alt+Arrow and
// the queue's own live region announces every landing.
const silentDrag = {
  announcements: {
    onDragStart: () => undefined,
    onDragOver: () => undefined,
    onDragEnd: () => undefined,
    onDragCancel: () => undefined,
  },
  screenReaderInstructions: { draggable: "" },
}

export function MessageQueue({
  labels,
  steer,
  onUnconfirmed,
  onEdit,
}: {
  labels: MessageQueueLabels
  steer: ComposerFeatureViewModel["steer"]
  onUnconfirmed(delivery: UnconfirmedDelivery): void
  /** Takes the whole queue into the composer; absent when it cannot. */
  onEdit: (() => void) | undefined
}) {
  const aui = useAui()
  const items = useAuiState((state) => state.composer.queue)
  const hintId = useId()
  const ids = items.map((item) => item.id)
  const placeOf = (id: string): QueuePlace => {
    const index = ids.indexOf(id)
    return {
      position: index + 1,
      previousId: ids[index - 1],
      nextId: ids[index + 1],
    }
  }
  // The announcement is fixed as the move happens, and a repeat of the same
  // words toggles a trailing space so the live region reads it again.
  // A message joining or leaving the queue makes the last announcement stale,
  // so it is kept only while the queue holds the same messages.
  const members = [...ids].sort().join()
  const [moved, setMoved] = useState<{
    text: string
    repeat: boolean
    members: string
  }>()
  const announceMove = useCallback(
    (position: number) => {
      const text = labels.moved(position, items.length)
      setMoved((last) => ({
        text,
        repeat: last?.text === text && !last.repeat,
        members,
      }))
    },
    [items.length, labels, members]
  )
  const announcement =
    moved?.members === members
      ? `${moved.text}${moved.repeat ? "\u00a0" : ""}`
      : ""

  const sensors = useSensors(
    // A few pixels of travel before a drag, so clicks and double-clicks stay.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 6 },
    })
  )
  const drop = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    aui.composer
      .queueItem({ id: String(active.id) })
      .move(
        from < to
          ? { insertAfter: String(over.id) }
          : { insertBefore: String(over.id) }
      )
    announceMove(to + 1)
  }

  return (
    <div
      data-slot="aui_message-queue"
      role="region"
      aria-label={labels.region}
      className="w-full self-stretch @min-[64rem]/workspace:mx-auto @min-[64rem]/workspace:max-w-(--thread-content-max-width)"
    >
      {/* Tucked behind the composer: the composer's rounded edge overlaps
          the tray's foot, so the two read as one surface. */}
      <div className="mx-3 -mb-5 rounded-t-2xl border border-b-0 border-border/60 bg-muted/50 px-1.5 pt-1.5 pb-6 dark:bg-muted/30">
        <div className="flex min-w-0 items-center gap-1.5 px-2 pb-1 text-xs text-muted-foreground">
          <span className="shrink-0 font-medium text-foreground/70 tabular-nums">
            {labels.count(items.length)}
          </span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0">{labels.sendsCombined}</span>
          {onEdit ? (
            <span className="ms-auto flex shrink-0 items-center gap-1 [@media(pointer:coarse)]:hidden">
              <kbd className="grid h-4 min-w-4 place-items-center rounded border border-border/80 bg-background px-1 font-sans text-[0.625rem] text-foreground/70 dark:bg-popover">
                Esc
              </kbd>
              {labels.editAll}
            </span>
          ) : null}
        </div>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[alongQueue]}
          accessibility={silentDrag}
          onDragEnd={drop}
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <ul className="flex min-w-0 flex-col">
              <ComposerPrimitive.Queue>
                {() => (
                  <QueueRow
                    labels={labels}
                    hintId={hintId}
                    steer={steer}
                    onUnconfirmed={onUnconfirmed}
                    placeOf={placeOf}
                    onMoved={announceMove}
                    onEdit={onEdit}
                  />
                )}
              </ComposerPrimitive.Queue>
            </ul>
          </SortableContext>
        </DndContext>
      </div>
      <span id={hintId} className="sr-only">
        {labels.rowHint}
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  )
}
