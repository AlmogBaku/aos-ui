"use client"

import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import {
  DirectionProvider,
  useDirection,
  type TextDirection,
} from "@base-ui/react/direction-provider"
import { RotateCcwIcon } from "lucide-react"
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react"

import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox"
import { cn } from "@/lib/utils"

/**
 * Presentational-only model picker. Runtime selection stays owned by the
 * caller's opaque view model; this component never mutates provider state.
 */
export type ModelOption = {
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
  readonly group?: string | undefined
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

export type ModelSelectorLabels = {
  /** Trigger text when the authoritative selection matches no offered option. */
  readonly placeholder: string
  readonly search: string
  readonly searchPlaceholder: string
  readonly empty: string
  readonly switching: string
  readonly retry: string
}

/** Base UI reads `items` from group objects; the label lives on `value`. */
type ModelOptionGroup = {
  readonly value: string
  readonly items: readonly ModelOption[]
}

/** Search matches the provider id and group too, not just the display name. */
function modelSearchText(model: ModelOption) {
  return [model.id, model.name, model.group, model.description]
    .filter((part): part is string => Boolean(part))
    .join(" ")
}

/** Ungrouped models lead, then each group in provider-reported order. */
function toModelGroups(
  models: readonly ModelOption[]
): readonly ModelOptionGroup[] {
  const ungrouped: ModelOption[] = []
  const grouped = new Map<string, ModelOption[]>()
  for (const model of models) {
    if (!model.group) {
      ungrouped.push(model)
      continue
    }
    const existing = grouped.get(model.group)
    if (existing) existing.push(model)
    else grouped.set(model.group, [model])
  }

  const groups: ModelOptionGroup[] = []
  if (ungrouped.length > 0) groups.push({ value: "", items: ungrouped })
  for (const [value, items] of grouped) groups.push({ value, items })
  return groups
}

type ModelSelectorContextValue = {
  readonly models: readonly ModelOption[]
  readonly selection: ModelSelectorSelectionState
  readonly labels: ModelSelectorLabels
}

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
  direction = "ltr",
  labels,
  children,
}: {
  models: readonly ModelOption[]
  value: string
  onValueChange: (value: string) => void
  selection?: ModelSelectorSelectionState | undefined
  direction?: TextDirection | undefined
  labels: ModelSelectorLabels
  children: ReactNode
}) {
  const groups = useMemo(() => toModelGroups(models), [models])
  const selected = useMemo(
    () => models.find((model) => model.id === value) ?? null,
    [models, value]
  )
  const filter = ComboboxPrimitive.useFilter({
    locale: direction === "rtl" ? "he" : "en",
  })
  const matchesQuery = useCallback(
    (model: ModelOption, query: string) =>
      filter.contains(model, query, modelSearchText),
    [filter]
  )
  const context = useMemo(
    () => ({ models, selection, labels }),
    [models, selection, labels]
  )

  return (
    <DirectionProvider direction={direction}>
      <ModelSelectorContext.Provider value={context}>
        <Combobox
          autoHighlight
          filter={matchesQuery}
          isItemEqualToValue={(candidate, current) =>
            candidate.id === current.id
          }
          items={groups}
          itemToStringLabel={(model) => model.name}
          modal={false}
          onValueChange={(next) => {
            if (next) onValueChange(next.id)
          }}
          value={selected}
        >
          {children}
        </Combobox>
      </ModelSelectorContext.Provider>
    </DirectionProvider>
  )
}

export type ModelSelectorTriggerProps = ComponentPropsWithoutRef<
  typeof ComboboxTrigger
>

export function ModelSelectorTrigger({
  className,
  children,
  ...props
}: ModelSelectorTriggerProps) {
  const { labels } = useModelSelectorContext()
  return (
    <ComboboxTrigger
      data-slot="model-selector-trigger"
      className={cn(
        "flex h-11 max-w-56 min-w-0 items-center justify-between gap-1.5 rounded-md px-1.5 text-xs font-medium text-foreground transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 motion-reduce:transition-none @min-[64rem]/workspace:h-7",
        // The wrapper supplies the chevron; keep the design-lock icon weight.
        "[&>svg]:size-3.5 [&>svg]:text-current [&>svg]:opacity-60",
        className
      )}
      {...props}
    >
      {children ?? (
        <ComboboxValue>
          {(model: ModelOption | null) => (
            <span className="truncate">{model?.name ?? labels.placeholder}</span>
          )}
        </ComboboxValue>
      )}
    </ComboboxTrigger>
  )
}

/** Shared pending/error presentation for model and effort popups. */
export function ModelSelectorStatus({
  labels,
  selection,
}: {
  labels: Pick<ModelSelectorLabels, "switching" | "retry">
  selection: ModelSelectorSelectionState
}) {
  if (selection.status === "pending") {
    return (
      <div
        aria-live="polite"
        className="px-2 py-1 text-xs text-muted-foreground"
      >
        {labels.switching}
      </div>
    )
  }
  if (selection.status !== "error") return null
  const retry = selection.retry
  return (
    <div
      className="flex items-center gap-2 px-2 py-1 text-xs text-destructive"
      role="alert"
    >
      <span className="min-w-0 flex-1">{selection.error}</span>
      {retry ? (
        <button
          aria-label={labels.retry}
          className="rounded-sm p-0.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40"
          onClick={() => void retry()}
          type="button"
        >
          <RotateCcwIcon aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

export function ModelSelectorContent({
  className,
  searchable,
}: {
  className?: string | undefined
  /** Defaults to searching only once the roster stops fitting on screen. */
  searchable?: boolean | undefined
}) {
  const { labels, models, selection } = useModelSelectorContext()
  const direction = useDirection()
  const showSearch = searchable ?? models.length > 8

  return (
    <ComboboxContent
      align="start"
      className={cn("min-w-64 motion-reduce:animate-none", className)}
      data-slot="model-selector-content"
      dir={direction}
      side="top"
      sideOffset={6}
    >
      {showSearch ? (
        <ComboboxInput
          aria-label={labels.search}
          placeholder={labels.searchPlaceholder}
          showTrigger={false}
        />
      ) : null}
      <ModelSelectorStatus labels={labels} selection={selection} />
      <ComboboxList>
        <ComboboxCollection>
          {(group: ModelOptionGroup) => (
            <ComboboxGroup items={group.items} key={group.value}>
              {group.value ? (
                <ComboboxLabel>{group.value}</ComboboxLabel>
              ) : null}
              <ComboboxCollection>
                {(model: ModelOption) => (
                  <ComboboxItem key={model.id} value={model}>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{model.name}</span>
                      {model.description ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {model.description}
                        </span>
                      ) : null}
                    </span>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxCollection>
        <ComboboxEmpty>{labels.empty}</ComboboxEmpty>
      </ComboboxList>
    </ComboboxContent>
  )
}
