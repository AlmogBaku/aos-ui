"use client"

import { ContextMenu } from "@base-ui/react/context-menu"
import { EyeOff, Trash2 } from "lucide-react"
import { useRef, type ReactElement } from "react"

import { MenuPopup, type MenuPopupEntry } from "@/components/ui/menu-popup"
import { getLocaleDirection, type Locale } from "@/lib/i18n/config"
import type { Dictionary } from "@/lib/i18n/dictionary"
import { isDraftAgentId } from "@/runtime-adapters/draft-agents"

export type AgentRowMenuProps = {
  agentId: string
  locale: Locale
  dictionary: Dictionary
  /** Absent when the runtime cannot change Agent visibility. */
  onHide?: (agentId: string) => void
  /** Absent when nothing can retire a draft. */
  onDiscardDraft?: (agentId: string) => void
}

/**
 * The single entry a row kind answers for: an ordinary Agent leaves the
 * workspace, and a draft is discarded. A row with no entry keeps no menu.
 */
function agentMenuEntry({
  agentId,
  dictionary,
  onHide,
  onDiscardDraft,
}: AgentRowMenuProps): MenuPopupEntry | null {
  if (isDraftAgentId(agentId)) {
    if (!onDiscardDraft) return null
    return {
      id: "discard-draft",
      label: dictionary.actions.discardDraft,
      icon: <Trash2 aria-hidden="true" />,
      destructive: true,
      onSelect: () => onDiscardDraft(agentId),
    }
  }
  if (!onHide) return null
  return {
    id: "hide-agent",
    label: dictionary.actions.hideAgent,
    icon: <EyeOff aria-hidden="true" />,
    onSelect: () => onHide(agentId),
  }
}

/**
 * Right click is the whole trigger: the rail row is a button, so a visible
 * trigger cannot nest inside it without changing the row's layout. A draft owns
 * no Session tabs and no details pane, so this is the only place to retire one.
 */
export function AgentRowContextMenu({
  children,
  ...menu
}: AgentRowMenuProps & { children: ReactElement }) {
  const triggerRef = useRef<HTMLDivElement>(null)
  const entry = agentMenuEntry(menu)
  if (!entry) return children

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger ref={triggerRef} render={children} />
      <MenuPopup
        entries={
          entry.destructive
            ? { items: [], destructive: entry }
            : { items: [entry] }
        }
        dir={getLocaleDirection(menu.locale)}
        finalFocus={() => triggerRef.current}
      />
    </ContextMenu.Root>
  )
}
