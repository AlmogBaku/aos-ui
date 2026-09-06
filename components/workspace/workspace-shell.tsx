"use client"

import Image from "next/image"
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
  RotateCcw,
  Settings2,
  Sparkles,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react"
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  type ReactNode,
} from "react"

import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
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

export type WorkspaceAgentStatus = "idle" | "running" | "attention"
export type WorkspaceSessionStatus =
  "idle" | "running" | "waiting-for-input" | "failed"

export type WorkspaceAgentIcon =
  | {
      kind: "symbol"
      symbol: "spark" | "layers" | "compass" | "chart" | "pen" | "unassigned"
      tone: "indigo" | "purple" | "teal" | "ochre" | "slate"
    }
  | { kind: "image"; src: string; alt?: string }

type WorkspaceAgentBase = {
  id: string
  name: string
  description?: string
  status?: WorkspaceAgentStatus
  icon?: WorkspaceAgentIcon
}

export type WorkspaceAgent = WorkspaceAgentBase &
  (
    | { kind?: "ready" }
    | {
        kind: "provisional"
        builderThreadId: string
        phase: "interview" | "start-failed" | "activating" | "activation-failed"
        lastError?: string
      }
  )

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
  openSessions: readonly WorkspaceSession[]
  olderSessions: readonly WorkspaceSession[]
  selectedAgentId: string | null
  activeThreadId: string | null
  environmentLabel?: string
  agentBuilderAvailable?: boolean
  onSelectAgent: (agentId: string) => WorkspaceActionResult
  onOpenSession: (threadId: string) => WorkspaceActionResult
  onCloseSession: (threadId: string) => WorkspaceActionResult
  onCreateSession: (agentId: string) => WorkspaceActionResult
  onOpenAgentBuilder: () => WorkspaceActionResult
  onManageAgents?: () => void
  onRetryAgentDraft?: (agentId: string) => WorkspaceActionResult
  onDeleteAgentDraft?: (agentId: string) => WorkspaceActionResult
  agentFocusRequest?: { agentId: string; nonce: number } | null
  onActionError?: (error: unknown) => void
  tabUndo?: { title: string; onUndo: () => WorkspaceActionResult } | null
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
  if (status === "running") return dictionary.status.running
  if (status === "attention") return dictionary.status.attention
  return dictionary.status.idle
}

function sessionStatusLabel(
  status: WorkspaceSessionStatus,
  dictionary: Dictionary
) {
  if (status === "running") return dictionary.status.running
  if (status === "waiting-for-input") {
    return dictionary.status.waitingForInput
  }
  if (status === "failed") return dictionary.status.failed
  return dictionary.status.idle
}

function provisionalAgentPhaseLabel(
  agent: Extract<WorkspaceAgent, { kind: "provisional" }>,
  dictionary: Dictionary
) {
  if (agent.phase === "start-failed") return dictionary.agentDraft.startFailed
  if (agent.phase === "activating") return dictionary.agentDraft.activating
  if (agent.phase === "activation-failed") {
    return dictionary.agentDraft.activationFailed
  }
  return dictionary.agentDraft.interview
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
        {/* eslint-disable-next-line @next/next/no-img-element */}
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
  | "onRetryAgentDraft"
  | "onDeleteAgentDraft"
> & {
  onAfterSelectAgent?: () => void
  activity?: ActivityView
  activityButton?: ReactNode
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
}: AgentsPanelProps) {
  return (
    <div className={styles.agentsPanel}>
      <div className={cn(styles.brand, styles.desktopBrand)}>
        <Image
          className={styles.brandLogo}
          src="/aos-ui-placeholder.svg"
          alt=""
          width={32}
          height={32}
          priority
        />
        <span>{dictionary.productName}</span>
        {environmentLabel ? (
          <span className={styles.environmentLabel}>{environmentLabel}</span>
        ) : null}
      </div>

      <div className={styles.panelHeading}>
        <h2>{dictionary.workspace.agents}</h2>
        <div className={styles.headingActions}>
          {activityButton}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={dictionary.actions.newAgent}
            disabled={!agentBuilderAvailable}
            title={
              agentBuilderAvailable
                ? undefined
                : dictionary.empty.agentBuilderUnavailable
            }
            onClick={() => runAction(onOpenAgentBuilder, onActionError)}
          >
            <Plus />
          </Button>
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

      <WorkspacePreferences locale={locale} dictionary={dictionary} />
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
    runAction(() => onCloseSession(threadId), onActionError)
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
          <div
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
                <button
                  className={styles.tab}
                  data-active={isActive ? "true" : undefined}
                  data-closable={session.canClose ? "true" : undefined}
                  ref={(element) => {
                    if (element) tabRefs.current.set(session.threadId, element)
                    else tabRefs.current.delete(session.threadId)
                  }}
                  id={getTabId(session.threadId)}
                  key={session.threadId}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-label={
                    indicator.label
                      ? `${session.title}, ${indicator.label}`
                      : undefined
                  }
                  aria-controls="workspace-conversation-panel"
                  tabIndex={
                    isActive || (activeIndex === -1 && index === 0) ? 0 : -1
                  }
                  onClick={() =>
                    runAction(
                      () => onOpenSession(session.threadId),
                      onActionError
                    )
                  }
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                  onMouseEnter={() => setHoveredThreadId(session.threadId)}
                  onFocus={() => setFocusedThreadId(session.threadId)}
                  onBlur={() => setFocusedThreadId(null)}
                >
                  <span className={styles.tabLabel}>
                    <bdi>{session.title}</bdi>
                    {indicator.marker}
                  </span>
                </button>
              )
            })}
          </div>

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
  | "olderSessions"
  | "activeThreadId"
  | "onOpenSession"
  | "onActionError"
  | "onRetryAgentDraft"
  | "onDeleteAgentDraft"
> & {
  agent: WorkspaceAgent | null
  activity?: ActivityView
}

function InspectorPanel({
  locale,
  dictionary,
  olderSessions,
  activeThreadId,
  onOpenSession,
  onActionError,
  onRetryAgentDraft,
  onDeleteAgentDraft,
  agent,
  activity,
}: InspectorPanelProps) {
  const recentSessionsHeadingId = useId()

  if (!agent) {
    return (
      <div className={styles.inspectorPanel}>
        <p className={styles.emptyText}>{dictionary.empty.noAgentSelected}</p>
      </div>
    )
  }

  const dateFormatter = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
  const statusLabel =
    agent.kind === "provisional"
      ? provisionalAgentPhaseLabel(agent, dictionary)
      : agentStatusLabel(agent.status, dictionary)

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

      {agent.kind === "provisional" ? (
        <div className={styles.draftDetails}>
          {agent.lastError ? (
            <bdi className={styles.draftError}>{agent.lastError}</bdi>
          ) : null}
          {(onRetryAgentDraft &&
            (agent.phase === "start-failed" ||
              agent.phase === "activation-failed")) ||
          (onDeleteAgentDraft &&
            (agent.phase === "interview" || agent.phase === "start-failed")) ? (
            <div className={styles.draftActions}>
              {onRetryAgentDraft &&
              (agent.phase === "start-failed" ||
                agent.phase === "activation-failed") ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    runAction(() => onRetryAgentDraft(agent.id), onActionError)
                  }
                >
                  <RotateCcw data-icon="inline-start" />
                  {dictionary.actions.retryAgentDraft}
                </Button>
              ) : null}
              {onDeleteAgentDraft &&
              (agent.phase === "interview" ||
                agent.phase === "start-failed") ? (
                <AlertDialog>
                  <AlertDialogTrigger
                    render={
                      <Button type="button" variant="destructive" size="sm" />
                    }
                  >
                    <Trash2 data-icon="inline-start" />
                    {dictionary.actions.deleteAgentDraft}
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {dictionary.agentDraft.deleteTitle}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {dictionary.agentDraft.deleteDescription}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>
                        {dictionary.agentDraft.deleteCancel}
                      </AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        onClick={() =>
                          runAction(
                            () => onDeleteAgentDraft(agent.id),
                            onActionError
                          )
                        }
                      >
                        {dictionary.agentDraft.deleteConfirm}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <section
        className={styles.recentSessions}
        aria-labelledby={recentSessionsHeadingId}
      >
        <h2 className={styles.recentHeading} id={recentSessionsHeadingId}>
          {dictionary.workspace.recentSessions}
        </h2>
        {olderSessions.length > 0 ? (
          <div className={styles.sessionList}>
            {olderSessions.map((session) => {
              const indicator = navigationActivity(activity, dictionary, {
                threadId: session.threadId,
              })
              const parsedDate = new Date(session.updatedAt)
              const isValidDate = Number.isFinite(parsedDate.getTime())
              const statusLabel = sessionStatusLabel(session.status, dictionary)
              const accessibleName = [
                `${dictionary.actions.openSession}: ${session.title}`,
                session.status !== "idle"
                  ? `${dictionary.status.label}: ${statusLabel}`
                  : null,
                indicator.label,
              ]
                .filter(Boolean)
                .join(", ")

              return (
                <button
                  className={styles.sessionButton}
                  type="button"
                  key={session.threadId}
                  aria-current={
                    session.threadId === activeThreadId ? "true" : undefined
                  }
                  aria-label={accessibleName}
                  onClick={() =>
                    runAction(
                      () => onOpenSession(session.threadId),
                      onActionError
                    )
                  }
                >
                  <span className={styles.sessionTitle}>
                    {session.status !== "idle" ? (
                      <span
                        className={styles.statusDot}
                        data-status={session.status}
                        title={statusLabel}
                        aria-hidden="true"
                      />
                    ) : null}
                    <bdi>{session.title}</bdi>
                    {indicator.marker}
                  </span>
                  {isValidDate ? (
                    <time
                      className={styles.sessionTime}
                      dateTime={session.updatedAt}
                    >
                      {dateFormatter.format(parsedDate)}
                    </time>
                  ) : null}
                </button>
              )
            })}
          </div>
        ) : (
          <p className={styles.emptyText}>{dictionary.empty.noSessions}</p>
        )}
      </section>
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
    ;(focusableElements?.[0] ?? drawer)?.focus()

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
  }, [open, returnFocusRef])

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
        <div className={styles.drawerContent}>{children}</div>
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
  openSessions,
  olderSessions,
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
  onRetryAgentDraft,
  onDeleteAgentDraft,
  agentFocusRequest,
  onActionError,
  tabUndo,
  children,
}: WorkspaceShellProps) {
  const shellRef = useRef<HTMLElement>(null)
  const [agentDrawerOpen, setAgentDrawerOpen] = useState(false)
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const storedInspectorOpen = useSyncExternalStore(
    subscribeToInspectorPreference,
    getInspectorPreference,
    () => true
  )
  const [volatileInspectorOpen, setVolatileInspectorOpen] = useState<
    boolean | null
  >(null)
  const desktopInspectorOpen = volatileInspectorOpen ?? storedInspectorOpen
  const agentDrawerTriggerRef = useRef<HTMLButtonElement>(null)
  const inspectorDrawerTriggerRef = useRef<HTMLButtonElement>(null)
  const modalDrawerOpen = agentDrawerOpen || inspectorDrawerOpen || activityOpen
  const unread = activity?.items.filter((item) => !item.read).length ?? 0
  const activityButton = (
    <ActivityBell
      dictionary={dictionary}
      unread={unread}
      open={activityOpen}
      onOpen={() => {
        setAgentDrawerOpen(false)
        setInspectorDrawerOpen(false)
        activity?.dismissNotice()
        setActivityOpen(true)
      }}
    />
  )
  const selectedAgent =
    agents.find((agent) => agent.id === selectedAgentId) ?? null
  const activeTabId = activeThreadId ? getTabId(activeThreadId) : undefined
  const identityStatusId = useId()
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
    agents,
    locale,
    selectedAgentId,
    dictionary,
    environmentLabel,
    agentBuilderAvailable,
    onSelectAgent,
    onOpenAgentBuilder,
    onManageAgents: () => {
      setAgentDrawerOpen(false)
      onManageAgents?.()
    },
    onActionError,
  }
  const inspectorPanelProps: InspectorPanelProps = {
    activity,
    locale,
    dictionary,
    olderSessions,
    activeThreadId,
    onOpenSession,
    onActionError,
    onRetryAgentDraft,
    onDeleteAgentDraft,
    agent: selectedAgent,
  }

  return (
    <div className={styles.workspaceContainer}>
      <section
        ref={shellRef}
        className={styles.shell}
        data-inspector-open={desktopInspectorOpen ? "true" : "false"}
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
            aria-expanded={agentDrawerOpen}
            onClick={() => {
              setInspectorDrawerOpen(false)
              setAgentDrawerOpen(true)
            }}
          >
            <Menu />
          </Button>
          {selectedAgent ? (
            <>
              <Button
                className={styles.mobileIdentity}
                ref={inspectorDrawerTriggerRef}
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`${dictionary.actions.openAgentDetails}: ${selectedAgent.name}`}
                aria-describedby={identityStatusId}
                aria-expanded={inspectorDrawerOpen}
                onClick={() => {
                  setAgentDrawerOpen(false)
                  setInspectorDrawerOpen(true)
                }}
              >
                <AgentGlyph agent={selectedAgent} />
                <bdi className={styles.mobileAgentName}>
                  {selectedAgent.name}
                </bdi>
                <span
                  className={styles.statusDot}
                  data-status={selectedAgent.status ?? "idle"}
                  aria-hidden="true"
                />
              </Button>
              <span className={styles.srOnly} id={identityStatusId}>
                {dictionary.status.label}:{" "}
                {agentStatusLabel(selectedAgent.status, dictionary)}
              </span>
            </>
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
          <AgentsPanel {...agentsPanelProps} activityButton={activityButton} />
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
              selectedAgentId={
                selectedAgent?.kind === "provisional" ? null : selectedAgentId
              }
              onOpenSession={onOpenSession}
              onCloseSession={onCloseSession}
              onCreateSession={onCreateSession}
              onActionError={onActionError}
              inspectorOpen={desktopInspectorOpen}
              onToggleInspector={toggleDesktopInspector}
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
          aria-label={dictionary.workspace.agentDetails}
          aria-hidden={modalDrawerOpen || undefined}
          inert={modalDrawerOpen ? true : undefined}
          hidden={!desktopInspectorOpen}
        >
          <InspectorPanel {...inspectorPanelProps} />
        </aside>

        <WorkspaceKeyboard
          locale={locale}
          rootRef={shellRef}
          agents={agents}
          openSessions={openSessions}
          olderSessions={olderSessions}
          selectedAgentId={selectedAgentId}
          activeThreadId={activeThreadId}
          agentBuilderAvailable={agentBuilderAvailable}
          canCreateSession={Boolean(
            selectedAgentId && selectedAgent?.kind !== "provisional"
          )}
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
          open={agentDrawerOpen}
          side="start"
          title={dictionary.workspace.agents}
          closeLabel={dictionary.actions.closePanel}
          onClose={() => setAgentDrawerOpen(false)}
          returnFocusRef={agentDrawerTriggerRef}
        >
          <AgentsPanel
            {...agentsPanelProps}
            onAfterSelectAgent={() => setAgentDrawerOpen(false)}
          />
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

        <FocusDrawer
          open={inspectorDrawerOpen}
          side="end"
          title={dictionary.workspace.agentDetails}
          closeLabel={dictionary.actions.closePanel}
          onClose={() => setInspectorDrawerOpen(false)}
          returnFocusRef={inspectorDrawerTriggerRef}
        >
          <InspectorPanel {...inspectorPanelProps} />
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
