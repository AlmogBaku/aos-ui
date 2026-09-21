"use client"

import { Menu } from "@base-ui/react/menu"
import type { ComponentProps, ReactElement, ReactNode } from "react"

import { cn } from "@/lib/utils"

import styles from "./menu-popup.module.css"

export type MenuPopupEntry = {
  id: string
  label: string
  icon: ReactNode
  disabled?: boolean
  /** Appended to the accessible name and shown as the title when disabled. */
  disabledReason?: string
  destructive?: boolean
  onSelect?: () => void
  /** Renders the item as another element, e.g. an Assistant UI action primitive. */
  render?: ReactElement
  nativeButton?: boolean
}

export type MenuPopupEntries = {
  items: readonly MenuPopupEntry[]
  /** Set apart below a separator, so a destructive action is never a misclick. */
  destructive?: MenuPopupEntry | null
}

function MenuPopupItem({ entry }: { entry: MenuPopupEntry }) {
  const reason = entry.disabled ? entry.disabledReason : undefined
  return (
    <Menu.Item
      className={cn(styles.item, entry.destructive && styles.itemDestructive)}
      disabled={entry.disabled}
      aria-label={reason ? `${entry.label}, ${reason}` : undefined}
      title={reason}
      onClick={entry.onSelect}
      render={entry.render}
      nativeButton={entry.nativeButton}
    >
      {entry.icon}
      {entry.label}
    </Menu.Item>
  )
}

/**
 * One popup shell for every menu trigger: a pointer context menu and a visible
 * overflow button offer the same items in the same order. `dir` is a plain
 * string so this component carries no locale dependency.
 */
export function MenuPopup({
  entries,
  dir,
  finalFocus,
}: {
  entries: MenuPopupEntries
  dir: "ltr" | "rtl"
  finalFocus?: ComponentProps<typeof Menu.Popup>["finalFocus"]
}): ReactElement {
  return (
    <Menu.Portal>
      <Menu.Positioner sideOffset={6} align="end" className={styles.positioner}>
        <Menu.Popup className={styles.popup} dir={dir} finalFocus={finalFocus}>
          {entries.items.map((entry) => (
            <MenuPopupItem key={entry.id} entry={entry} />
          ))}
          {entries.items.length > 0 && entries.destructive ? (
            <Menu.Separator className={styles.separator} />
          ) : null}
          {entries.destructive ? (
            <MenuPopupItem entry={entries.destructive} />
          ) : null}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  )
}
