"use client"

import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import {
  DirectionProvider,
  useDirection,
  type TextDirection,
} from "@base-ui/react/direction-provider"
import { CircleAlertIcon, Loader2Icon, RotateCcwIcon } from "lucide-react"
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

/**
 * The displayed value and level are already the picked ones, so a pending
 * switch carries no target of its own.
 */
export type ModelSelectorSelectionState =
  | { readonly status: "idle" }
  | { readonly status: "pending" }
  | {
      readonly status: "error"
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
}

/**
 * The one change reason that means the operator activated an item. Typed against
 * the Combobox's own reason union so an upstream rename fails the build instead
 * of silently switching models on the library's own bookkeeping.
 */
const OPERATOR_PICKED: ComboboxPrimitive.Root.ChangeEventReason = "item-press"

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
  direction = "ltr",
  labels,
  children,
}: {
  models: readonly ModelOption[]
  value: string
  onValueChange: (value: string) => void
  /** One in-flight state for the whole choice: the model, its level, or both. */
  selection?: ModelSelectorSelectionState | undefined
  /** Efforts of the selected model; the popup omits the group without them. */
  efforts?: readonly string[] | undefined
  effortValue?: string | undefined
  onEffortChange?: ((effortId: string) => void) | undefined
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
    }),
    [models, selection, labels, efforts, effortValue, onEffortChange]
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
          // Only a deliberate pick may switch the Session's model. The
          // Combobox also reports its own bookkeeping: typeahead against the
          // closed trigger label-matches every keystroke against the whole
          // roster, and a filtered item set that no longer holds the controlled
          // value restores another one. Either commits a model the operator
          // never chose, and because the trigger renders the controlled value
          // the picker follows it. Activation covers pointer and keyboard alike.
          onValueChange={(next, details) => {
            if (next && details.reason === OPERATOR_PICKED)
              onValueChange(next.id)
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
  const pending = context.selection.status === "pending"
  return (
    <ComboboxTrigger
      aria-busy={pending || undefined}
      data-slot="model-selector-trigger"
      className={cn(
        // Model names carry provider-qualified prefixes, so the trigger keeps
        // its full width and truncates only when the rail actually runs out.
        "flex h-11 min-w-0 items-center justify-between gap-1.5 rounded-md px-1.5 text-xs font-medium text-foreground transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 motion-reduce:transition-none @min-[64rem]/workspace:h-7",
        // The wrapper supplies the chevron; keep the design-lock icon weight.
        // Only the resting chevron is dimmed: the spinner below is the whole
        // signal that a switch is in flight, and under `motion-reduce` it is a
        // still ring, so it has to read at full strength.
        "[&>svg]:size-3.5 [&>svg]:text-current [&>svg:last-child]:opacity-60",
        // A pending switch trades the wrapper's own trailing chevron for the
        // spinner below rather than crowding the rail with both affordances.
        // This assumes `ComboboxTrigger` keeps rendering that chevron as its
        // last direct svg child (see `src/components/ui/combobox.tsx`), which
        // it offers no prop or render seam to omit.
        pending && "[&>svg:last-child]:hidden",
        className
      )}
      {...props}
    >
      {children ?? (
        <span className="flex min-w-0 items-center gap-1">
          <ComboboxValue>
            {(model: ModelOption | null) => (
              // A pick shows here at once, at reduced emphasis until the
              // provider confirms it, so the trigger never overstates it.
              <span
                className={cn("truncate", pending && "text-muted-foreground")}
              >
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
      {pending ? (
        <Loader2Icon
          aria-hidden
          className="shrink-0 animate-spin motion-reduce:animate-none"
        />
      ) : null}
    </ComboboxTrigger>
  )
}

/** The level a Session is on, when the provider still offers it. */
function currentEffort({
  efforts,
  effortValue,
  onEffortChange,
}: ModelSelectorContextValue) {
  if (!onEffortChange || !efforts?.length) return undefined
  return effortValue && efforts.includes(effortValue) ? effortValue : undefined
}

/** The one pending/error line for a model choice, shown once in the popup. */
export function ModelSelectorStatus({
  labels,
  selection,
}: {
  labels: Pick<ModelSelectorLabels, "switching" | "retry">
  selection: ModelSelectorSelectionState
}) {
  const failure = selection.status === "error" ? selection : null
  const retry = failure?.retry
  return (
    <>
      {/* The region stays mounted while the popup is open so a switch that
          starts here is announced, rather than arriving together with its own
          container. */}
      <div
        aria-live="polite"
        className={cn(
          "px-3 text-xs text-muted-foreground",
          selection.status === "pending" && "py-1.5"
        )}
      >
        {selection.status === "pending" ? labels.switching : null}
      </div>
      {failure ? (
        <div
          className="flex items-start gap-2 px-3 py-1.5 text-xs"
          role="alert"
        >
          {/* The destructive role clears 4.5:1 on neither popover surface at
              this size, so the icon carries the semantic color and the
              sentence itself stays on the readable foreground pair. */}
          <CircleAlertIcon
            aria-hidden
            className="mt-px size-3.5 shrink-0 text-destructive"
          />
          <span className="min-w-0 flex-1 text-foreground">
            {failure.error}
          </span>
          {retry ? (
            <button
              aria-label={labels.retry}
              // -my-0.5 keeps the larger pointer target from stretching the
              // line it sits on.
              className="-my-0.5 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
              onClick={() => void retry()}
              type="button"
            >
              <RotateCcwIcon aria-hidden className="size-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}
    </>
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
      {/* A provider roster outgrows the popup, and the registry list hides the
          scrollbar, so without this the roster ends in a row sliced flat
          against the effort divider. `scroll-fade-y` is the registry's own
          scroll-driven answer: it fades only the edge that still has rows
          behind it, and maps position rather than time. */}
      <ComboboxList className="scroll-fade-y">
        <ComboboxCollection>
          {(group: ModelOptionGroup) => (
            <ComboboxGroup
              // A heading takes more room above than below, so each provider
              // reads as introducing the rows under it; the first one sits
              // against the popup's own edge and needs no such gap.
              className="pt-2 first:pt-0"
              items={group.items}
              key={group.value}
            >
              {group.value ? (
                <ComboboxLabel className="pb-1">{group.value}</ComboboxLabel>
              ) : null}
              <ComboboxCollection>
                {(model: ModelOption) => (
                  <ComboboxItem
                    className="rounded-lg py-1.5 data-selected:font-medium [@media(pointer:coarse)]:min-h-11"
                    key={model.id}
                    value={model}
                  >
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
  const { efforts, effortValue, labels, onEffortChange } = context
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
      {/* One status line for the whole choice already sits above the roster. */}
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
      {/* The ladder is a handful of named levels, not a range, and a bare
          track hides that. One mark per reported level says how many stops the
          provider offers; the thumb is centered on the track's own ends, so the
          marks span it edge to edge. */}
      <div aria-hidden className="flex justify-between">
        {efforts.map((level) => (
          <span
            className="h-1 w-px rounded-full bg-muted-foreground/40"
            key={level}
          />
        ))}
      </div>
    </div>
  )
}
