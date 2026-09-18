"use client"

import {
  DirectionProvider,
  useDirection,
  type TextDirection,
} from "@base-ui/react/direction-provider"
import { Select } from "@base-ui/react/select"
import { CheckIcon, ChevronDownIcon } from "lucide-react"

import {
  ModelSelectorStatus,
  type ModelSelectorSelectionState,
} from "@/components/assistant-ui/elements/model-selector"
import { cn } from "@/lib/utils"

export type ModelEffortSelectorLabels = {
  readonly trigger: string
  /** Provider-reported effort ids mapped to localized names. */
  readonly levels: Record<string, string>
  readonly switching: string
  readonly retry: string
}

/**
 * Reasoning-effort picker for the selected model. Efforts are a short,
 * provider-reported list, so Select stays the right primitive here.
 */
export function ModelEffortSelector({
  efforts,
  value,
  onValueChange,
  selection = { status: "idle" },
  direction = "ltr",
  labels,
  className,
}: {
  efforts: readonly string[]
  value?: string | undefined
  onValueChange: (effortId: string) => void
  selection?: ModelSelectorSelectionState | undefined
  direction?: TextDirection | undefined
  labels: ModelEffortSelectorLabels
  className?: string | undefined
}) {
  return (
    <DirectionProvider direction={direction}>
      <Select.Root
        modal={false}
        value={value ?? null}
        onValueChange={(next) => {
          if (next !== null) onValueChange(next)
        }}
      >
        <ModelEffortSelectorTrigger
          className={className}
          labels={labels}
          value={value}
        />
        <ModelEffortSelectorContent
          efforts={efforts}
          labels={labels}
          selection={selection}
        />
      </Select.Root>
    </DirectionProvider>
  )
}

function ModelEffortSelectorTrigger({
  className,
  labels,
  value,
}: {
  className?: string | undefined
  labels: ModelEffortSelectorLabels
  value: string | undefined
}) {
  return (
    <Select.Trigger
      aria-label={labels.trigger}
      className={cn(
        "flex h-11 max-w-56 min-w-0 items-center justify-between gap-1.5 rounded-md px-1.5 text-xs font-medium text-foreground transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 motion-reduce:transition-none @min-[64rem]/workspace:h-7",
        className
      )}
      data-slot="model-effort-selector-trigger"
    >
      <span className="truncate">
        {value === undefined ? labels.trigger : (labels.levels[value] ?? value)}
      </span>
      <Select.Icon>
        <ChevronDownIcon className="size-3.5 opacity-60" />
      </Select.Icon>
    </Select.Trigger>
  )
}

function ModelEffortSelectorContent({
  efforts,
  labels,
  selection,
}: {
  efforts: readonly string[]
  labels: ModelEffortSelectorLabels
  selection: ModelSelectorSelectionState
}) {
  const direction = useDirection()
  return (
    <Select.Portal>
      <Select.Positioner
        align="start"
        alignItemWithTrigger={false}
        className="isolate z-50"
        side="top"
        sideOffset={6}
      >
        <Select.Popup
          className="min-w-(--anchor-width) rounded-xl bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none motion-reduce:animate-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          data-slot="model-effort-selector-content"
          dir={direction}
        >
          <ModelSelectorStatus labels={labels} selection={selection} />
          <Select.List className="max-h-72 overflow-y-auto py-1 outline-none">
            {efforts.map((effortId) => {
              const name = labels.levels[effortId] ?? effortId
              return (
                <Select.Item
                  className="relative flex cursor-default items-center rounded-lg py-1.5 ps-2 pe-8 text-sm outline-none data-highlighted:bg-muted data-selected:font-medium"
                  key={effortId}
                  label={name}
                  value={effortId}
                >
                  <Select.ItemText>{name}</Select.ItemText>
                  <Select.ItemIndicator className="absolute end-2 flex size-4 items-center justify-center">
                    <CheckIcon className="size-3.5" />
                  </Select.ItemIndicator>
                </Select.Item>
              )
            })}
          </Select.List>
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
  )
}
