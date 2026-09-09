"use client"

import {
  ThreadListPrimitive,
  type ThreadListRuntime,
} from "@assistant-ui/react"
import {
  BarChart3,
  CircleDashed,
  Compass,
  Layers3,
  Menu,
  PanelRightClose,
  PanelRightOpen,
  PenLine,
  Plus,
  Settings2,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react"
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  type ReactNode,
} from "react"

import { Button } from "@/components/ui/button"
import { getLocaleDirection, type Locale } from "@/lib/i18n/config"
import type { Dictionary } from "@/lib/i18n/dictionary"
import { cn } from "@/lib/utils"

import { WorkspacePreferences } from "./workspace-preferences"
import styles from "./workspace-shell.module.css"
import { SessionActions } from "./session-actions"
import { neighborAfterClose } from "./session-tab-undo"
import {
  ActivityBell,
  ActivityMarker,
  ActivityNotice,
  ActivityPanel,
  type BrowserSettingsView,
} from "./activity"
import type { ActivityView } from "./use-activity-coordinator"
import { needsAttention } from "@/lib/notifications/activity"
import { WorkspaceKeyboard } from "@/components/keyboard/workspace-keyboard"
import {
  MobileNavigator,
  mobileNavigatorReducer,
  type MobileAgentSessionCatalog,
  type MobileNavigatorCopy,
} from "./mobile-navigator"
import type { AgentSessionNavigation } from "./workspace-navigation-catalog"
import { AgentSessionHistory } from "./agent-session-history"
import type { NavigationActivitySummary } from "./navigation-activity"
import {
  SessionThreadListItem,
  SessionThreadListTitle,
  SessionThreadListTrigger,
} from "./session-thread-list-item"
import {
  getAgentNavigationActivity,
  getOtherVisibleAgentsNavigationActivity,
  getSessionNavigationActivity,
} from "./navigation-activity"

export type WorkspaceAgentStatus =
  "idle" | "active" | "running" | "attention" | "unknown"
export type WorkspaceSessionStatus =
  "idle" | "running" | "waiting-for-input" | "failed" | "unknown"

export type WorkspaceAgentIcon =
  | {
      kind: "symbol"
      symbol: "spark" | "layers" | "compass" | "chart" | "pen" | "unassigned"
      tone: "indigo" | "purple" | "teal" | "ochre" | "slate"
    }
  | { kind: "image"; src: string; alt?: string }

type WorkspaceAgentBase = {
  visibility?: "visible" | "hidden"
  role?: "creator"
  id: string
  name: string
  description?: string
  status?: WorkspaceAgentStatus
  icon?: WorkspaceAgentIcon
}

export type WorkspaceAgent = WorkspaceAgentBase & { kind?: "ready" }

export type WorkspaceSession = {
  threadId: string
  title: string
  status: WorkspaceSessionStatus
  updatedAt: string
  canClose?: boolean
}

export type WorkspaceActionResult = void | Promise<unknown>

export type WorkspaceShellProps = {
  activity?: ActivityView
  browserSettings?: BrowserSettingsView
  locale: Locale
  dictionary: Dictionary
  agents: readonly WorkspaceAgent[]
  agentCreatorId?: string
  openSessions: readonly WorkspaceSession[]
  olderSessions: readonly WorkspaceSession[]
  navigationCatalog?: ReadonlyMap<string, AgentSessionNavigation>
  threadListRuntime?: ThreadListRuntime
  selectedAgentId: string | null
  activeThreadId: string | null
  environmentLabel?: string
  agentBuilderAvailable?: boolean
  onSelectAgent: (agentId: string) => WorkspaceActionResult
  onOpenSession: (threadId: string) => WorkspaceActionResult
  onCloseSession: (threadId: string, agentId?: string) => WorkspaceActionResult
  onCreateSession: (agentId: string) => WorkspaceActionResult
  onOpenAgentBuilder: () => WorkspaceActionResult
  onManageAgents?: () => void
  onConversationObscuredChange?: (obscured: boolean) => void
  agentFocusRequest?: { agentId: string; nonce: number } | null
  onActionError?: (error: unknown) => void
  tabUndo?: { title: string; onUndo: () => WorkspaceActionResult } | null
  artifactOutputs?: ReactNode
  artifactViewer?: ReactNode
  artifactViewerOpen?: boolean
  artifactViewerLabel?: string
  onCloseArtifactViewer?: () => void
  children: ReactNode
}

const agentSymbols: Record<
  Extract<WorkspaceAgentIcon, { kind: "symbol" }>["symbol"],
  LucideIcon
> = {
  spark: Sparkles,
  layers: Layers3,
  compass: Compass,
  chart: BarChart3,
  pen: PenLine,
  unassigned: CircleDashed,
}

const fallbackSymbols = Object.keys(agentSymbols) as Array<
  keyof typeof agentSymbols
>
const fallbackTones = ["indigo", "purple", "teal", "ochre", "slate"] as const
const inspectorPreferenceKey = "aos_ui:workspace:inspector-open"
const inspectorPreferenceEvent = "aos_ui:inspector-preference-change"

function subscribeToInspectorPreference(listener: () => void) {
  window.addEventListener("storage", listener)
  window.addEventListener(inspectorPreferenceEvent, listener)

  return () => {
    window.removeEventListener("storage", listener)
    window.removeEventListener(inspectorPreferenceEvent, listener)
  }
}

function getInspectorPreference() {
  try {
    const preference = window.localStorage.getItem(inspectorPreferenceKey)
    if (preference === "false") return false
    if (preference === "true") return true
    return true
  } catch {
    return true
  }
}

function fallbackAgentIcon(agent: WorkspaceAgent) {
  const hash = [...`${agent.id}:${agent.name}`].reduce(
    (value, character) => (value * 31 + character.codePointAt(0)!) >>> 0,
    7
  )
  return {
    symbol: fallbackSymbols[hash % fallbackSymbols.length]!,
    tone: fallbackTones[
      Math.floor(hash / fallbackSymbols.length) % fallbackTones.length
    ]!,
  }
}

function isSafeAgentImageSource(src: string) {
  return (
    (src.startsWith("/") && !src.startsWith("//")) ||
    src.startsWith("blob:") ||
    /^data:image\/(?:avif|gif|jpeg|png|webp);/u.test(src)
  )
}

const focusableSelector = [
  "summary",
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  '[tabindex]:not([tabindex="-1"]):not(:disabled)',
].join(",")

function getTabId(threadId: string) {
  return `workspace-tab-${encodeURIComponent(threadId)}`
}

function reportActionError(
  error: unknown,
  onActionError: WorkspaceShellProps["onActionError"]
) {
  if (onActionError) {
    onActionError(error)
    return
  }

  console.error("AOS workspace action failed", error)
}

function runAction(
  action: () => WorkspaceActionResult,
  onActionError: WorkspaceShellProps["onActionError"]
) {
  try {
    void Promise.resolve(action()).catch((error: unknown) => {
      reportActionError(error, onActionError)
    })
  } catch (error) {
    reportActionError(error, onActionError)
  }
}

function agentStatusLabel(
  status: WorkspaceAgentStatus | undefined,
  dictionary: Dictionary
) {
  if (status === "active") return dictionary.status.active
  if (status === "running") return dictionary.status.running
  if (status === "attention") return dictionary.status.attention
  if (status === "unknown") return dictionary.status.unknown
  return dictionary.status.idle
}

function mobileNavigatorCopy(dictionary: Dictionary): MobileNavigatorCopy {
  return {
    agents: dictionary.workspace.agents,
    sessions: dictionary.workspace.sessions,
    backToAgents: dictionary.mobileNavigation.backToAgents,
    close: dictionary.actions.closePanel,
    searchAgents: dictionary.mobileNavigation.searchAgents,
    searchSessions: dictionary.mobileNavigation.searchSessions,
    openSessions: dictionary.mobileNavigation.openSessions,
    history: dictionary.mobileNavigation.history,
    newAgent: dictionary.actions.newAgent,
    newSession: dictionary.actions.newSession,
    manageAgents: dictionary.workspace.manageAgents,
    preferences: dictionary.mobileNavigation.preferences,
    agentDetails: dictionary.workspace.agentDetails,
    clearSearch: dictionary.mobileNavigation.clearSearch,
    noAgents: dictionary.empty.noAgents,
    noSessions: dictionary.empty.noSessions,
    noSearchResults: dictionary.mobileNavigation.noSearchResults,
    openSession: dictionary.actions.openSession,
    sessionActions: dictionary.actions.sessionActions,
    removeOpenSession: dictionary.mobileNavigation.removeOpenSession,
    selected: dictionary.mobileNavigation.selected,
    lastSelected: dictionary.mobileNavigation.lastSelected,
    statusLabel: dictionary.status.label,
    status: {
      active: dictionary.status.active,
      idle: dictionary.status.idle,
      running: dictionary.status.running,
      attention: dictionary.status.attention,
      unknown: dictionary.status.unknown,
      waitingForInput: dictionary.status.waitingForInput,
      failed: dictionary.status.failed,
    },
    unread: (count) => `${count} ${dictionary.activity.unread}`,
    needsAttention: dictionary.activity.needsAttention,
  }
}

export function AgentGlyph({
  agent,
  className,
}: {
  agent: WorkspaceAgent
  className?: string
}) {
  if (agent.icon?.kind === "image" && isSafeAgentImageSource(agent.icon.src)) {
    return (
      <span className={cn(styles.agentIcon, className)}>
        {/* Provider-owned Agent images may be remote and are intentionally not optimized. */}
        <img src={agent.icon.src} alt={agent.icon.alt ?? ""} />
      </span>
    )
  }

  const fallback = fallbackAgentIcon(agent)
  const symbol =
    agent.icon?.kind === "symbol" ? agent.icon.symbol : fallback.symbol
  const tone = agent.icon?.kind === "symbol" ? agent.icon.tone : fallback.tone
  const Icon = agentSymbols[symbol]

  return (
    <span
      className={cn(styles.agentIcon, className)}
      data-agent-symbol={symbol}
      data-tone={tone}
      aria-hidden="true"
    >
      <Icon />
    </span>
  )
}

type AgentsPanelProps = Pick<
  WorkspaceShellProps,
  | "agents"
  | "locale"
  | "selectedAgentId"
  | "dictionary"
  | "environmentLabel"
  | "agentBuilderAvailable"
  | "onSelectAgent"
  | "onOpenAgentBuilder"
  | "onManageAgents"
  | "onActionError"
> & {
  onAfterSelectAgent?: () => void
  activity?: ActivityView
  activityButton?: ReactNode
  commandsHost?: boolean
}

function AgentsPanel({
  agents,
  locale,
  selectedAgentId,
  dictionary,
  environmentLabel,
  agentBuilderAvailable = true,
  onSelectAgent,
  onOpenAgentBuilder,
  onManageAgents,
  onActionError,
  onAfterSelectAgent,
  activity,
  activityButton,
  commandsHost = false,
}: AgentsPanelProps) {
  return (
    <div className={styles.agentsPanel}>
      <div className={cn(styles.brand, styles.desktopBrand)}>
        <img
          className={styles.brandLogo}
          src="/logo-adaptive.svg"
          alt=""
          width={32}
          height={32}
        />
        <span className="aos-wordmark">{dictionary.productName}</span>
        {environmentLabel ? (
          <span className={styles.environmentLabel}>{environmentLabel}</span>
        ) : null}
      </div>

      <div className={styles.panelHeading}>
        <h2>{dictionary.workspace.agents}</h2>
        <div className={styles.headingActions}>
          {activityButton}
          {agentBuilderAvailable ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={dictionary.actions.newAgent}
              onClick={() => runAction(onOpenAgentBuilder, onActionError)}
            >
              <Plus />
            </Button>
          ) : null}
        </div>
      </div>

      <nav
        className={styles.agentList}
        aria-label={dictionary.workspace.agents}
      >
        {agents.map((agent) => {
          const indicator = navigationActivity(activity, dictionary, {
            agentId: agent.id,
          })
          const isSelected = agent.id === selectedAgentId
          const statusLabel = agentStatusLabel(agent.status, dictionary)
          const accessibleName = [
            agent.name,
            agent.status && agent.status !== "idle"
              ? `${dictionary.status.label}: ${statusLabel}`
              : null,
            isSelected ? dictionary.accessibility.selectedAgent : null,
            indicator.label,
          ]
            .filter(Boolean)
            .join(", ")

          return (
            <button
              className={styles.agentButton}
              type="button"
              key={agent.id}
              data-agent-id={agent.id}
              aria-current={isSelected ? "true" : undefined}
              aria-label={accessibleName}
              onClick={() => {
                runAction(() => onSelectAgent(agent.id), onActionError)
                onAfterSelectAgent?.()
              }}
            >
              <AgentGlyph agent={agent} />
              <span className={styles.agentText}>
                <span className={styles.agentName}>
                  <bdi>{agent.name}</bdi>
                  {indicator.marker}
                </span>
                {agent.description ? (
                  <bdi className={styles.agentDescription}>
                    {agent.description}
                  </bdi>
                ) : null}
              </span>
              {agent.status && agent.status !== "idle" ? (
                <span
                  className={styles.statusDot}
                  data-status={agent.status}
                  title={statusLabel}
                  aria-hidden="true"
                />
              ) : null}
            </button>
          )
        })}
      </nav>

      <Button
        className={styles.manageButton}
        type="button"
        variant="ghost"
        onClick={onManageAgents}
        data-manage-agents
      >
        <Settings2 data-icon="inline-start" />
        {dictionary.workspace.manageAgents}
      </Button>

      <WorkspacePreferences
        locale={locale}
        dictionary={dictionary}
        commandsHost={commandsHost}
      />
    </div>
  )
}

type SessionTabsProps = Pick<
  WorkspaceShellProps,
  | "locale"
  | "dictionary"
  | "openSessions"
  | "activeThreadId"
  | "selectedAgentId"
  | "onOpenSession"
  | "onCloseSession"
  | "onCreateSession"
  | "onActionError"
  | "threadListRuntime"
> & {
  activity?: ActivityView
  inspectorOpen: boolean
  onToggleInspector: () => void
}

function SessionTabs({
  locale,
  dictionary,
  openSessions,
  activeThreadId,
  selectedAgentId,
  onOpenSession,
  onCloseSession,
  onCreateSession,
  onActionError,
  threadListRuntime,
  inspectorOpen,
  onToggleInspector,
  activity,
}: SessionTabsProps) {
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null)
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null)
  const activeIndex = openSessions.findIndex(
    (session) => session.threadId === activeThreadId
  )
  const activeSession = openSessions[activeIndex]
  const closingTab = useRef<{
    threadId: string
    replacement: string | null
  } | null>(null)
  const newSessionRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (
      !closingTab.current ||
      openSessions.some(
        ({ threadId }) => threadId === closingTab.current?.threadId
      )
    )
      return
    const { replacement } = closingTab.current
    // Removing the local tab can render before the provider publishes selection.
    // Keep the handoff until its intended neighbor is both selected and mounted.
    const target = replacement ? tabRefs.current.get(replacement) : null
    if (replacement && (activeThreadId !== replacement || !target)) return
    if (!replacement && openSessions.length > 0) return
    closingTab.current = null
    ;(
      target ??
      newSessionRef.current ??
      document.getElementById("workspace-conversation-panel")
    )?.focus()
  }, [openSessions, activeThreadId])

  function closeTab(threadId: string) {
    closingTab.current = {
      threadId,
      replacement: neighborAfterClose(
        openSessions.map((session) => session.threadId),
        threadId,
        activeThreadId
      ),
    }
    runAction(
      () => onCloseSession(threadId, selectedAgentId ?? undefined),
      onActionError
    )
  }

  function moveToTab(index: number, event: KeyboardEvent<HTMLButtonElement>) {
    const session = openSessions[index]
    if (!session) return

    event.preventDefault()
    tabRefs.current.get(session.threadId)?.focus()
    runAction(() => onOpenSession(session.threadId), onActionError)
  }

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number
  ) {
    if (openSessions.length === 0) return

    const lastIndex = openSessions.length - 1
    if (event.key === "Home") {
      moveToTab(0, event)
      return
    }
    if (event.key === "End") {
      moveToTab(lastIndex, event)
      return
    }

    const visualNextKey = locale === "he" ? "ArrowLeft" : "ArrowRight"
    const visualPreviousKey = locale === "he" ? "ArrowRight" : "ArrowLeft"
    if (event.key !== visualNextKey && event.key !== visualPreviousKey) return

    const delta = event.key === visualNextKey ? 1 : -1
    const nextIndex =
      (currentIndex + delta + openSessions.length) % openSessions.length
    moveToTab(nextIndex, event)
  }

  return (
    <div className={styles.tabBar}>
      <div
        className={styles.tabViewport}
        data-tab-viewport
        onMouseLeave={() => setHoveredThreadId(null)}
      >
        <div
          className={styles.tabTrack}
          style={
            {
              "--workspace-session-count": Math.max(openSessions.length, 1),
            } as CSSProperties
          }
        >
          <ThreadListPrimitive.Root
            className={styles.tabList}
            role="tablist"
            aria-label={dictionary.workspace.sessions}
            aria-orientation="horizontal"
          >
            {openSessions.map((session, index) => {
              const isActive = session.threadId === activeThreadId
              const indicator = navigationActivity(activity, dictionary, {
                threadId: session.threadId,
              })

              return (
                <SessionThreadListItem
                  runtime={threadListRuntime}
                  threadId={session.threadId}
                  onSwitch={() => onOpenSession(session.threadId)}
                  onActionError={onActionError}
                  key={session.threadId}
                  className={styles.threadItemContents}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                      event.preventDefault()
                    }
                  }}
                >
                  <SessionThreadListTrigger
                    className={styles.tab}
                    data-active={isActive ? "true" : undefined}
                    data-closable={session.canClose ? "true" : undefined}
                    ref={(element) => {
                      if (element)
                        tabRefs.current.set(session.threadId, element)
                      else tabRefs.current.delete(session.threadId)
                    }}
                    id={getTabId(session.threadId)}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    title={session.title}
                    aria-label={
                      indicator.label
                        ? `${session.title}, ${indicator.label}`
                        : undefined
                    }
                    aria-controls="workspace-conversation-panel"
                    tabIndex={
                      isActive || (activeIndex === -1 && index === 0) ? 0 : -1
                    }
                    onKeyDown={(event) => handleTabKeyDown(event, index)}
                    onMouseEnter={() => setHoveredThreadId(session.threadId)}
                    onFocus={() => setFocusedThreadId(session.threadId)}
                    onBlur={() => setFocusedThreadId(null)}
                  >
                    <span className={styles.tabLabel}>
                      <bdi>
                        <SessionThreadListTitle fallback={session.title} />
                      </bdi>
                      {indicator.marker}
                    </span>
                  </SessionThreadListTrigger>
                </SessionThreadListItem>
              )
            })}
          </ThreadListPrimitive.Root>

          <div className={styles.tabCloseList}>
            {openSessions.map((session) => (
              <span
                className={styles.tabCloseSlot}
                key={session.threadId}
                onMouseEnter={() => setHoveredThreadId(session.threadId)}
              >
                {session.canClose ? (
                  <Button
                    className={styles.tabClose}
                    data-visible={
                      hoveredThreadId === session.threadId ||
                      focusedThreadId === session.threadId
                        ? "true"
                        : undefined
                    }
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`${dictionary.actions.closeSession}: ${session.title}`}
                    onClick={() => closeTab(session.threadId)}
                  >
                    <X />
                  </Button>
                ) : null}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className={styles.sessionActions} data-session-actions>
        {selectedAgentId && openSessions.length > 0 ? (
          <Button
            ref={newSessionRef}
            className={styles.newSessionButton}
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={dictionary.actions.newSession}
            onClick={() =>
              runAction(() => onCreateSession(selectedAgentId), onActionError)
            }
          >
            <Plus />
          </Button>
        ) : null}
        {activeSession?.canClose ? (
          <SessionActions
            locale={locale}
            session={activeSession}
            dictionary={dictionary}
            onClose={() => closeTab(activeSession.threadId)}
          />
        ) : null}
      </div>
      <Button
        className={styles.desktopInspectorToggle}
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={
          inspectorOpen
            ? dictionary.actions.hideAgentDetails
            : dictionary.actions.showAgentDetails
        }
        aria-controls="workspace-agent-inspector"
        aria-expanded={inspectorOpen}
        onClick={onToggleInspector}
      >
        {inspectorOpen ? (
          <PanelRightClose
            style={{
              transform: locale === "he" ? "scaleX(-1)" : undefined,
            }}
          />
        ) : (
          <PanelRightOpen
            style={{
              transform: locale === "he" ? "scaleX(-1)" : undefined,
            }}
          />
        )}
      </Button>
    </div>
  )
}

type InspectorPanelProps = Pick<
  WorkspaceShellProps,
  | "locale"
  | "dictionary"
  | "activeThreadId"
  | "onOpenSession"
  | "onActionError"
  | "threadListRuntime"
> & {
  agent: WorkspaceAgent | null
  navigation: AgentSessionNavigation | null
  sessionActivity: Readonly<
    Record<string, NavigationActivitySummary | undefined>
  >
  artifactOutputs?: ReactNode
}

function InspectorPanel({
  locale,
  dictionary,
  activeThreadId,
  onOpenSession,
  onActionError,
  threadListRuntime,
  agent,
  navigation,
  sessionActivity,
  artifactOutputs,
}: InspectorPanelProps) {
  const [query, setQuery] = useState("")

  if (!agent) {
    return (
      <div className={styles.inspectorPanel}>
        <p className={styles.emptyText}>{dictionary.empty.noAgentSelected}</p>
      </div>
    )
  }

  const statusLabel = agentStatusLabel(agent.status, dictionary)

  return (
    <div className={styles.inspectorPanel}>
      <div className={styles.inspectorIdentity}>
        <AgentGlyph agent={agent} />
        <div className={styles.agentText}>
          <bdi className={styles.inspectorName}>{agent.name}</bdi>
          <div className={styles.statusLine}>
            {agent.status && agent.status !== "idle" ? (
              <span
                className={styles.statusDot}
                data-status={agent.status}
                aria-hidden="true"
              />
            ) : null}
            <span>{statusLabel}</span>
          </div>
        </div>
      </div>

      {agent.description ? (
        <bdi className={styles.inspectorDescription}>{agent.description}</bdi>
      ) : null}

      {navigation ? (
        <div className={styles.recentSessions}>
          <AgentSessionHistory
            navigation={navigation}
            activeThreadId={activeThreadId}
            sessionActivity={sessionActivity}
            locale={locale}
            copy={mobileNavigatorCopy(dictionary)}
            query={query}
            onQueryChange={setQuery}
            onOpenSession={(_agentId, threadId) => onOpenSession(threadId)}
            threadListRuntime={threadListRuntime}
            onActionError={onActionError}
          />
        </div>
      ) : null}
      {artifactOutputs ? (
        <div className={styles.inspectorOutputs}>{artifactOutputs}</div>
      ) : null}
    </div>
  )
}

type FocusDrawerProps = {
  desktop?: boolean
  open: boolean
  side: "start" | "end"
  title: string
  closeLabel: string
  onClose: () => void
  returnFocusRef?: RefObject<HTMLElement | null>
  children: ReactNode
  chrome?: boolean
  initialFocusSelector?: string
}

function FocusDrawer({
  desktop = false,
  open,
  side,
  title,
  closeLabel,
  onClose,
  returnFocusRef,
  children,
  chrome = true,
  initialFocusSelector,
}: FocusDrawerProps) {
  const titleId = useId()
  const drawerRef = useRef<HTMLDivElement>(null)
  const closeDrawer = useEffectEvent(onClose)

  useEffect(() => {
    if (!open) return

    const previousFocus = document.activeElement as HTMLElement | null
    const returnFocus = returnFocusRef?.current ?? previousFocus
    const drawer = drawerRef.current
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"

    function getFocusableElements() {
      return [
        ...(drawer?.querySelectorAll<HTMLElement>(focusableSelector) ?? []),
      ].filter((element) => {
        if (element.closest("[hidden], [inert]")) return false
        const closedDetails = element.closest("details:not([open])")
        return (
          !closedDetails || element === closedDetails.querySelector("summary")
        )
      })
    }
    const focusableElements = getFocusableElements()
    ;(
      (initialFocusSelector
        ? drawer?.querySelector<HTMLElement>(initialFocusSelector)
        : null) ??
      focusableElements?.[0] ??
      drawer
    )?.focus()

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault()
        closeDrawer()
        return
      }

      if (event.key !== "Tab" || !drawer) return
      const focusable = getFocusableElements()
      if (focusable.length === 0) {
        event.preventDefault()
        drawer.focus()
        return
      }

      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }

    document.addEventListener("keydown", handleKeyDown)

    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      document.body.style.overflow = previousOverflow
      returnFocus?.focus()
    }
  }, [initialFocusSelector, open, returnFocusRef])

  if (!open) return null

  return (
    <div className={styles.drawerLayer} data-desktop={desktop || undefined}>
      <button
        className={styles.drawerScrim}
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        className={styles.drawer}
        data-side={side}
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 className={styles.srOnly} id={titleId}>
          {title}
        </h2>
        {chrome ? (
          <div className={styles.drawerHeader}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={closeLabel}
              onClick={onClose}
            >
              <X />
            </Button>
          </div>
        ) : null}
        <div className={styles.drawerContent} data-chrome={chrome || undefined}>
          {children}
        </div>
      </div>
    </div>
  )
}

export function WorkspaceShell({
  activity,
  browserSettings,
  locale,
  dictionary,
  agents,
  agentCreatorId,
  openSessions,
  olderSessions,
  navigationCatalog = new Map(),
  threadListRuntime,
  selectedAgentId,
  activeThreadId,
  environmentLabel,
  agentBuilderAvailable = true,
  onSelectAgent,
  onOpenSession,
  onCloseSession,
  onCreateSession,
  onOpenAgentBuilder,
  onManageAgents,
  onConversationObscuredChange,
  agentFocusRequest,
  onActionError,
  tabUndo,
  artifactOutputs,
  artifactViewer,
  artifactViewerOpen = false,
  artifactViewerLabel,
  onCloseArtifactViewer,
  children,
}: WorkspaceShellProps) {
  const shellRef = useRef<HTMLElement>(null)
  const [mobileNavigator, dispatchMobileNavigator] = useReducer(
    mobileNavigatorReducer,
    { view: "closed" }
  )
  const [activityOpen, setActivityOpen] = useState(false)
  const [desktopLayout, setDesktopLayout] = useState(false)
  const storedInspectorOpen = useSyncExternalStore(
    subscribeToInspectorPreference,
    getInspectorPreference,
    () => true
  )
  const [volatileInspectorOpen, setVolatileInspectorOpen] = useState<
    boolean | null
  >(null)
  const desktopInspectorOpen = volatileInspectorOpen ?? storedInspectorOpen
  const effectiveInspectorOpen = desktopInspectorOpen || artifactViewerOpen
  const agentDrawerTriggerRef = useRef<HTMLButtonElement>(null)
  const mobileNavigatorOpen = mobileNavigator.view !== "closed"
  const artifactDrawerOpen = artifactViewerOpen && !desktopLayout
  const modalDrawerOpen =
    mobileNavigatorOpen || activityOpen || artifactDrawerOpen
  useEffect(() => {
    onConversationObscuredChange?.(modalDrawerOpen)
    return () => onConversationObscuredChange?.(false)
  }, [modalDrawerOpen, onConversationObscuredChange])
  const unread = activity?.items.filter((item) => !item.read).length ?? 0
  const activityButton = (
    <ActivityBell
      dictionary={dictionary}
      unread={unread}
      open={activityOpen}
      onOpen={() => {
        dispatchMobileNavigator({ type: "DISMISS" })
        activity?.dismissNotice()
        setActivityOpen(true)
      }}
    />
  )
  const selectedAgent =
    agents.find((agent) => agent.id === selectedAgentId) ?? null
  const selectedNavigation = useMemo<AgentSessionNavigation | null>(() => {
    if (!selectedAgentId) return null
    const catalog = navigationCatalog.get(selectedAgentId)
    if (catalog) return catalog
    const openIds = new Set(openSessions.map((session) => session.threadId))
    return {
      agentId: selectedAgentId,
      openSessions,
      historySessions: olderSessions.filter(
        (session) => !openIds.has(session.threadId)
      ),
      lastSelectedThreadId: activeThreadId,
    }
  }, [
    activeThreadId,
    navigationCatalog,
    olderSessions,
    openSessions,
    selectedAgentId,
  ])
  const rosterAgents = useMemo(
    () =>
      agents.filter(
        (agent) =>
          agent.id !== agentCreatorId &&
          agent.role !== "creator" &&
          agent.visibility !== "hidden"
      ),
    [agentCreatorId, agents]
  )
  const activeTabId = activeThreadId ? getTabId(activeThreadId) : undefined
  const activeSession = [...openSessions, ...olderSessions].find(
    ({ threadId }) => threadId === activeThreadId
  )
  const retainUndoFocus = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    // Ref cleanup runs before removal, while focused Undo is still detectable.
    return () => {
      if (!node.contains(document.activeElement)) return
      const shell = node.closest("section")
      const target =
        shell?.querySelector<HTMLElement>(
          '[role="tab"][aria-selected="true"]'
        ) ?? shell?.querySelector<HTMLElement>("#workspace-conversation-panel")
      target?.focus()
    }
  }, [])

  useEffect(() => {
    if (!agentFocusRequest) return
    const target = [
      ...document.querySelectorAll<HTMLButtonElement>("[data-agent-id]"),
    ].find(({ dataset }) => dataset.agentId === agentFocusRequest.agentId)
    target?.focus()
  }, [agentFocusRequest])

  useEffect(() => {
    const shell = shellRef.current
    if (!shell || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const desktop = entry.contentRect.width >= 1024
      setDesktopLayout(desktop)
      if (desktop) dispatchMobileNavigator({ type: "ENTER_DESKTOP" })
    })
    observer.observe(shell)
    return () => observer.disconnect()
  }, [])

  function toggleDesktopInspector() {
    const nextValue = !desktopInspectorOpen
    try {
      window.localStorage.setItem(inspectorPreferenceKey, String(nextValue))
      setVolatileInspectorOpen(null)
      window.dispatchEvent(new Event(inspectorPreferenceEvent))
    } catch {
      setVolatileInspectorOpen(nextValue)
    }
  }

  const agentsPanelProps: AgentsPanelProps = {
    activity,
    agents: rosterAgents,
    locale,
    selectedAgentId,
    dictionary,
    environmentLabel,
    agentBuilderAvailable,
    onSelectAgent,
    onOpenAgentBuilder,
    onManageAgents: () => {
      dispatchMobileNavigator({ type: "DISMISS" })
      onManageAgents?.()
    },
    onActionError,
  }
  const inspectorPanelProps: InspectorPanelProps = {
    locale,
    dictionary,
    navigation: selectedNavigation,
    sessionActivity: Object.fromEntries(
      [
        ...(selectedNavigation?.openSessions ?? []),
        ...(selectedNavigation?.historySessions ?? []),
      ].map((session) => [
        session.threadId,
        getSessionNavigationActivity(
          activity?.items ?? [],
          selectedNavigation?.agentId ?? "",
          session.threadId
        ),
      ])
    ),
    threadListRuntime,
    activeThreadId,
    onOpenSession,
    onActionError,
    agent: selectedAgent,
    artifactOutputs,
  }

  return (
    <div className={styles.workspaceContainer}>
      <section
        ref={shellRef}
        className={styles.shell}
        data-inspector-open={effectiveInspectorOpen ? "true" : "false"}
        data-artifact-viewer-open={artifactViewerOpen ? "true" : "false"}
        dir={getLocaleDirection(locale)}
      >
        <a
          className={styles.skipLink}
          href="#workspace-conversation-panel"
          aria-hidden={modalDrawerOpen || undefined}
          inert={modalDrawerOpen ? true : undefined}
        >
          {dictionary.accessibility.skipToConversation}
        </a>

        <header
          className={styles.mobileHeader}
          aria-hidden={modalDrawerOpen || undefined}
          inert={modalDrawerOpen ? true : undefined}
        >
          <Button
            className={styles.drawerTrigger}
            ref={agentDrawerTriggerRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={dictionary.actions.openAgents}
            aria-expanded={mobileNavigatorOpen}
            onClick={() => {
              dispatchMobileNavigator({ type: "OPEN", selectedAgentId })
            }}
          >
            <Menu />
          </Button>
          {selectedAgent ? (
            <div
              className={styles.mobileIdentity}
              role="group"
              aria-label={[
                selectedAgent.name,
                activeSession?.title,
                `${dictionary.status.label}: ${agentStatusLabel(
                  selectedAgent.status,
                  dictionary
                )}`,
              ]
                .filter(Boolean)
                .join(", ")}
            >
              <AgentGlyph agent={selectedAgent} />
              <span className={styles.mobileIdentityText}>
                <bdi className={styles.mobileAgentName}>
                  {selectedAgent.name}
                </bdi>
                {activeSession ? (
                  <bdi className={styles.mobileSessionName}>
                    {activeSession.title}
                  </bdi>
                ) : null}
              </span>
              <span
                className={styles.statusDot}
                data-status={selectedAgent.status ?? "idle"}
                title={agentStatusLabel(selectedAgent.status, dictionary)}
                aria-hidden="true"
              />
            </div>
          ) : (
            <span className={styles.mobileAgentName}>
              {dictionary.productName}
            </span>
          )}
          {activityButton}
          {environmentLabel ? (
            <span className={styles.environmentLabel}>{environmentLabel}</span>
          ) : null}
        </header>

        <aside
          className={styles.desktopAgents}
          data-keyboard-region="agents"
          aria-label={dictionary.workspace.agents}
          aria-hidden={modalDrawerOpen || undefined}
          inert={modalDrawerOpen ? true : undefined}
        >
          <AgentsPanel
            {...agentsPanelProps}
            activityButton={activityButton}
            commandsHost
          />
        </aside>

        <div
          className={styles.conversationColumn}
          aria-hidden={modalDrawerOpen || undefined}
          inert={modalDrawerOpen ? true : undefined}
        >
          <div data-keyboard-region="sessions" className="contents">
            <SessionTabs
              activity={activity}
              locale={locale}
              dictionary={dictionary}
              openSessions={openSessions}
              activeThreadId={activeThreadId}
              selectedAgentId={selectedAgentId}
              onOpenSession={onOpenSession}
              onCloseSession={onCloseSession}
              onCreateSession={onCreateSession}
              onActionError={onActionError}
              threadListRuntime={threadListRuntime}
              inspectorOpen={effectiveInspectorOpen}
              onToggleInspector={
                artifactViewerOpen && onCloseArtifactViewer
                  ? onCloseArtifactViewer
                  : toggleDesktopInspector
              }
            />
          </div>
          <main
            className={styles.conversation}
            data-keyboard-region="conversation"
            aria-label={dictionary.workspace.conversation}
          >
            <div
              className={styles.conversationPanel}
              id="workspace-conversation-panel"
              role="tabpanel"
              aria-labelledby={activeTabId}
              tabIndex={-1}
            >
              {children}
            </div>
          </main>
        </div>

        <aside
          id="workspace-agent-inspector"
          className={styles.desktopInspector}
          data-keyboard-region="inspector"
          aria-label={
            artifactViewerOpen
              ? (artifactViewerLabel ?? dictionary.workspace.agentDetails)
              : dictionary.workspace.agentDetails
          }
          aria-hidden={modalDrawerOpen || undefined}
          inert={modalDrawerOpen ? true : undefined}
          hidden={!effectiveInspectorOpen}
        >
          {artifactViewerOpen && artifactViewer ? (
            artifactViewer
          ) : (
            <InspectorPanel
              key={selectedAgentId ?? "no-agent"}
              {...inspectorPanelProps}
            />
          )}
        </aside>

        <WorkspaceKeyboard
          locale={locale}
          rootRef={shellRef}
          agents={rosterAgents}
          openSessions={openSessions}
          olderSessions={olderSessions}
          selectedAgentId={selectedAgentId}
          activeThreadId={activeThreadId}
          agentBuilderAvailable={agentBuilderAvailable}
          canCreateSession={Boolean(selectedAgentId)}
          onSelectAgent={onSelectAgent}
          onOpenSession={onOpenSession}
          onCreateSession={onCreateSession}
          onOpenAgentBuilder={onOpenAgentBuilder}
        />

        {tabUndo ? (
          <div
            ref={retainUndoFocus}
            className={styles.tabUndo}
            role="status"
            aria-atomic="true"
            aria-hidden={modalDrawerOpen || undefined}
            inert={modalDrawerOpen ? true : undefined}
          >
            <span>
              {dictionary.actions.tabClosed}: <bdi>{tabUndo.title}</bdi>
            </span>
            <Button
              variant="ghost"
              onClick={() => runAction(tabUndo.onUndo, onActionError)}
            >
              {dictionary.actions.undo}
            </Button>
          </div>
        ) : null}

        <FocusDrawer
          open={mobileNavigatorOpen}
          side="start"
          title={
            mobileNavigator.view === "sessions"
              ? dictionary.workspace.sessions
              : dictionary.workspace.agents
          }
          closeLabel={dictionary.actions.closePanel}
          onClose={() => dispatchMobileNavigator({ type: "DISMISS" })}
          returnFocusRef={agentDrawerTriggerRef}
          chrome={false}
          initialFocusSelector="[data-mobile-navigator-heading]"
        >
          <MobileNavigator
            state={mobileNavigator}
            threadListRuntime={threadListRuntime}
            agents={rosterAgents}
            selectedAgentId={selectedAgentId}
            activeThreadId={activeThreadId}
            sessionsByAgentId={
              [
                ...navigationCatalog.values(),
              ] satisfies MobileAgentSessionCatalog[]
            }
            agentActivity={Object.fromEntries(
              rosterAgents.map((agent) => [
                agent.id,
                getAgentNavigationActivity(activity?.items ?? [], agent.id),
              ])
            )}
            otherAgentsActivity={getOtherVisibleAgentsNavigationActivity(
              activity?.items ?? [],
              mobileNavigator.view === "sessions"
                ? mobileNavigator.agentId
                : selectedAgentId,
              rosterAgents.map((agent) => agent.id)
            )}
            sessionActivity={Object.fromEntries(
              [...navigationCatalog.values()].flatMap((catalog) =>
                [...catalog.openSessions, ...catalog.historySessions].map(
                  (session) => [
                    session.threadId,
                    getSessionNavigationActivity(
                      activity?.items ?? [],
                      catalog.agentId,
                      session.threadId
                    ),
                  ]
                )
              )
            )}
            locale={locale}
            copy={mobileNavigatorCopy(dictionary)}
            onActionError={onActionError}
            onStateChange={dispatchMobileNavigator}
            onOpenSession={(_agentId, threadId) =>
              runAction(() => onOpenSession(threadId), onActionError)
            }
            onCreateSession={(agentId) =>
              runAction(() => onCreateSession(agentId), onActionError)
            }
            onRemoveOpenSession={(agentId, threadId) =>
              runAction(() => onCloseSession(threadId, agentId), onActionError)
            }
            onNewAgent={
              agentBuilderAvailable
                ? () => {
                    dispatchMobileNavigator({ type: "DISMISS" })
                    runAction(onOpenAgentBuilder, onActionError)
                  }
                : undefined
            }
            onManageAgents={
              onManageAgents
                ? () => {
                    dispatchMobileNavigator({ type: "DISMISS" })
                    onManageAgents()
                  }
                : undefined
            }
            preferences={
              <WorkspacePreferences
                locale={locale}
                dictionary={dictionary}
                commandsHost
              />
            }
            renderAgentIcon={(agent) => <AgentGlyph agent={agent} />}
          />
        </FocusDrawer>

        <FocusDrawer
          open={artifactDrawerOpen}
          side="end"
          title={artifactViewerLabel ?? dictionary.workspace.agentDetails}
          closeLabel={dictionary.actions.closePanel}
          onClose={() => onCloseArtifactViewer?.()}
          chrome={false}
        >
          {artifactViewer}
        </FocusDrawer>

        {!modalDrawerOpen ? (
          <ActivityNotice
            notice={activity?.notice ?? null}
            dictionary={dictionary}
            onDismiss={() => activity?.dismissNotice()}
          />
        ) : null}
        <FocusDrawer
          open={activityOpen}
          desktop
          side="end"
          title={dictionary.activity.title}
          closeLabel={dictionary.actions.closePanel}
          onClose={() => setActivityOpen(false)}
        >
          <ActivityPanel
            activity={activity}
            locale={locale}
            dictionary={dictionary}
            settings={browserSettings}
            onOpened={() => setActivityOpen(false)}
          />
        </FocusDrawer>
      </section>
    </div>
  )
}

function navigationActivity(
  activity: ActivityView | undefined,
  dictionary: Dictionary,
  scope: { agentId?: string; threadId?: string }
) {
  const items =
    activity?.items.filter(
      (item) =>
        item.available &&
        (!scope.agentId || item.agentId === scope.agentId) &&
        (!scope.threadId || item.threadId === scope.threadId)
    ) ?? []
  const unread = items.filter((item) => !item.read).length
  const attention = items.some(needsAttention)
  const label = [
    attention ? dictionary.activity.needsAttention : null,
    unread ? `${unread} ${dictionary.activity.unread}` : null,
  ]
    .filter(Boolean)
    .join(", ")
  return {
    label,
    marker: (
      <ActivityMarker
        unread={unread}
        attention={attention}
        dictionary={dictionary}
      />
    ),
  }
}
