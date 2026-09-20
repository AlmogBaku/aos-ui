"use client"

import { ContextMenu } from "@base-ui/react/context-menu"
import { Menu } from "@base-ui/react/menu"
import {
  Archive,
  ArchiveRestore,
  Ellipsis,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  X,
} from "lucide-react"
import {
  useRef,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react"

import { Button } from "@/components/ui/button"
import type { Locale } from "@/lib/i18n/config"
import type { Dictionary } from "@/lib/i18n/dictionary"
import { cn } from "@/lib/utils"
import type { SessionActionCapabilities } from "@/runtime-adapters/contracts"

import type { WorkspaceSession } from "./workspace-shell"
import styles from "./workspace-shell.module.css"

export type SessionRowMenuCopy = {
  sessionActions: string
  rename: string
  pin: string
  unpin: string
  archive: string
  unarchive: string
  delete: string
  closeTab: string
  removeOpenSession: string
  /** Named on an action this runtime does not perform. */
  unavailable: string
}

export function sessionRowMenuCopy(dictionary: Dictionary): SessionRowMenuCopy {
  return {
    sessionActions: dictionary.actions.sessionActions,
    rename: dictionary.actions.rename,
    pin: dictionary.actions.pinSession,
    unpin: dictionary.actions.unpinSession,
    archive: dictionary.actions.archiveSession,
    unarchive: dictionary.actions.unarchiveSession,
    delete: dictionary.actions.deleteSession,
    closeTab: dictionary.actions.closeTab,
    removeOpenSession: dictionary.mobileNavigation.removeOpenSession,
    unavailable: dictionary.actions.actionUnavailable,
  }
}

/**
 * Every item a Session row can offer. A missing handler removes its item, so a
 * surface only offers what it can actually carry out.
 */
export type SessionRowMenuHandlers = {
  onRename?: (session: WorkspaceSession) => void
  onTogglePin?: (session: WorkspaceSession) => void
  onToggleArchive?: (session: WorkspaceSession) => void
  onDelete?: (session: WorkspaceSession) => void
  onCloseTab?: (session: WorkspaceSession) => void
  onRemoveOpenSession?: (session: WorkspaceSession) => void
}

export type SessionRowMenuProps = {
  session: WorkspaceSession
  copy: SessionRowMenuCopy
  locale: Locale
  /** Runtime-declared actions, or `null` until the runtime has answered. */
  availability?: SessionActionCapabilities | null
  handlers: SessionRowMenuHandlers
}

type MenuEntry = {
  id: string
  label: string
  icon: ReactNode
  /** False when the runtime does not declare this action. */
  available: boolean
  run: () => void
}

type MenuEntries = {
  items: MenuEntry[]
  destructive: MenuEntry | null
}

/**
 * Runtime-owned actions stay hidden until the runtime answers, so the menu
 * never offers an action nobody has confirmed. Once it answers, an undeclared
 * action stays visible but disabled and says why.
 */
function sessionMenuEntries({
  session,
  copy,
  availability,
  handlers,
}: SessionRowMenuProps): MenuEntries {
  const items: MenuEntry[] = []

  if (availability) {
    const { onRename, onTogglePin, onToggleArchive } = handlers
    if (onRename) {
      items.push({
        id: "rename",
        label: copy.rename,
        icon: <Pencil aria-hidden="true" />,
        available: availability.rename,
        run: () => onRename(session),
      })
    }
    if (onTogglePin) {
      items.push({
        id: "pin",
        label: session.pinned ? copy.unpin : copy.pin,
        icon: session.pinned ? (
          <PinOff aria-hidden="true" />
        ) : (
          <Pin aria-hidden="true" />
        ),
        available: availability.pin,
        run: () => onTogglePin(session),
      })
    }
    if (onToggleArchive) {
      items.push({
        id: "archive",
        label: session.archived ? copy.unarchive : copy.archive,
        icon: session.archived ? (
          <ArchiveRestore aria-hidden="true" />
        ) : (
          <Archive aria-hidden="true" />
        ),
        available: availability.archive,
        run: () => onToggleArchive(session),
      })
    }
  }

  if (handlers.onCloseTab) {
    const onCloseTab = handlers.onCloseTab
    items.push({
      id: "close-tab",
      label: copy.closeTab,
      icon: <X aria-hidden="true" />,
      available: true,
      run: () => onCloseTab(session),
    })
  }
  if (handlers.onRemoveOpenSession) {
    const onRemoveOpenSession = handlers.onRemoveOpenSession
    items.push({
      id: "remove-open-session",
      label: copy.removeOpenSession,
      icon: <X aria-hidden="true" />,
      available: true,
      run: () => onRemoveOpenSession(session),
    })
  }

  const onDelete = handlers.onDelete
  return {
    items,
    destructive:
      availability && onDelete
        ? {
            id: "delete",
            label: copy.delete,
            icon: <Trash2 aria-hidden="true" />,
            available: availability.delete,
            run: () => onDelete(session),
          }
        : null,
  }
}

function SessionMenuItem({
  entry,
  copy,
  destructive = false,
}: {
  entry: MenuEntry
  copy: SessionRowMenuCopy
  destructive?: boolean
}) {
  return (
    <Menu.Item
      className={cn(
        styles.sessionMenuItem,
        destructive && styles.sessionMenuItemDestructive
      )}
      disabled={!entry.available}
      aria-label={
        entry.available ? undefined : `${entry.label}, ${copy.unavailable}`
      }
      title={entry.available ? undefined : copy.unavailable}
      onClick={entry.run}
    >
      {entry.icon}
      {entry.label}
    </Menu.Item>
  )
}

/**
 * One popup shell for the row menu, shared by the pointer trigger and the
 * visible overflow button so both surfaces offer the same items in the same
 * order.
 */
function SessionMenuPopup({
  copy,
  locale,
  entries,
  finalFocus,
}: {
  copy: SessionRowMenuCopy
  locale: Locale
  entries: MenuEntries
  finalFocus?: RefObject<HTMLElement | null>
}) {
  return (
    <Menu.Portal>
      <Menu.Positioner
        sideOffset={6}
        align="end"
        className={styles.sessionMenuPositioner}
      >
        <Menu.Popup
          className={styles.sessionMenu}
          dir={locale === "he" ? "rtl" : "ltr"}
          finalFocus={finalFocus}
        >
          {entries.items.map((entry) => (
            <SessionMenuItem key={entry.id} entry={entry} copy={copy} />
          ))}
          {entries.items.length > 0 && entries.destructive ? (
            <Menu.Separator className={styles.sessionMenuSeparator} />
          ) : null}
          {entries.destructive ? (
            <SessionMenuItem
              entry={entries.destructive}
              copy={copy}
              destructive
            />
          ) : null}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  )
}

/**
 * Opens the row menu from a right click or a long press. The row element is
 * the trigger, so the pointer target stays the whole row.
 */
export function SessionRowContextMenu({
  children,
  ...menu
}: SessionRowMenuProps & { children: ReactElement }) {
  const triggerRef = useRef<HTMLDivElement>(null)
  const entries = sessionMenuEntries(menu)
  if (entries.items.length === 0 && !entries.destructive) return children

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger ref={triggerRef} render={children} />
      <SessionMenuPopup
        copy={menu.copy}
        locale={menu.locale}
        entries={entries}
        finalFocus={triggerRef}
      />
    </ContextMenu.Root>
  )
}

/** The always-visible overflow trigger for the same row menu. */
export function SessionRowMenuButton({
  className,
  ...menu
}: SessionRowMenuProps & { className?: string }) {
  const entries = sessionMenuEntries(menu)
  if (entries.items.length === 0 && !entries.destructive) return null

  return (
    <Menu.Root>
      <Menu.Trigger
        render={<Button variant="ghost" className={className} />}
        aria-label={`${menu.copy.sessionActions}: ${menu.session.title}`}
        data-session-menu={menu.session.threadId}
      >
        <Ellipsis aria-hidden="true" />
      </Menu.Trigger>
      <SessionMenuPopup
        copy={menu.copy}
        locale={menu.locale}
        entries={entries}
      />
    </Menu.Root>
  )
}
