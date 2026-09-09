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
  readonly group?: string | undefined
}

type ModelSelectorContextValue = {
  readonly models: readonly ModelOption[]
  readonly value: string
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
  direction = "ltr",
  children,
}: {
  models: readonly ModelOption[]
  value: string
  onValueChange: (value: string) => void
  direction?: TextDirection | undefined
  children: ReactNode
}) {
  return (
    <DirectionProvider direction={direction}>
      <ModelSelectorContext.Provider value={{ models, value }}>
        <Select.Root
          value={value}
          onValueChange={(nextValue) => {
            if (nextValue !== null) onValueChange(nextValue)
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
  const { models, value } = useModelSelectorContext()
  return (
    <Select.Value className="truncate">
      {models.find((model) => model.id === value)?.name}
    </Select.Value>
  )
}

export function ModelSelectorContent({
  className,
}: {
  className?: string | undefined
}) {
  const { models } = useModelSelectorContext()
  const direction = useDirection()
  const ungrouped = models.filter((model) => !model.group)
  const groups = new Map<string, ModelOption[]>()
  for (const model of models) {
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
          </Select.List>
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
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
      className="relative flex cursor-default items-center rounded-lg py-1.5 ps-2 pe-8 text-sm outline-none data-highlighted:bg-muted data-selected:font-medium"
    >
      <Select.ItemText>{model.name}</Select.ItemText>
      <Select.ItemIndicator className="absolute end-2 flex size-4 items-center justify-center">
        <CheckIcon className="size-3.5" />
      </Select.ItemIndicator>
    </Select.Item>
  )
}
