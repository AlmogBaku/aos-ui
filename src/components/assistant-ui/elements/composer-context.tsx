"use client"

import type { ComponentProps } from "react"

import type {
  ComposerSessionCost,
  ComposerTurnUsage,
} from "@/components/assistant-ui/composer-features"
import { cn } from "@/lib/utils"
import { ghostButton, mono, paper, pct } from "./voice-surfaces"

export interface ComposerUsage {
  system: number
  tools: number
  messages: number
  total: number
}

export interface ComposerContextLabels {
  trigger: string
  title: string
  system: string
  tools: string
  messages: string
  total: string
  lastTurn: string
  sessionCost: string
  /** Each receives an already locale-formatted token count. */
  inputTokens: (count: string) => string
  outputTokens: (count: string) => string
  cachedTokens: (count: string) => string
}

const DEFAULT_LABELS: ComposerContextLabels = {
  trigger: "Context usage",
  title: "Context",
  system: "System",
  tools: "Tools",
  messages: "Messages",
  total: "Total",
  lastTurn: "Last turn",
  sessionCost: "Session cost",
  inputTokens: (count) => `${count} in`,
  outputTokens: (count) => `${count} out`,
  cachedTokens: (count) => `${count} cached`,
}

/** The last turn's tokens as one line: input · output · cached, as reported. */
export function formatTurnUsage(
  usage: ComposerTurnUsage,
  labels: Pick<
    ComposerContextLabels,
    "inputTokens" | "outputTokens" | "cachedTokens"
  >,
  locale: string
): string {
  const compact = new Intl.NumberFormat(locale, { notation: "compact" })
  const format = (
    count: number | undefined,
    label: (value: string) => string
  ) => (count === undefined ? [] : [label(compact.format(count))])
  const parts = [
    ...format(usage.inputTokens, labels.inputTokens),
    ...format(usage.outputTokens, labels.outputTokens),
    ...format(usage.cachedReadTokens, labels.cachedTokens),
  ]
  if (parts.length === 0 && usage.totalTokens !== undefined)
    return compact.format(usage.totalTokens)
  return parts.join(" · ")
}

/** A cost in its own currency; an unknown code keeps the amount readable. */
export function formatSessionCost(
  cost: ComposerSessionCost,
  locale: string
): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: cost.currency,
    }).format(cost.amount)
  } catch {
    return `${new Intl.NumberFormat(locale).format(cost.amount)} ${cost.currency}`
  }
}

function clamp(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

// Assistant UI Elements' ComposerContext, localized for AOS. Usage values are
// expressed in thousands of tokens, matching the upstream component contract.
export function ComposerContext({
  usage,
  visibleSegments = ["system", "tools", "messages"],
  lastTurn,
  cost,
  locale = "en",
  labels = DEFAULT_LABELS,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  usage: ComposerUsage
  visibleSegments?: readonly ("system" | "tools" | "messages")[]
  lastTurn?: ComposerTurnUsage | undefined
  cost?: ComposerSessionCost | undefined
  /** Formats token counts and the cost; the popover copy comes from `labels`. */
  locale?: string
  labels?: ComposerContextLabels
}) {
  const turnUsage = lastTurn ? formatTurnUsage(lastTurn, labels, locale) : ""
  const accounting = [
    ...(turnUsage ? [{ label: labels.lastTurn, value: turnUsage }] : []),
    ...(cost
      ? [
          {
            label: labels.sessionCost,
            value: formatSessionCost(cost, locale),
          },
        ]
      : []),
  ]
  const used = usage.system + usage.tools + usage.messages
  const fraction = usage.total === 0 ? 0 : used / usage.total
  const warn = fraction > 0.85
  const circumference = 2 * Math.PI * 6
  const segments = [
    {
      id: "system" as const,
      label: labels.system,
      value: usage.system,
      className: "bg-foreground/25",
    },
    {
      id: "tools" as const,
      label: labels.tools,
      value: usage.tools,
      className: "bg-foreground/45",
    },
    {
      id: "messages" as const,
      label: labels.messages,
      value: usage.messages,
      className: "bg-foreground/80",
    },
  ].filter((segment) => visibleSegments.includes(segment.id))

  return (
    <div
      data-slot="composer-context"
      className={cn("group/ctx relative", className)}
      {...props}
    >
      <div
        className={cn(
          paper,
          "absolute end-0 bottom-full z-10 mb-1.5 flex origin-bottom-right flex-col gap-2 rounded-lg p-2",
          accounting.length ? "w-64" : "w-48",
          "transition-[opacity,scale] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
          "pointer-events-none scale-[0.97] opacity-0",
          "group-hover/ctx:pointer-events-auto group-hover/ctx:scale-100 group-hover/ctx:opacity-100",
          "group-focus-within/ctx:pointer-events-auto group-focus-within/ctx:scale-100 group-focus-within/ctx:opacity-100"
        )}
      >
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between">
            <p className="text-xs font-medium">{labels.title}</p>
            <p
              className={cn(
                mono,
                "tabular-nums",
                warn ? "text-red-500 dark:text-red-400" : "text-foreground/35"
              )}
            >
              {Math.round(fraction * 100)}%
            </p>
          </div>
          <div className="flex h-1 w-full gap-px overflow-hidden rounded-full bg-foreground/[0.06]">
            {/*
            A provider that attributes nothing still knows what it used, so the
            bar reports that one unlabeled amount rather than reading empty
            against a ring that shows the same context as filled.
          */}
            {(segments.length
              ? segments
              : [
                  {
                    label: labels.total,
                    value: used,
                    className: "bg-foreground/80",
                  },
                ]
            ).map((segment) => (
              <span
                key={segment.label}
                className={cn(
                  "h-full transition-[width] duration-700 motion-reduce:transition-none",
                  segment.className
                )}
                style={{ width: `${pct(segment.value, usage.total)}%` }}
              />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          {segments.map((segment) => (
            <div
              key={segment.label}
              className="flex items-center gap-1.5 text-xs leading-4 text-foreground/55"
            >
              <span
                aria-hidden
                className={cn("size-1.5 rounded-full", segment.className)}
              />
              <span className="flex-1">{segment.label}</span>
              <span className={cn(mono, "text-foreground/40 tabular-nums")}>
                {segment.value}k
              </span>
            </div>
          ))}
        </div>
        <div className="h-px bg-foreground/[0.06]" />
        <div className="flex items-center justify-between text-xs leading-4 text-foreground/55">
          <span>{labels.total}</span>
          <span className={cn(mono, "text-foreground/40 tabular-nums")}>
            {used}k / {usage.total}k
          </span>
        </div>
        {accounting.map((row) => (
          <div
            key={row.label}
            className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-xs leading-4 text-foreground/55"
          >
            <span>{row.label}</span>
            <span
              className={cn(
                mono,
                "ms-auto whitespace-nowrap text-foreground/40 tabular-nums"
              )}
            >
              {row.value}
            </span>
          </div>
        ))}
      </div>
      <button
        type="button"
        aria-label={labels.trigger}
        data-slot="composer-context-trigger"
        className={cn(
          ghostButton,
          "size-8",
          warn && "text-red-500 dark:text-red-400"
        )}
      >
        <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden>
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            strokeWidth="2.5"
            className="stroke-foreground/10"
          />
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="stroke-current transition-[stroke-dashoffset] duration-700 motion-reduce:transition-none"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - clamp(fraction, 0, 1))}
          />
        </svg>
      </button>
    </div>
  )
}
