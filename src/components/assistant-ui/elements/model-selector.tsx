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
  useState,
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
import { Slider } from "@/components/ui/slider"
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
  /** Names the reasoning-effort control the popup carries under the roster. */
  readonly effort: string
  /** Provider-reported effort ids mapped to localized names. */
  readonly effortLevels: Record<string, string>
  /** Reads for a Session still running on the provider's own default level. */
  readonly effortUnset: string
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
  /** Reasoning efforts of the selected model; absent when it reports none. */
  readonly efforts?: readonly string[] | undefined
  readonly effortValue?: string | undefined
  readonly onEffortChange?: ((effortId: string) => void) | undefined
  readonly effortSelection: ModelSelectorSelectionState
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
  efforts,
  effortValue,
  onEffortChange,
  effortSelection = { status: "idle" },
  direction = "ltr",
  labels,
  children,
}: {
  models: readonly ModelOption[]
  value: string
  onValueChange: (value: string) => void
  selection?: ModelSelectorSelectionState | undefined
  /** Efforts of the selected model; the popup omits the group without them. */
  efforts?: readonly string[] | undefined
  effortValue?: string | undefined
  onEffortChange?: ((effortId: string) => void) | undefined
  effortSelection?: ModelSelectorSelectionState | undefined
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
    () => ({
      models,
      selection,
      labels,
      efforts,
      effortValue,
      onEffortChange,
      effortSelection,
    }),
    [
      models,
      selection,
      labels,
      efforts,
      effortValue,
      onEffortChange,
      effortSelection,
    ]
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
  const context = useModelSelectorContext()
  const { labels } = context
  const level = currentEffort(context)
  return (
    <ComboboxTrigger
      data-slot="model-selector-trigger"
      className={cn(
        // Model names carry provider-qualified prefixes, so the trigger keeps
        // its full width and truncates only when the rail actually runs out.
        "flex h-11 min-w-0 items-center justify-between gap-1.5 rounded-md px-1.5 text-xs font-medium text-foreground transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 motion-reduce:transition-none @min-[64rem]/workspace:h-7",
        // The wrapper supplies the chevron; keep the design-lock icon weight.
        "[&>svg]:size-3.5 [&>svg]:text-current [&>svg]:opacity-60",
        className
      )}
      {...props}
    >
      {children ?? (
        <span className="flex min-w-0 items-center gap-1">
          <ComboboxValue>
            {(model: ModelOption | null) => (
              <span className="truncate">
                {model?.name ?? labels.placeholder}
              </span>
            )}
          </ComboboxValue>
          {/* The level is only reachable inside the popup, so the collapsed
              trigger carries it rather than hiding the Session's state. */}
          {level ? (
            <span className="shrink-0 font-normal text-muted-foreground">
              · {labels.effortLevels[level] ?? level}
            </span>
          ) : null}
        </span>
      )}
    </ComboboxTrigger>
  )
}

/** The level a Session is on, preferring a pick the provider is still settling. */
function currentEffort({
  effortSelection,
  efforts,
  effortValue,
  onEffortChange,
}: ModelSelectorContextValue) {
  if (!onEffortChange || !efforts?.length) return undefined
  const level =
    effortSelection.status === "pending" ? effortSelection.targetId : effortValue
  return level && efforts.includes(level) ? level : undefined
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
      className={cn(
        // Wide enough for a provider-qualified name and its description, and
        // rounded like the rest of the composer's popovers.
        "w-80 rounded-xl motion-reduce:animate-none",
        className
      )}
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
                <ComboboxLabel className="font-medium">
                  {group.value}
                </ComboboxLabel>
              ) : null}
              <ComboboxCollection>
                {(model: ModelOption) => (
                  <ComboboxItem
                    className="rounded-lg py-1.5 ps-1.5 data-selected:font-medium"
                    key={model.id}
                    value={model}
                  >
                    {/* A monogram of the provider-reported text, which gives
                        rows the rhythm of a provider logo without teaching a
                        provider-neutral component about specific providers. */}
                    <span
                      aria-hidden
                      className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-medium text-muted-foreground uppercase"
                    >
                      {(model.group ?? model.name).trim().slice(0, 1)}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{model.name}</span>
                      {model.description ? (
                        <span className="truncate text-xs font-normal text-muted-foreground">
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
      <ModelSelectorEfforts />
    </ComboboxContent>
  )
}

/** The wrapper is not generic over its value, so a scalar arrives as a union. */
function thumbIndex(value: number | readonly number[]) {
  return Array.isArray(value) ? (value[0] ?? 0) : (value as number)
}

/**
 * Reasoning effort of the selected model, inside the model popup: one control
 * owns both halves of a model choice. The ladder is ordered, so it reads as a
 * slider, and it sits outside the roster's listbox to keep that list valid.
 */
function ModelSelectorEfforts() {
  const context = useModelSelectorContext()
  const { effortSelection, efforts, effortValue, labels, onEffortChange } =
    context
  // Held while a drag is in flight so the thumb follows the pointer without a
  // provider write per step; a commit hands the level over and clears it.
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  if (!onEffortChange || !efforts?.length) return null

  const settled = currentEffort(context)
  const settledIndex = settled ? efforts.indexOf(settled) : -1
  const index = dragIndex ?? Math.max(settledIndex, 0)
  // A Session can still be on the provider's own default, which is no level on
  // the ladder; the thumb has to rest somewhere, so say so rather than imply
  // the level it rests on.
  const unset = dragIndex === null && settledIndex < 0
  const levelName = (level: string) => labels.effortLevels[level] ?? level
  const valueText = unset ? labels.effortUnset : levelName(efforts[index] ?? "")

  return (
    <div
      className="border-t border-border/60 p-3"
      data-slot="model-selector-efforts"
    >
      <p className="flex items-baseline justify-between gap-2 pb-3 text-xs">
        <span className="text-muted-foreground">{labels.effort}</span>
        <span className={cn("font-medium", unset && "text-muted-foreground")}>
          {valueText}
        </span>
      </p>
      <ModelSelectorStatus labels={labels} selection={effortSelection} />
      <Slider
        aria-label={labels.effort}
        // The thumb overhangs the track it is centered on, so the row keeps
        // room for it instead of crowding the popup's edge.
        className="py-1.5"
        getAriaValueText={() => valueText}
        max={efforts.length - 1}
        min={0}
        onValueChange={(next) => setDragIndex(thumbIndex(next))}
        onValueCommitted={(next) => {
          const level = efforts[thumbIndex(next)]
          setDragIndex(null)
          if (level && level !== effortValue) onEffortChange(level)
        }}
        step={1}
        value={index}
      />
    </div>
  )
}
