"use client"
import { ViewTitle } from "../ui/view-title"
import { cn } from "./_adapter"
import type {
  StatsDisplayProps,
  StatItem,
  StatFormat,
  StatDiff,
} from "./schema"
import { Sparkline } from "./sparkline"

interface FormattedValueProps {
  value: string | number
  format?: StatFormat
  locale?: string
}

function FormattedValue({ value, format, locale }: FormattedValueProps) {
  if (typeof value === "string" || !format) {
    return <span className="tabular-nums">{String(value)}</span>
  }

  switch (format.kind) {
    case "number": {
      const decimals = format.decimals ?? 0
      if (format.compact) {
        const parts = new Intl.NumberFormat(locale, {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
          notation: "compact",
        }).formatToParts(value)
        const fullNumber = new Intl.NumberFormat(locale).format(value)
        return (
          <span className="tabular-nums" aria-label={fullNumber}>
            {parts.map((part, i) =>
              part.type === "compact" ? (
                <span
                  key={i}
                  className="ms-0.5 text-[0.65em] opacity-80"
                  aria-hidden="true"
                >
                  {part.value}
                </span>
              ) : (
                <span key={i}>{part.value}</span>
              )
            )}
          </span>
        )
      }
      const formatted = new Intl.NumberFormat(locale, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(value)
      return <span className="tabular-nums">{formatted}</span>
    }
    case "currency": {
      const currency = format.currency
      const decimals = format.decimals ?? 2
      const formatted = new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(value)
      const spokenValue = new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        currencyDisplay: "name",
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(value)
      return (
        <span className="tabular-nums" aria-label={spokenValue}>
          {formatted}
        </span>
      )
    }
    case "percent": {
      const decimals = format.decimals ?? 2
      const basis = format.basis ?? "fraction"
      const numeric = basis === "fraction" ? value * 100 : value
      const formatted = new Intl.NumberFormat(locale, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(numeric)
      const spokenValue = new Intl.NumberFormat(locale, {
        style: "percent",
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(basis === "fraction" ? value : value / 100)
      return (
        <span className="tabular-nums" aria-label={spokenValue}>
          {formatted}
          <span className="ms-0.5 text-[0.65em] opacity-80" aria-hidden="true">
            %
          </span>
        </span>
      )
    }
    case "text":
    default:
      return <span className="tabular-nums">{String(value)}</span>
  }
}

interface DeltaValueProps {
  diff: StatDiff
}

function DeltaValue({ diff }: DeltaValueProps) {
  const { value, decimals = 1, upIsPositive = true, label } = diff

  const isPositive = value > 0
  const isNegative = value < 0

  const isGood = upIsPositive ? isPositive : isNegative
  const isBad = upIsPositive ? isNegative : isPositive

  const colorClass = isGood
    ? "text-success"
    : isBad
      ? "text-destructive"
      : "text-muted-foreground"

  const bgClass = isGood
    ? "bg-success/10 dark:bg-success/15"
    : isBad
      ? "bg-destructive/10 dark:bg-destructive/15"
      : "bg-muted"

  const formatted = Math.abs(value).toFixed(decimals)
  const sign = isNegative ? "−" : "+"
  const display = `${sign}${formatted}%`

  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
      <span
        className={cn(
          "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-medium tabular-nums",
          colorClass,
          bgClass
        )}
      >
        {!upIsPositive && <span aria-hidden="true">{isGood ? "↓" : "↑"}</span>}
        <bdi dir="ltr">{display}</bdi>
      </span>
      {label && <span className="text-muted-foreground">{label}</span>}
    </span>
  )
}

interface StatCardProps {
  stat: StatItem
  locale?: string
  index?: number
}

const ENTER =
  "animate-in duration-500 ease-out fill-mode-both fade-in slide-in-from-bottom-1 motion-reduce:animate-none"

function StatCard({ stat, locale, index = 0 }: StatCardProps) {
  const delay = { animationDelay: `${index * 75}ms` }

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 border-s border-border ps-3",
        ENTER
      )}
      style={delay}
    >
      <span className="truncate text-xs text-muted-foreground">
        {stat.label}
      </span>
      <span className="text-2xl leading-tight font-medium tracking-tight text-foreground">
        <FormattedValue
          value={stat.value}
          format={stat.format}
          locale={locale}
        />
      </span>
      {stat.diff && <DeltaValue diff={stat.diff} />}
      {stat.sparkline && (
        <Sparkline
          data={stat.sparkline.data}
          color={stat.sparkline.color ?? "var(--primary)"}
          showFill
          fillOpacity={0.12}
          className="mt-1 h-6"
          style={delay}
        />
      )}
    </div>
  )
}

/**
 * Metrics drawn flat inside the host's card: a compact heading, then one
 * column per metric that wraps as the frame narrows.
 */
export function StatsDisplay({
  id,
  title,
  description,
  stats,
  className,
  locale: localeProp,
}: StatsDisplayProps) {
  const locale =
    localeProp ??
    (typeof navigator !== "undefined" ? navigator.language : undefined)

  return (
    <article
      data-tool-ui-id={id}
      className={cn("flex w-full flex-col gap-4", className)}
    >
      {title && <ViewTitle title={title} description={description} />}
      <div
        className="grid gap-x-4 gap-y-5"
        // Tailwind's scale has no auto-fit track; metrics wrap by width.
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))",
        }}
      >
        {stats.map((stat, index) => (
          <StatCard key={stat.key} stat={stat} locale={locale} index={index} />
        ))}
      </div>
    </article>
  )
}
