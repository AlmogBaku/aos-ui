"use client"

import { ChevronRightIcon } from "lucide-react"
import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

export function DisclosureChevron({
  className,
  ...props
}: ComponentProps<typeof ChevronRightIcon>) {
  return (
    <ChevronRightIcon
      aria-hidden="true"
      className={cn(
        "size-3.5 shrink-0 text-foreground/35 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-panel-open/trigger:rotate-90 group-data-open/trigger:rotate-90 motion-reduce:transition-none",
        className
      )}
      {...props}
    />
  )
}
