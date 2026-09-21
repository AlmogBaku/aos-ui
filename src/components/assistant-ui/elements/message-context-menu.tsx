"use client"

import { ContextMenu } from "@base-ui/react/context-menu"
import { ActionBarPrimitive } from "@assistant-ui/react"
import {
  CopyIcon,
  DownloadIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
  TextSelectIcon,
  Volume2Icon,
} from "lucide-react"
import { useEffect, useRef, useState, type ReactElement } from "react"

import { usePendingInteractionGate } from "@/components/runtime-interactions/pending-interaction-context"
import { MenuPopup, type MenuPopupEntry } from "@/components/ui/menu-popup"
import type { LocaleDirection } from "@/lib/i18n/config"

import { useVoiceMessageAction } from "../voice/voice-read-aloud"
import {
  useMessageCopy,
  useMessageEdit,
  useMessageRetry,
} from "./message-actions"
import type { MessageRewind, ThreadLabels } from "./thread.aui"
import { useTouchPrimaryInput } from "./touch-primary"

export type MessageContextMenuLabels = Pick<
  ThreadLabels,
  | "copy"
  | "refresh"
  | "exportMarkdown"
  | "edit"
  | "selectText"
  | "pendingInteractionAction"
>

/** Targets whose own menu belongs to the browser, not to the message. */
const NATIVE_TARGETS = [
  "input",
  "textarea",
  "select",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  "a[href]",
  "img",
  "video",
  "audio",
].join(", ")

/** A long press must not swallow the tap a control inside the message owns. */
const TOUCH_NATIVE_TARGETS = `${NATIVE_TARGETS}, button, [role="button"]`

function isNativeTarget(target: EventTarget | null, selector: string) {
  return target instanceof Element && target.closest(selector) !== null
}

/** Whether text inside this message is already selected. */
function hasSelectionInside(root: HTMLElement | null) {
  const selection = root?.ownerDocument.defaultView?.getSelection()
  if (
    !root ||
    !selection ||
    selection.isCollapsed ||
    selection.rangeCount === 0
  )
    return false
  return root.contains(selection.getRangeAt(0).commonAncestorContainer)
}

/**
 * Offers a message's own actions where a hover action bar cannot be reached: a
 * long press on touch, a right click with a pointer. The action bar keeps every
 * item it already has, and this menu offers the same ones in the same states.
 *
 * Touch selects no text by default, because a press has to mean the menu.
 * `Select text` hands that press back to the browser for one message until the
 * next press outside it.
 */
export function MessageContextMenu({
  role,
  labels,
  messageRewind,
  dir,
  children,
}: {
  role: "assistant" | "user"
  labels: MessageContextMenuLabels
  messageRewind: MessageRewind | undefined
  dir: LocaleDirection
  children: ReactElement
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const returnFocusTo = useRef<HTMLElement | null>(null)
  const [selectable, setSelectable] = useState(false)
  const isTouchPrimaryInput = useTouchPrimaryInput()
  const hasPendingInteraction = usePendingInteractionGate()
  const copy = useMessageCopy()
  const retry = useMessageRetry(messageRewind)
  const edit = useMessageEdit()
  const voice = useVoiceMessageAction()

  useEffect(() => {
    const root = rootRef.current
    if (!selectable || !root) return
    const owner = root.ownerDocument
    const release = (event: PointerEvent) => {
      if (event.target instanceof Node && root.contains(event.target)) return
      setSelectable(false)
    }
    owner.addEventListener("pointerdown", release, true)
    return () => owner.removeEventListener("pointerdown", release, true)
  }, [selectable])

  const pendingReason = hasPendingInteraction
    ? labels.pendingInteractionAction
    : undefined
  const items: MenuPopupEntry[] = [
    {
      id: "copy",
      label: labels.copy,
      icon: <CopyIcon aria-hidden="true" />,
      disabled: copy.disabled,
      onSelect: copy.copy,
    },
  ]
  if (role === "assistant") {
    if (messageRewind !== false)
      items.push({
        id: "retry",
        label: labels.refresh,
        icon: <RefreshCwIcon aria-hidden="true" />,
        disabled: retry.disabled,
        disabledReason: pendingReason,
        onSelect: retry.retry,
      })
    if (voice)
      items.push({
        id: "read-aloud",
        label: voice.label,
        icon:
          voice.kind === "stop" ? (
            <SquareIcon aria-hidden="true" />
          ) : (
            <Volume2Icon aria-hidden="true" />
          ),
        disabled: voice.disabled,
        disabledReason: voice.reason,
        onSelect: voice.run,
      })
    items.push({
      id: "export-markdown",
      label: labels.exportMarkdown,
      icon: <DownloadIcon aria-hidden="true" />,
      // The primitive owns the download; no runtime method exists to call. Its
      // own "has exportable content" test is the copy predicate, so the two
      // items agree about an answer nobody can export.
      disabled: copy.disabled,
      render: <ActionBarPrimitive.ExportMarkdown />,
      nativeButton: true,
    })
  } else if (messageRewind !== false) {
    items.push({
      id: "edit",
      label: labels.edit,
      icon: <PencilIcon aria-hidden="true" />,
      disabled: edit.disabled,
      disabledReason: pendingReason,
      onSelect: edit.edit,
    })
  }
  if (isTouchPrimaryInput)
    items.push({
      id: "select-text",
      label: labels.selectText,
      icon: <TextSelectIcon aria-hidden="true" />,
      onSelect: () => setSelectable(true),
    })

  return (
    <ContextMenu.Root
      // Disabled rather than unmounted: remounting the message would replay its
      // entrance and collapse every tool disclosure the reader opened.
      disabled={selectable}
      onOpenChange={(open) => {
        if (!open) return
        const active = rootRef.current?.ownerDocument.activeElement
        returnFocusTo.current =
          active instanceof HTMLElement && rootRef.current?.contains(active)
            ? active
            : null
      }}
    >
      <ContextMenu.Trigger
        ref={rootRef}
        render={children}
        // Only so closing the menu has somewhere to return focus to: an
        // unhovered message renders no action bar and no focusable control.
        tabIndex={-1}
        data-selectable={selectable ? "true" : undefined}
        className="touch-primary:select-none touch-primary:data-[selectable=true]:select-text"
        // Base UI suppresses the iOS callout for the whole trigger; the targets
        // vetoed below keep their own link and image menus.
        style={{ WebkitTouchCallout: "default" }}
        onContextMenu={(event) => {
          if (
            !isNativeTarget(event.target, NATIVE_TARGETS) &&
            !hasSelectionInside(rootRef.current)
          )
            return
          // A document-level listener cancels the native menu for anything
          // inside the trigger, so the event must never reach it.
          event.stopPropagation()
          event.preventBaseUIHandler()
        }}
        onTouchStart={(event) => {
          // Base UI stops this event itself; veto only its long-press handler.
          if (isNativeTarget(event.target, TOUCH_NATIVE_TARGETS))
            event.preventBaseUIHandler()
        }}
      />
      <MenuPopup
        entries={{ items }}
        dir={dir}
        finalFocus={() => returnFocusTo.current ?? rootRef.current}
      />
    </ContextMenu.Root>
  )
}
