// Selected assistant-ui Elements dependencies; see ../voice/UPSTREAM.md.
import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

export const paper = "bg-background border border-border/60 dark:bg-popover"
export const field = "bg-foreground/[0.04] dark:bg-foreground/[0.06]"
export const ghostButton =
  "flex items-center justify-center rounded-full text-foreground/45 outline-none transition-[background-color,color,scale] duration-150 hover:bg-foreground/[0.06] hover:text-foreground/90 active:scale-[0.96] focus-visible:ring-1 focus-visible:ring-foreground/20 motion-reduce:transition-none dark:hover:bg-foreground/[0.09]"
export const inkButton =
  "bg-foreground text-background transition-[opacity,scale] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:opacity-90 active:scale-[0.96] motion-reduce:transition-none"
export const iconSwap =
  "[grid-area:1/1] transition-[opacity,scale,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
export const iconSwapIn = "scale-100 opacity-100 blur-none"
export const iconSwapOut = "scale-[0.25] opacity-0 blur-[4px]"
export const mono = "font-mono text-[11px] tracking-tight"

export function ShimmerLabel({
  active = true,
  className,
  ...props
}: ComponentProps<"span"> & { active?: boolean }) {
  return (
    <span
      className={cn(active && "shimmer motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

export function pct(value: number, total: number) {
  if (!(total > 0)) return 0
  const share = (value / total) * 100
  return Number.isNaN(share) ? 0 : Math.min(100, Math.max(0, share))
}
export function announced(share: number) {
  return Math.round(share * 10) / 10
}
