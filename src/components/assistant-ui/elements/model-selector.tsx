"use client"

import { Select } from "@base-ui/react/select"
import {
  DirectionProvider,
  useDirection,
  type TextDirection,
} from "@base-ui/react/direction-provider"
import { CheckIcon, ChevronDownIcon } from "lucide-react"
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react"

import { cn } from "@/lib/utils"

/**
 * Presentational-only subset of the Assistant UI registry ModelSelector API.
 * Runtime selection remains owned by the caller's opaque view model.
 */
export type ModelOption = {
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
  readonly group?: string | undefined
  readonly efforts?:
    true | readonly { readonly id: string; readonly name: string }[] | undefined
}

export type ModelSelectorSelectionState =
  | { readonly status: "idle" }
  | { readonly status: "pending"; readonly targetId: string }
  | {
      readonly status: "error"
      readonly targetId: string
      readonly error: string
      readonly retry?: (() => void | Promise<void>) | undefined
    }

type ModelSelectorContextValue = {
  readonly models: readonly ModelOption[]
  readonly value: string
  readonly selection: ModelSelectorSelectionState
  readonly effort: string | undefined
  readonly setEffort: ((effort: string) => void) | undefined
}

/**
 * The one change reason that means the operator activated an item, by pointer
 * or by keyboard. Typed against the Select's own reason union so a future
 * upstream rename fails the build instead of silently switching models on the
 * library's own bookkeeping.
 */
const OPERATOR_PICKED: Select.Root.ChangeEventReason = "item-press"

const ModelSelectorContext = createContext<ModelSelectorContextValue | null>(
  null
)

function useModelSelectorContext() {
  const context = useContext(ModelSelectorContext)
  if (!context) {
    throw new Error(
      "ModelSelector sub-components must be used within ModelSelectorRoot"
    )
  }
  return context
}

export function ModelSelectorRoot({
  models,
  value,
  onValueChange,
  selection = { status: "idle" },
  effort,
  onEffortChange,
  direction = "ltr",
  children,
}: {
  models: readonly ModelOption[]
  value: string
  onValueChange: (value: string) => void
  selection?: ModelSelectorSelectionState | undefined
  effort?: string | undefined
  onEffortChange?: ((effort: string) => void) | undefined
  direction?: TextDirection | undefined
  children: ReactNode
}) {
  return (
    <DirectionProvider direction={direction}>
      <ModelSelectorContext.Provider
        value={{
          models,
          value,
          selection,
          effort,
          setEffort: onEffortChange,
        }}
      >
        <Select.Root
          value={value}
          // Only a deliberate pick may switch the Session's model. The Select
          // also emits for its own bookkeeping with reason "none": when a
          // filtered item set no longer holds the controlled value it restores
          // the value captured at first render, and closed-trigger typeahead
          // label-matches a keystroke against the whole option list. Either one
          // commits a model the operator never chose, and because the trigger
          // renders the controlled value the picker follows it. "itemPress"
          // covers pointer and keyboard activation alike.
          onValueChange={(nextValue, details) => {
            if (nextValue !== null && details.reason === OPERATOR_PICKED)
              onValueChange(nextValue)
          }}
        >
          {children}
        </Select.Root>
      </ModelSelectorContext.Provider>
    </DirectionProvider>
  )
}

export type ModelSelectorTriggerProps = ComponentPropsWithoutRef<
  typeof Select.Trigger
>

export function ModelSelectorTrigger({
  className,
  children,
  ...props
}: ModelSelectorTriggerProps) {
  return (
    <Select.Trigger
      data-slot="model-selector-trigger"
      className={cn(
        "flex h-11 max-w-56 min-w-0 items-center justify-between gap-1.5 rounded-md px-1.5 text-xs font-medium text-foreground transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 motion-reduce:transition-none @min-[64rem]/workspace:h-7",
        className
      )}
      {...props}
    >
      {children ?? <ModelSelectorValue />}
      <Select.Icon>
        <ChevronDownIcon className="size-3.5 opacity-60" />
      </Select.Icon>
    </Select.Trigger>
  )
}

export function ModelSelectorValue() {
  const { effort, models, value } = useModelSelectorContext()
  const model = models.find((candidate) => candidate.id === value)
  const efforts = model?.efforts === true ? DEFAULT_EFFORTS : model?.efforts
  const effortLabel = efforts?.find(
    (candidate) => candidate.id === effort
  )?.name
  return (
    <Select.Value className="truncate">
      {model?.name}
      {effortLabel ? ` · ${effortLabel}` : ""}
    </Select.Value>
  )
}

export function ModelSelectorContent({
  className,
  searchable = false,
}: {
  className?: string | undefined
  searchable?: boolean | undefined
}) {
  const { models, selection } = useModelSelectorContext()
  const direction = useDirection()
  const [query, setQuery] = useState("")
  const filteredModels = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return models
    return models.filter((model) =>
      [model.id, model.name, model.description, model.group].some((value) =>
        value?.toLocaleLowerCase().includes(normalized)
      )
    )
  }, [models, query])
  const ungrouped = filteredModels.filter((model) => !model.group)
  const groups = new Map<string, ModelOption[]>()
  for (const model of filteredModels) {
    if (!model.group) continue
    groups.set(model.group, [...(groups.get(model.group) ?? []), model])
  }

  return (
    <Select.Portal>
      <Select.Positioner
        side="top"
        align="start"
        sideOffset={6}
        className="isolate z-50"
      >
        <Select.Popup
          data-slot="model-selector-content"
          dir={direction}
          className={cn(
            "min-w-(--anchor-width) rounded-xl bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none motion-reduce:animate-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
            className
          )}
        >
          <Select.List className="max-h-72 overflow-y-auto py-1 outline-none">
            {searchable ? (
              <input
                aria-label="Search models"
                className="mx-1 mb-1 w-[calc(100%-0.5rem)] rounded-md border bg-transparent px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (!event.key.startsWith("Arrow") && event.key !== "Enter")
                    event.stopPropagation()
                }}
                placeholder="Search models..."
                role="searchbox"
                value={query}
              />
            ) : null}
            {selection.status === "error" ? (
              <div
                className="flex items-center gap-2 px-2 py-1 text-xs text-destructive"
                role="alert"
              >
                <span>{selection.error}</span>
                {selection.retry ? (
                  <button
                    aria-label="Retry model selection"
                    className="underline"
                    onClick={() => void selection.retry?.()}
                    type="button"
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            ) : null}
            {selection.status === "pending" ? (
              <div
                aria-live="polite"
                className="px-2 py-1 text-xs text-muted-foreground"
              >
                Switching model…
              </div>
            ) : null}
            {ungrouped.map((model) => (
              <ModelSelectorItem key={model.id} model={model} />
            ))}
            {[...groups].map(([group, options]) => (
              <ModelSelectorGroup key={group} label={group}>
                {options.map((model) => (
                  <ModelSelectorItem key={model.id} model={model} />
                ))}
              </ModelSelectorGroup>
            ))}
            {filteredModels.length === 0 ? (
              <p className="px-2 py-1 text-sm text-muted-foreground">
                No models found.
              </p>
            ) : null}
            <ModelSelectorEffort />
          </Select.List>
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
  )
}

const DEFAULT_EFFORTS = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
] as const

export function ModelSelectorEffort() {
  const { effort, models, setEffort, value } = useModelSelectorContext()
  const model = models.find((candidate) => candidate.id === value)
  const efforts = model?.efforts === true ? DEFAULT_EFFORTS : model?.efforts
  if (!efforts?.length || !setEffort) return null

  return (
    <div
      aria-label="Reasoning effort"
      className="mt-1 flex items-center justify-between gap-2 border-t px-2 py-2"
      role="radiogroup"
    >
      <span className="text-xs text-muted-foreground">Thinking</span>
      <span className="flex gap-1">
        {efforts.map((option) => (
          <button
            aria-checked={option.id === effort}
            className="rounded px-1.5 py-1 text-xs hover:bg-muted aria-checked:bg-muted"
            key={option.id}
            onClick={() => setEffort(option.id)}
            role="radio"
            type="button"
          >
            {option.name}
          </button>
        ))}
      </span>
    </div>
  )
}

export function ModelSelectorGroup({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <Select.Group>
      <Select.GroupLabel className="px-2 py-1 text-xs font-medium text-muted-foreground">
        {label}
      </Select.GroupLabel>
      {children}
    </Select.Group>
  )
}

export function ModelSelectorItem({ model }: { model: ModelOption }) {
  return (
    <Select.Item
      value={model.id}
      label={model.name}
      className="relative flex cursor-default items-start rounded-lg py-1.5 ps-2 pe-8 text-sm outline-none data-highlighted:bg-muted data-selected:font-medium"
    >
      <span className="flex min-w-0 flex-col">
        <Select.ItemText>{model.name}</Select.ItemText>
        {model.description ? (
          <span className="truncate text-xs text-muted-foreground">
            {model.description}
          </span>
        ) : null}
      </span>
      <Select.ItemIndicator className="absolute end-2 flex size-4 items-center justify-center">
        <CheckIcon className="size-3.5" />
      </Select.ItemIndicator>
    </Select.Item>
  )
}
