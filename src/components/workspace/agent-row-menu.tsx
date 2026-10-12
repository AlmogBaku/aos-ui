"use client"

import { ContextMenu } from "@base-ui/react/context-menu"
import { Bell, BellOff, EyeOff, Trash2 } from "lucide-react"
import { useRef, type ReactElement } from "react"

import {
  MenuPopup,
  useMenuPopupMount,
  type MenuPopupEntry,
} from "@/components/ui/menu-popup"
import { getLocaleDirection, type Locale } from "@/lib/i18n/config"
import type { Dictionary } from "@/lib/i18n/dictionary"
import { isDraftAgentId } from "@/runtime-adapters/draft-agents"

export type AgentRowMenuCopy = {
  mute: string
  unmute: string
  hide: string
  discardDraft: string
}

export function agentRowMenuCopy(dictionary: Dictionary): AgentRowMenuCopy {
  return {
    mute: dictionary.actions.muteNotifications,
    unmute: dictionary.actions.unmuteNotifications,
    hide: dictionary.actions.hideAgent,
    discardDraft: dictionary.actions.discardDraft,
  }
}

/** What one Agent row offers; an absent handler is an action not offered. */
export type AgentRowMenuHandlers = {
  muted?: boolean
  /** Present only where the runtime can store this Agent's mute. */
  onSetMuted?: (muted: boolean) => void
  /** Absent when the runtime cannot change Agent visibility. */
  onHide?: () => void
  /** Absent when nothing can retire a draft. */
  onDiscardDraft?: () => void
}

/**
 * What a row kind answers for: an ordinary Agent is muted or unmuted and
 * leaves the workspace, and a draft is discarded. A row with no entry keeps
 * no menu.
 */
function agentMenuEntries(
  agentId: string,
  copy: AgentRowMenuCopy,
  { muted = false, onSetMuted, onHide, onDiscardDraft }: AgentRowMenuHandlers
): { items: MenuPopupEntry[]; destructive?: MenuPopupEntry } {
  if (isDraftAgentId(agentId))
    return {
      items: [],
      ...(onDiscardDraft
        ? {
            destructive: {
              id: "discard-draft",
              label: copy.discardDraft,
              icon: <Trash2 aria-hidden="true" />,
              destructive: true,
              onSelect: onDiscardDraft,
            },
          }
        : {}),
    }
  const items: MenuPopupEntry[] = []
  if (onSetMuted)
    items.push({
      id: "mute-agent",
      label: muted ? copy.unmute : copy.mute,
      icon: muted ? (
        <Bell aria-hidden="true" />
      ) : (
        <BellOff aria-hidden="true" />
      ),
      onSelect: () => onSetMuted(!muted),
    })
  if (onHide)
    items.push({
      id: "hide-agent",
      label: copy.hide,
      icon: <EyeOff aria-hidden="true" />,
      onSelect: onHide,
    })
  return { items }
}

/**
 * A right click or a long press is the whole trigger: an Agent row is a
 * button, so a visible trigger cannot nest inside it without changing the
 * row's layout. The rail and the phone's Agent list share it, and its text is
 * never selectable, so a long press always means the menu. A draft owns no
 * Session tabs and no details pane, so this is the only place to retire one.
 */
export function AgentRowContextMenu({
  agentId,
  locale,
  copy,
  children,
  ...handlers
}: AgentRowMenuHandlers & {
  agentId: string
  locale: Locale
  copy: AgentRowMenuCopy
  children: ReactElement
}) {
  const triggerRef = useRef<HTMLDivElement>(null)
  const popup = useMenuPopupMount()
  const entries = agentMenuEntries(agentId, copy, handlers)
  if (!entries.items.length && !entries.destructive) return children

  return (
    <ContextMenu.Root {...popup.rootProps}>
      <ContextMenu.Trigger
        ref={triggerRef}
        render={children}
        className="select-none"
      />
      {popup.mounted ? (
        <MenuPopup
          entries={entries}
          dir={getLocaleDirection(locale)}
          finalFocus={() => triggerRef.current}
        />
      ) : null}
    </ContextMenu.Root>
  )
}
