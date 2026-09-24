"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Switch } from "@base-ui/react/switch"
import { Plus, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { getLocaleDirection, type Locale } from "@/lib/i18n/config"
import type { Dictionary } from "@/lib/i18n/dictionary"
import {
  AgentVisibilityUpdateError,
  type AgentCatalogEntry,
  type AgentVisibility,
  type WorkspaceAdapter,
} from "@/runtime-adapters/contracts"
import { AgentGlyph } from "./workspace-shell"

export function ManageAgents({
  open,
  onOpenChange,
  workspace,
  locale,
  dictionary,
  onVisibilityChanged,
  onNewAgent,
  onActionError,
  creatorAvailable = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace: WorkspaceAdapter
  locale: Locale
  dictionary: Dictionary
  onVisibilityChanged: () => Promise<void>
  onNewAgent: () => Promise<void>
  onActionError: (error: unknown) => void
  creatorAvailable?: boolean
}) {
  const [entries, setEntries] = useState<AgentCatalogEntry[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [updateFailure, setUpdateFailure] = useState<
    AgentVisibilityUpdateError["code"] | "failed" | null
  >(null)
  const [pending, setPending] = useState<string | null>(null)
  const lifetime = useRef<{ active: boolean; mutating: boolean } | null>(null)
  const generation = useRef(0)
  const copy = dictionary.agentManagement
  const updateMessage = updateFailure
    ? {
        failed: copy.updateFailed,
        "provider-active": copy.providerActive,
        "pending-reload": copy.pendingReload,
      }[updateFailure]
    : null

  useEffect(() => {
    const scope = { active: true, mutating: false }
    lifetime.current = scope
    return () => {
      scope.active = false
      generation.current += 1
    }
  }, [workspace])

  const load = useCallback(async () => {
    const scope = lifetime.current
    if (!scope?.active) return
    const request = ++generation.current
    try {
      const catalog = workspace.listAgentCatalog
        ? await workspace.listAgentCatalog()
        : (await workspace.listAgents()).flatMap((summary) =>
            summary.kind === "ready"
              ? [
                  {
                    summary,
                    visibility: summary.visibility ?? "visible",
                    selectable: summary.visibility !== "hidden",
                    editable: false,
                    avatarEditable: false,
                  },
                ]
              : []
          )
      if (scope.active && request === generation.current) {
        setEntries(catalog.filter(({ summary }) => summary.role !== "creator"))
        setLoadFailed(false)
        if (!scope.mutating) setPending(null)
      }
    } catch {
      if (scope.active && request === generation.current) setLoadFailed(true)
    }
  }, [workspace])

  useEffect(() => {
    if (!open) return
    let active = true
    // A mutation owns its final read, so notification reads cannot race it.
    const refresh = () => {
      if (active && !lifetime.current?.mutating) void load()
    }
    refresh()
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = workspace.subscribeAgentCatalog?.(refresh, () => {
        if (active) setLoadFailed(true)
      })
    } catch {
      void Promise.resolve().then(() => {
        if (active) setLoadFailed(true)
      })
    }
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [load, open, workspace])

  async function update(agentId: string, visibility: AgentVisibility) {
    const scope = lifetime.current
    if (
      !workspace.updateAgentVisibility ||
      !scope?.active ||
      scope.mutating ||
      loadFailed
    )
      return
    scope.mutating = true
    generation.current += 1
    setPending(agentId)
    setUpdateFailure(null)
    try {
      await workspace.updateAgentVisibility(agentId, visibility)
      if (!scope.active) return
      await onVisibilityChanged()
    } catch (error) {
      if (scope.active)
        setUpdateFailure(
          error instanceof AgentVisibilityUpdateError ? error.code : "failed"
        )
    } finally {
      // Reconcile even rejected mutations: providers may publish on failure.
      // Keep stale values locked if this read fails, until a successful retry.
      if (scope.active) await load()
      scope.mutating = false
      if (scope.active) setPending(null)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setEntries(null)
          setLoadFailed(false)
          setUpdateFailure(null)
        }
        onOpenChange(next)
      }}
    >
      <DialogContent
        dir={getLocaleDirection(locale)}
        showCloseButton={false}
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl motion-reduce:data-open:animate-none motion-reduce:data-closed:animate-none"
        overlayClassName="motion-reduce:data-open:animate-none motion-reduce:data-closed:animate-none"
        finalFocus={() =>
          [
            ...document.querySelectorAll<HTMLElement>("[data-manage-agents]"),
          ].find((element) => element.checkVisibility?.() ?? true) ??
          document.querySelector<HTMLElement>(
            `button[aria-label="${dictionary.actions.openAgents}"]`
          )
        }
      >
        <DialogHeader className="gap-2 px-6 pe-16 pt-6 pb-5">
          <DialogTitle>{dictionary.workspace.manageAgents}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <DialogClose
          render={
            <Button
              className="absolute end-3 top-3 size-11"
              variant="ghost"
              size="icon"
              aria-label={dictionary.actions.closePanel}
            />
          }
        >
          <X />
        </DialogClose>
        <div
          className="min-h-0 overflow-y-auto px-6"
          aria-busy={entries === null && !loadFailed}
        >
          {loadFailed || updateFailure ? (
            <div
              role="alert"
              className="mb-4 flex flex-wrap items-center justify-between gap-3 text-sm text-destructive"
            >
              <div>
                {updateMessage ? <p>{updateMessage}</p> : null}
                {loadFailed ? <p>{copy.loadFailed}</p> : null}
              </div>
              {loadFailed ? (
                <Button
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => void load()}
                >
                  {copy.retry}
                </Button>
              ) : null}
            </div>
          ) : null}
          {entries === null && !loadFailed ? (
            <div role="status" className="space-y-4 pb-5">
              <span className="sr-only">{copy.loading}</span>
              {[0, 1, 2].map((key) => (
                <Skeleton
                  key={key}
                  className="h-16 w-full motion-reduce:animate-none"
                />
              ))}
            </div>
          ) : null}
          {entries?.length === 0 ? (
            <p className="pb-6 text-sm text-muted-foreground">
              {dictionary.empty.addAgentTitle}
            </p>
          ) : null}
          <ul className="divide-y divide-border">
            {entries?.map((entry) => (
              <li
                key={entry.summary.id}
                className="flex items-start gap-3 py-4 first:pt-0"
              >
                <AgentGlyph
                  agent={entry.summary}
                  className="!size-10 !rounded-xl [&_svg]:!size-5"
                />
                <div className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <bdi className="block text-sm font-medium wrap-anywhere">
                      {entry.summary.name}
                    </bdi>
                    {entry.summary.description ? (
                      <bdi className="mt-1 block text-sm leading-5 wrap-anywhere text-muted-foreground">
                        {entry.summary.description}
                      </bdi>
                    ) : null}
                  </div>
                  {entry.editable && workspace.updateAgentVisibility ? (
                    <div className="mt-2 flex min-h-11 items-center justify-between gap-4 text-sm sm:mt-0 sm:max-w-44 sm:gap-2">
                      <span>{copy.showInWorkspace}</span>
                      <Switch.Root
                        checked={entry.visibility === "visible"}
                        disabled={pending !== null || loadFailed}
                        aria-label={`${copy.showInWorkspace}: ${entry.summary.name}`}
                        onCheckedChange={(checked) =>
                          void update(
                            entry.summary.id,
                            checked ? "visible" : "hidden"
                          )
                        }
                        className="group inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:cursor-wait data-disabled:opacity-60"
                      >
                        <span className="relative h-6 w-10 rounded-full bg-muted ring-1 ring-border transition-colors group-data-checked:bg-primary motion-reduce:transition-none">
                          <Switch.Thumb className="absolute start-0.5 top-0.5 size-5 rounded-full bg-background shadow-sm transition-transform motion-reduce:transition-none data-checked:translate-x-4 rtl:data-checked:-translate-x-4" />
                        </span>
                      </Switch.Root>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground sm:mt-0">
                      <span className="block">
                        {entry.visibility === "visible"
                          ? copy.shownInWorkspace
                          : copy.hiddenFromWorkspace}
                      </span>
                      <span className="mt-1 block">
                        {copy.managedByProvider}
                      </span>
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
        {creatorAvailable ? (
          <div className="flex flex-col items-end gap-2 border-t px-6 py-4">
            <Button
              className="min-h-11"
              disabled={pending !== null}
              onClick={() => {
                onOpenChange(false)
                void onNewAgent().catch(onActionError)
              }}
            >
              <Plus data-icon="inline-start" />
              {dictionary.actions.newAgent}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
