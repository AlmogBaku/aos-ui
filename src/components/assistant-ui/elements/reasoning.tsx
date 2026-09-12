"use client"

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { BrainIcon } from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { DisclosureChevron } from "./disclosure-chevron"
import { useToolUiLocale } from "@/components/tool-ui/locale"

export const ANIMATION_DURATION = 200

const ReasoningPreviewContext = createContext(false)

const reasoningVariants = cva("aui-reasoning-root mb-4 w-full", {
  variants: {
    variant: {
      outline: "rounded-lg border px-3 py-2",
      ghost: "",
      muted: "rounded-lg bg-muted/50 px-3 py-2",
    },
  },
  defaultVariants: {
    variant: "outline",
  },
})

export type ReasoningRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> &
  VariantProps<typeof reasoningVariants> & {
    open?: boolean
    onOpenChange?: (open: boolean) => void
    defaultOpen?: boolean
    /**
     * Whether the reasoning is currently streaming. While `true` the
     * disclosure is held open with a bottom-pinned live preview; when
     * streaming ends it returns to `defaultOpen`, and the first manual
     * toggle takes over the open/close state permanently. The live preview
     * keeps following the newest tokens while the disclosure is open during
     * streaming, even after a manual toggle, and pauses while the reader is
     * scrolled up.
     */
    streaming?: boolean
    /** Called right before the disclosure animates, on toggle and on streaming transitions. */
    onAnimationStart?: () => void
  }

function ReasoningRoot({
  className,
  variant,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  streaming,
  onAnimationStart,
  children,
  ...props
}: ReasoningRootProps) {
  const [initialOpen] = useState(defaultOpen)
  const [userOpen, setUserOpen] = useState<boolean | null>(null)

  const isControlled = controlledOpen !== undefined
  const isOpen = isControlled
    ? controlledOpen
    : (userOpen ?? (streaming || initialOpen))
  const isPreview = streaming === true && isOpen

  const prevStreamingRef = useRef(streaming)
  useLayoutEffect(() => {
    if (prevStreamingRef.current === streaming) return
    prevStreamingRef.current = streaming
    // A streaming transition only animates the panel when the resting state
    // is collapsed; with `defaultOpen` the disclosure stays open across it.
    if (!isControlled && userOpen === null && !initialOpen) {
      onAnimationStart?.()
    }
  }, [streaming, isControlled, userOpen, initialOpen, onAnimationStart])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      onAnimationStart?.()
      if (!isControlled) {
        setUserOpen(open)
      }
      controlledOnOpenChange?.(open)
    },
    [onAnimationStart, isControlled, controlledOnOpenChange]
  )

  return (
    <Collapsible
      data-slot="reasoning-root"
      data-variant={variant}
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(
        "group/reasoning-root",
        reasoningVariants({ variant, className })
      )}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
      {...props}
    >
      <ReasoningPreviewContext.Provider value={isPreview}>
        {children}
      </ReasoningPreviewContext.Provider>
    </Collapsible>
  )
}

function ReasoningFade({
  side = "bottom",
  className,
  ...props
}: React.ComponentProps<"div"> & { side?: "top" | "bottom" }) {
  if (side === "top") {
    return (
      <div
        data-slot="reasoning-fade"
        className={cn(
          "aui-reasoning-fade pointer-events-none absolute inset-x-0 top-0 z-10 h-8",
          "bg-[linear-gradient(to_bottom,var(--color-background),transparent)]",
          "group-data-[variant=muted]/reasoning-root:bg-[linear-gradient(to_bottom,color-mix(in_oklab,var(--color-muted)_50%,var(--color-background)),transparent)]",
          "animate-in fade-in-0 motion-reduce:animate-none",
          "animation-duration-(--animation-duration)",
          className
        )}
        {...props}
      />
    )
  }

  return (
    <div
      data-slot="reasoning-fade"
      className={cn(
        "aui-reasoning-fade pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8",
        "bg-[linear-gradient(to_top,var(--color-background),transparent)]",
        "group-data-[variant=muted]/reasoning-root:bg-[linear-gradient(to_top,color-mix(in_oklab,var(--color-muted)_50%,var(--color-background)),transparent)]",
        "animate-in fade-in-0 motion-reduce:animate-none",
        "animation-duration-(--animation-duration)",
        className
      )}
      {...props}
    />
  )
}

function ReasoningTrigger({
  active,
  duration,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  active?: boolean
  duration?: number
}) {
  const { labels } = useToolUiLocale()
  const label = duration
    ? labels.assistant.reasoningDuration(duration)
    : labels.assistant.reasoning

  return (
    <CollapsibleTrigger
      data-slot="reasoning-trigger"
      className={cn(
        "aui-reasoning-trigger group/trigger origin-start flex max-w-[75%] items-center gap-2 py-1.5 text-sm text-muted-foreground transition-[color,scale] hover:text-foreground active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100",
        className
      )}
      {...props}
    >
      <BrainIcon
        data-slot="reasoning-trigger-icon"
        className="aui-reasoning-trigger-icon size-4 shrink-0"
      />
      <span
        data-slot="reasoning-trigger-label"
        className={cn(
          "aui-reasoning-trigger-label-wrapper inline-block leading-none tabular-nums",
          active && "shimmer motion-reduce:animate-none"
        )}
      >
        {label}
      </span>
      <DisclosureChevron
        data-slot="reasoning-trigger-chevron"
        className="aui-reasoning-trigger-chevron ms-1 mt-0.5"
      />
    </CollapsibleTrigger>
  )
}

function ReasoningContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  const isPreview = useContext(ReasoningPreviewContext)

  return (
    <CollapsibleContent
      data-slot="reasoning-content"
      className={cn(
        "aui-reasoning-content relative overflow-hidden text-sm text-muted-foreground outline-none",
        "group/collapsible-content ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
        "data-closed:animate-collapsible-up",
        "data-open:animate-collapsible-down",
        "data-closed:fill-mode-forwards",
        "data-closed:pointer-events-none",
        "[--tw-duration:var(--animation-duration)]",
        className
      )}
      {...props}
    >
      <ReasoningFade side="top" />
      {children}
      {isPreview ? <ReasoningFade /> : null}
    </CollapsibleContent>
  )
}

function ReasoningText({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="reasoning-text"
      className={cn(
        "aui-reasoning-text relative z-0 max-h-[min(24rem,50dvh)] min-w-0 touch-pan-y overflow-y-auto overscroll-contain ps-6 pt-2 pb-2 leading-relaxed text-pretty",
        "transform-gpu transition-[transform,opacity] ease-[cubic-bezier(0.32,0.72,0,1)]",
        "motion-reduce:animate-none motion-reduce:transition-none",
        "group-data-open/collapsible-content:animate-in",
        "group-data-closed/collapsible-content:animate-out",
        "group-data-open/collapsible-content:fade-in-0",
        "group-data-closed/collapsible-content:fade-out-0",
        "group-data-open/collapsible-content:slide-in-from-top-4",
        "group-data-closed/collapsible-content:slide-out-to-top-4",
        "group-data-open/collapsible-content:blur-in-[2px]",
        "group-data-closed/collapsible-content:blur-out-[2px]",
        "group-data-open/collapsible-content:animation-duration-(--animation-duration)",
        "group-data-closed/collapsible-content:animation-duration-(--animation-duration)",
        className
      )}
      {...props}
    >
      <div className="aui-reasoning-text-content space-y-4">{children}</div>
    </div>
  )
}

export {
  ReasoningRoot,
  ReasoningTrigger,
  ReasoningContent,
  ReasoningText,
  ReasoningFade,
  reasoningVariants,
}
