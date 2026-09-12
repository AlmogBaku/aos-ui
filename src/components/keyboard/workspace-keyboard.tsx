"use client"

import { createKeyboardDispatcher } from "@/lib/keyboard"
import type { Locale } from "@/lib/i18n/config"
import * as React from "react"
import { createPortal } from "react-dom"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

import { CommandPalette, type KeyboardCommand } from "./command-palette"
import { KEYBOARD_UI_CATALOG } from "./keyboard-actions"
import {
  createFocusRegionCoordinator,
  observeKeyboardRegions,
} from "./focus-regions"
import { KeyboardReference } from "./keyboard-reference"
import { KeyboardShortcutsSettings } from "./keyboard-shortcuts-settings"
import {
  detectKeyboardPlatform,
  formatKeyboardBinding,
  type KeyboardPlatform,
} from "./keyboard-settings"
import { useKeyboardSettings } from "./use-keyboard-settings"
import workspaceStyles from "@/components/workspace/workspace-shell.module.css"

type WorkspaceKeyboardAgent = { readonly id: string; readonly name: string }
type WorkspaceKeyboardSession = {
  readonly threadId: string
  readonly title: string
}

export type WorkspaceKeyboardProps = {
  locale: Locale
  rootRef: React.RefObject<HTMLElement | null>
  agents: readonly WorkspaceKeyboardAgent[]
  openSessions: readonly WorkspaceKeyboardSession[]
  olderSessions: readonly WorkspaceKeyboardSession[]
  selectedAgentId: string | null
  activeThreadId: string | null
  agentBuilderAvailable: boolean
  canCreateSession: boolean
  onSelectAgent: (agentId: string) => void | Promise<unknown>
  onOpenSession: (threadId: string) => void | Promise<unknown>
  onCreateSession: (agentId: string) => void | Promise<unknown>
  onOpenAgentBuilder: () => void | Promise<unknown>
}

const localCopy = {
  en: {
    commands: "Commands",
    openCommands: "Open Commands",
    commandDescription: "Search available workspace actions.",
    newAgent: "New Agent",
    newSession: "New Session",
    selectAgent: "Select Agent",
    openSession: "Open Session",
    focusAgents: "Focus Agents",
    focusSessions: "Focus Sessions",
    focusConversation: "Focus conversation",
    searchConversation: "Search in conversation",
    focusInspector: "Focus inspector",
    nextAgent: "Select next Agent",
    previousAgent: "Select previous Agent",
    nextSession: "Select next Session",
    previousSession: "Select previous Session",
    settings: "Keyboard Shortcuts",
  },
  he: {
    commands: "פקודות",
    openCommands: "פתיחת פקודות",
    commandDescription: "חיפוש פעולות זמינות בסביבת העבודה.",
    newAgent: "סוכן חדש",
    newSession: "שיחה חדשה",
    selectAgent: "בחירת סוכן",
    openSession: "פתיחת שיחה",
    focusAgents: "מיקוד בסוכנים",
    focusSessions: "מיקוד בשיחות",
    focusConversation: "מיקוד בשיחה",
    searchConversation: "חיפוש בשיחה",
    focusInspector: "מיקוד במפקח",
    nextAgent: "בחירת הסוכן הבא",
    previousAgent: "בחירת הסוכן הקודם",
    nextSession: "בחירת השיחה הבאה",
    previousSession: "בחירת השיחה הקודמת",
    settings: "קיצורי מקלדת",
  },
} as const

function runAction(action: (() => void | Promise<unknown>) | undefined) {
  try {
    void action?.()
  } catch {
    // The workspace owns user-facing action error reporting.
  }
}

export function WorkspaceKeyboard({
  locale,
  rootRef,
  agents,
  openSessions,
  olderSessions,
  selectedAgentId,
  activeThreadId,
  agentBuilderAvailable,
  canCreateSession,
  onSelectAgent,
  onOpenSession,
  onCreateSession,
  onOpenAgentBuilder,
}: WorkspaceKeyboardProps) {
  const settings = useKeyboardSettings(locale)
  const [commandOpen, setCommandOpen] = React.useState(false)
  const [referenceOpen, setReferenceOpen] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [triggerHost, setTriggerHost] = React.useState<HTMLElement | null>(null)
  const [keyboardPlatform, setKeyboardPlatform] =
    React.useState<KeyboardPlatform>("windows")
  const coordinatorRef = React.useRef(createFocusRegionCoordinator())

  React.useEffect(() => {
    const root = rootRef.current
    if (!root) return
    // Assistant UI owns these elements; the attributes let F6 discover their
    // layout order without taking ownership of Tab or composer behavior.
    return observeKeyboardRegions(root)
  }, [rootRef])

  React.useEffect(() => {
    setTriggerHost(
      rootRef.current?.querySelector<HTMLElement>(
        "[data-keyboard-commands-host]"
      ) ?? null
    )
    setKeyboardPlatform(detectKeyboardPlatform())
  }, [rootRef])

  const execute = React.useCallback(
    (actionId: string) => {
      const root = rootRef.current
      if (actionId === "commands.open") setCommandOpen(true)
      else if (actionId === "settings.openKeyboard") setSettingsOpen(true)
      else if (actionId === "keyboard.reference") setReferenceOpen(true)
      else if (actionId === "workspace.focusNextPane")
        coordinatorRef.current.focusNext(root ?? document.body)
      else if (actionId === "workspace.focusPreviousPane")
        coordinatorRef.current.focusPrevious(root ?? document.body)
      else if (actionId === "workspace.focusAgents") focusRegion(root, "agents")
      else if (actionId === "workspace.focusSessions")
        focusRegion(root, "sessions")
      else if (actionId === "workspace.focusConversation") {
        if (!focusRegion(root, "transcript")) focusRegion(root, "conversation")
      } else if (actionId === "conversation.search") {
        if (activeThreadId)
          window.dispatchEvent(new Event("aos:conversation-search"))
      } else if (actionId === "workspace.focusInspector")
        focusRegion(root, "inspector")
      else if (actionId === "workspace.contextMenu") {
        const active = document.activeElement
        if (active instanceof HTMLElement)
          active.dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
          )
      } else if (actionId === "workspace.newAgent")
        runAction(agentBuilderAvailable ? onOpenAgentBuilder : undefined)
      else if (actionId === "workspace.newSession")
        runAction(
          selectedAgentId && canCreateSession
            ? () => onCreateSession(selectedAgentId)
            : undefined
        )
      else if (actionId === "workspace.nextAgent")
        selectNeighbor(agents, selectedAgentId, 1, onSelectAgent)
      else if (actionId === "workspace.previousAgent")
        selectNeighbor(agents, selectedAgentId, -1, onSelectAgent)
      else if (actionId === "workspace.nextSession")
        selectNeighbor(
          openSessions,
          activeThreadId,
          1,
          onOpenSession,
          "threadId"
        )
      else if (actionId === "workspace.previousSession")
        selectNeighbor(
          openSessions,
          activeThreadId,
          -1,
          onOpenSession,
          "threadId"
        )
    },
    [
      activeThreadId,
      agentBuilderAvailable,
      agents,
      canCreateSession,
      onCreateSession,
      onOpenAgentBuilder,
      onOpenSession,
      onSelectAgent,
      openSessions,
      rootRef,
      selectedAgentId,
    ]
  )
  const runCommand = React.useEffectEvent((actionId: string) =>
    execute(actionId)
  )

  React.useEffect(() => {
    const dispatcher = createKeyboardDispatcher({
      catalog: KEYBOARD_UI_CATALOG,
      overrides: settings.overrides,
      owners: [
        {
          id: "workspace-keyboard",
          actions: new Set(KEYBOARD_UI_CATALOG.map((action) => action.id)),
          handle: (actionId) => {
            execute(actionId)
            return true
          },
        },
      ],
    })
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      // Base UI owns focus containment while a workspace dialog is open. Do
      // not let the global workspace dispatcher act through that modal.
      if (document.querySelector('[role="dialog"], [role="alertdialog"]'))
        return
      dispatcher.dispatch(event)
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [execute, settings.overrides])

  const commands = ((): KeyboardCommand[] => {
    const actionBinding = (id: string) => {
      const action = settings.effectiveBindings.find((item) => item.id === id)
      return action?.bindings[0]
        ? formatKeyboardBinding(action.bindings[0], locale, keyboardPlatform)
        : undefined
    }
    const unavailable = (
      id: string,
      title: string,
      reason?: string
    ): KeyboardCommand => ({
      id,
      title,
      unavailableReason: reason,
      onRun: reason ? undefined : () => runCommand(id),
      binding: actionBinding(id),
    })
    const result: KeyboardCommand[] = [
      unavailable(
        "workspace.focusAgents",
        localCopy[locale].focusAgents,
        agents.length
          ? undefined
          : locale === "he"
            ? "אין סוכנים זמינים"
            : "No Agents are available"
      ),
      unavailable(
        "workspace.focusSessions",
        localCopy[locale].focusSessions,
        openSessions.length
          ? undefined
          : locale === "he"
            ? "אין שיחות פתוחות"
            : "No open Sessions"
      ),
      unavailable(
        "workspace.focusConversation",
        localCopy[locale].focusConversation
      ),
      unavailable(
        "conversation.search",
        localCopy[locale].searchConversation,
        activeThreadId
          ? undefined
          : locale === "he"
            ? "אין שיחה פעילה"
            : "No active conversation"
      ),
      unavailable("workspace.focusInspector", localCopy[locale].focusInspector),
      unavailable(
        "workspace.newAgent",
        localCopy[locale].newAgent,
        agentBuilderAvailable
          ? undefined
          : locale === "he"
            ? "בונה הסוכנים אינו זמין"
            : "Agent Builder is unavailable"
      ),
      unavailable(
        "workspace.newSession",
        localCopy[locale].newSession,
        selectedAgentId && canCreateSession
          ? undefined
          : locale === "he"
            ? "בחרו סוכן זמין תחילה"
            : "Select an available Agent first"
      ),
      unavailable(
        "workspace.nextAgent",
        localCopy[locale].nextAgent,
        agents.length > 1
          ? undefined
          : locale === "he"
            ? "אין סוכן נוסף"
            : "No other Agent is available"
      ),
      unavailable(
        "workspace.previousAgent",
        localCopy[locale].previousAgent,
        agents.length > 1
          ? undefined
          : locale === "he"
            ? "אין סוכן נוסף"
            : "No other Agent is available"
      ),
      unavailable(
        "workspace.nextSession",
        localCopy[locale].nextSession,
        openSessions.length > 1
          ? undefined
          : locale === "he"
            ? "אין שיחה נוספת"
            : "No other Session is available"
      ),
      unavailable(
        "workspace.previousSession",
        localCopy[locale].previousSession,
        openSessions.length > 1
          ? undefined
          : locale === "he"
            ? "אין שיחה נוספת"
            : "No other Session is available"
      ),
      unavailable("settings.openKeyboard", localCopy[locale].settings),
      unavailable(
        "keyboard.reference",
        locale === "he" ? "מקשי קיצור" : "Keyboard reference"
      ),
      unavailable(
        "workspace.contextMenu",
        locale === "he" ? "פתיחת תפריט הקשר" : "Open context menu"
      ),
    ]
    for (const agent of agents)
      result.push({
        id: `agent:${agent.id}`,
        title: `${localCopy[locale].selectAgent}: ${agent.name}`,
        onRun: () => onSelectAgent(agent.id),
      })
    const sessionsByThreadId = new Map<string, WorkspaceKeyboardSession>()
    for (const session of [...openSessions, ...olderSessions]) {
      if (!sessionsByThreadId.has(session.threadId)) {
        sessionsByThreadId.set(session.threadId, session)
      }
    }
    for (const session of sessionsByThreadId.values())
      result.push({
        id: `session:${session.threadId}`,
        title: `${localCopy[locale].openSession}: ${session.title}`,
        onRun: () => onOpenSession(session.threadId),
      })
    return agentBuilderAvailable
      ? result
      : result.filter(({ id }) => id !== "workspace.newAgent")
  })()

  const commandBinding = settings.effectiveBindings.find(
    (action) => action.id === "commands.open"
  )?.bindings[0]
  return (
    <>
      {triggerHost
        ? createPortal(
            <button
              type="button"
              data-keyboard-commands-trigger="true"
              className={workspaceStyles.commandsTrigger}
              aria-label={`${localCopy[locale].commands}${commandBinding ? ` (${formatKeyboardBinding(commandBinding, locale, keyboardPlatform)})` : ""}`}
              title={localCopy[locale].openCommands}
              onClick={() => setCommandOpen(true)}
            >
              {commandBinding ? (
                <kbd className="text-[0.65rem]">
                  {formatKeyboardBinding(
                    commandBinding,
                    locale,
                    keyboardPlatform
                  )}
                </kbd>
              ) : null}
            </button>,
            triggerHost
          )
        : null}
      <CommandPalette
        open={commandOpen}
        locale={locale}
        commands={commands}
        onOpenChange={setCommandOpen}
      />
      <KeyboardReference
        open={referenceOpen}
        locale={locale}
        actions={settings.effectiveBindings}
        onOpenChange={setReferenceOpen}
      />
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-h-[min(88svh,52rem)] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{localCopy[locale].settings}</DialogTitle>
            <DialogDescription>
              {localCopy[locale].commandDescription}
            </DialogDescription>
          </DialogHeader>
          <KeyboardShortcutsSettings
            locale={locale}
            effectiveBindings={settings.effectiveBindings}
            setBinding={settings.setBinding}
            resetBinding={settings.resetBinding}
            resetAll={settings.resetAll}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}

function focusRegion(root: HTMLElement | null, name: string) {
  const target = root?.querySelector<HTMLElement>(
    `[data-keyboard-region="${name}"]`
  )
  if (!target) return false
  const focusable = target.querySelector<HTMLElement>(
    "button:not(:disabled), [tabindex]:not([tabindex='-1']), input, textarea"
  )
  ;(focusable ?? target).focus()
  return true
}

function selectNeighbor<T extends { id?: string; threadId?: string }>(
  items: readonly T[],
  selectedId: string | null,
  delta: 1 | -1,
  callback: (id: string) => void | Promise<unknown>,
  key: "id" | "threadId" = "id"
) {
  if (items.length === 0) return
  const current = items.findIndex((item) => item[key] === selectedId)
  const next = items[(current + delta + items.length) % items.length]
  const id = next?.[key]
  if (id) runAction(() => callback(id))
}
