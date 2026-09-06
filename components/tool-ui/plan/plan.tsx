"use client"

import * as React from "react"
import { useMemo, useState, useEffect, useRef, memo } from "react"
import { Loader2, Check, X, MoreHorizontal, ChevronRight } from "lucide-react"
import type { PlanProps, PlanTodo, PlanTodoStatus } from "./schema"
import {
  cn,
  Card,
  CardHeader,
  CardDescription,
  CardContent,
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "./_adapter"
import { calculatePlanProgress, shouldCelebrateProgress } from "./progress"
import { useToolUiLocale } from "../locale"

const INITIAL_VISIBLE_TODO_COUNT = 4

const TodoIcon = memo(function TodoIcon({
  status,
}: {
  status: PlanTodoStatus
}) {
  if (status === "pending") {
    return (
      <span
        className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-card motion-safe:transition-all motion-safe:duration-200"
        aria-hidden="true"
      />
    )
  }

  if (status === "in_progress") {
    return (
      <span
        className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-card shadow-[0_0_0_4px_hsl(var(--primary)/0.1)] motion-safe:transition-all motion-safe:duration-300"
        aria-hidden="true"
      >
        <Loader2 className="size-5 text-primary motion-safe:animate-spin" />
      </span>
    )
  }

  if (status === "completed") {
    return (
      <span
        className="flex size-6 shrink-0 items-center justify-center rounded-full border border-primary bg-primary shadow-sm motion-safe:animate-in motion-safe:duration-300 motion-safe:ease-out motion-safe:zoom-in-75 motion-safe:fade-in"
        aria-hidden="true"
      >
        <Check
          className="size-4 text-primary-foreground motion-safe:animate-in motion-safe:delay-75 motion-safe:duration-200 motion-safe:fill-mode-both motion-safe:zoom-in-75 motion-safe:fade-in"
          strokeWidth={3}
        />
      </span>
    )
  }

  if (status === "cancelled") {
    return (
      <span
        className="flex size-6 shrink-0 items-center justify-center rounded-full border border-destructive bg-destructive shadow-sm motion-safe:animate-in motion-safe:duration-300 motion-safe:ease-out motion-safe:zoom-in-75 motion-safe:fade-in dark:border-red-600 dark:bg-red-600"
        aria-hidden="true"
      >
        <X
          className="size-4 text-white motion-safe:animate-in motion-safe:delay-75 motion-safe:duration-200 motion-safe:fill-mode-both motion-safe:zoom-in-75 motion-safe:fade-in"
          strokeWidth={3}
        />
      </span>
    )
  }

  return null
})

interface PlanTodoItemProps {
  todo: PlanTodo
  className?: string
  style?: React.CSSProperties
  showConnector?: boolean
}

function areTodoPropsEqual(
  prev: PlanTodoItemProps,
  next: PlanTodoItemProps
): boolean {
  if (prev.todo.id !== next.todo.id) return false
  if (prev.todo.label !== next.todo.label) return false
  if (prev.todo.status !== next.todo.status) return false
  if (prev.todo.description !== next.todo.description) return false
  if (prev.showConnector !== next.showConnector) return false
  if (prev.className !== next.className) return false
  const prevStyle = prev.style
  const nextStyle = next.style
  if (prevStyle === nextStyle) return true
  if (!prevStyle || !nextStyle) return false
  return (
    prevStyle.animationDelay === nextStyle.animationDelay &&
    prevStyle.animationFillMode === nextStyle.animationFillMode
  )
}

const PlanTodoItem = memo(function PlanTodoItem({
  todo,
  className,
  style,
  showConnector,
}: PlanTodoItemProps) {
  const [isOpen, setIsOpen] = React.useState(false)

  const labelElement = (
    <span
      className={cn(
        "text-sm leading-6 font-medium break-words",
        todo.status === "pending" && "text-muted-foreground",
        todo.status === "in_progress" &&
          "text-foreground shimmer-invert motion-safe:shimmer",
        (todo.status === "completed" || todo.status === "cancelled") &&
          "text-muted-foreground"
      )}
    >
      {todo.label}
    </span>
  )

  if (!todo.description) {
    return (
      <li
        className={cn(
          "relative -mx-2 flex cursor-default items-start gap-3 rounded-md px-2 py-1.5",
          className
        )}
        style={style}
      >
        {showConnector && (
          <div
            className="absolute start-5 top-6 w-px bg-border"
            style={{
              height: "calc(100% + 0.25rem)",
            }}
            aria-hidden="true"
          />
        )}
        <div className="relative z-10">
          <TodoIcon status={todo.status} />
        </div>
        <div className="min-w-0 flex-1">{labelElement}</div>
        {todo.statusLabel && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {todo.statusLabel}
          </span>
        )}
      </li>
    )
  }

  return (
    <li
      className={cn(
        "relative -mx-2 min-w-0 cursor-default rounded-md",
        className
      )}
      style={style}
    >
      {showConnector && (
        <div
          className="absolute start-5 top-6 w-px bg-border"
          style={{
            height: "calc(100% + 0.25rem)",
          }}
          aria-hidden="true"
        />
      )}
      <Collapsible
        open={isOpen}
        onOpenChange={setIsOpen}
        render={
          <div
            className="min-w-0 rounded-md data-[state=open]:bg-primary/5 motion-safe:transition-all motion-safe:duration-200"
            style={{
              backdropFilter: isOpen ? "blur(2px)" : undefined,
            }}
          />
        }
      >
        <CollapsibleTrigger className="group/todo flex w-full cursor-default items-start gap-3 px-2 py-1.5 text-start">
          <div className="relative z-10">
            <TodoIcon status={todo.status} />
          </div>
          <span className="min-w-0 flex-1">{labelElement}</span>
          {todo.statusLabel && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {todo.statusLabel}
            </span>
          )}
          <ChevronRight className="mt-0.5 size-4 shrink-0 rotate-90 text-muted-foreground/50 group-hover/todo:text-muted-foreground group-data-[state=open]/todo:[transform:rotateY(180deg)] motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out" />
        </CollapsibleTrigger>
        <CollapsibleContent
          className="group/content"
          data-slot="collapsible-content"
        >
          <div className="min-w-0 motion-safe:group-data-[state=closed]/content:animate-out motion-safe:group-data-[state=closed]/content:duration-150 motion-safe:group-data-[state=closed]/content:fade-out motion-safe:group-data-[state=closed]/content:slide-out-to-top-1 motion-safe:group-data-[state=open]/content:animate-in motion-safe:group-data-[state=open]/content:delay-75 motion-safe:group-data-[state=open]/content:duration-150 motion-safe:group-data-[state=open]/content:fill-mode-both motion-safe:group-data-[state=open]/content:fade-in motion-safe:group-data-[state=open]/content:slide-in-from-top-1">
            <p className="min-w-0 ps-11 pe-2 pb-1.5 text-sm text-pretty break-words text-muted-foreground">
              {todo.description}
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}, areTodoPropsEqual)

interface TodoListProps {
  todos: PlanTodo[]
  newTodoIds: Set<string>
}

function TodoList({ todos, newTodoIds }: TodoListProps) {
  return (
    <>
      {todos.map((todo, index) => {
        const isNew = newTodoIds.has(todo.id)
        const staggerDelay = isNew ? index * 50 : 0

        return (
          <PlanTodoItem
            key={todo.id}
            todo={todo}
            showConnector={index < todos.length - 1}
            className={cn(
              isNew &&
                "motion-safe:animate-in motion-safe:duration-300 motion-safe:ease-out motion-safe:fade-in motion-safe:slide-in-from-bottom-1"
            )}
            style={
              isNew
                ? {
                    animationDelay: `${staggerDelay}ms`,
                    animationFillMode: "backwards",
                  }
                : undefined
            }
          />
        )
      })}
    </>
  )
}

interface ProgressBarProps {
  progress: number
  isCelebrating: boolean
}

const ProgressBar = memo(function ProgressBar({
  progress,
  isCelebrating,
}: ProgressBarProps) {
  const { labels } = useToolUiLocale()

  return (
    <div
      className="relative mb-3 h-1.5 overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-label={labels.planProgressLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
    >
      <div
        className={cn(
          "h-full rounded-full motion-safe:transition-all motion-safe:duration-500",
          progress === 100
            ? "bg-success motion-safe:animate-in motion-safe:duration-500 motion-safe:ease-out motion-safe:fade-in"
            : "bg-primary"
        )}
        style={{ width: `${progress}%` }}
      />
      {isCelebrating && (
        <div className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-success/30 motion-safe:animate-pulse" />
      )}
    </div>
  )
})

function PlanRoot({
  id,
  title,
  caption = "Attached to this response.",
  description,
  todos,
  maxVisibleTodos = INITIAL_VISIBLE_TODO_COUNT,
  progressLabel = (completed, total) =>
    `${completed} of ${total} plan steps complete`,
  moreLabel = (count) => `${count} more`,
  className,
  headingLevel = 2,
  compact = false,
}: PlanProps & { compact?: boolean }) {
  const seenTodoIds = useRef(new Set<string>())
  const [newTodoIds, setNewTodoIds] = useState<Set<string>>(new Set())
  const [isCelebrating, setIsCelebrating] = useState(false)
  const prevProgressRef = useRef(0)
  const Heading = headingLevel === 2 ? "h2" : "h3"

  const { visibleTodos, hiddenTodos, completedCount, allComplete, progress } =
    useMemo(() => {
      const completed = todos.filter((t) => t.status === "completed").length
      return {
        visibleTodos: todos.slice(0, maxVisibleTodos),
        hiddenTodos: todos.slice(maxVisibleTodos),
        completedCount: completed,
        allComplete: completed === todos.length,
        progress: calculatePlanProgress({
          completedCount: completed,
          totalCount: todos.length,
        }),
      }
    }, [todos, maxVisibleTodos])

  useEffect(() => {
    const newIds = new Set<string>()

    todos.forEach((todo) => {
      if (!seenTodoIds.current.has(todo.id)) {
        newIds.add(todo.id)
        seenTodoIds.current.add(todo.id)
      }
    })

    if (newIds.size > 0) {
      setNewTodoIds(newIds)

      // Clear animation class after entrance completes
      const timer = setTimeout(() => {
        setNewTodoIds(new Set())
      }, 500)

      return () => clearTimeout(timer)
    }
  }, [todos])

  useEffect(() => {
    const shouldCelebrate = shouldCelebrateProgress({
      previous: prevProgressRef.current,
      next: progress,
    })
    prevProgressRef.current = progress

    if (shouldCelebrate) {
      setIsCelebrating(true)
      const timer = setTimeout(() => setIsCelebrating(false), 1000)
      return () => clearTimeout(timer)
    }
  }, [progress])

  const todoList = (
    <ul className={cn("min-w-0 space-y-1", compact ? "mt-0" : "mt-4")}>
      <TodoList todos={visibleTodos} newTodoIds={newTodoIds} />

      {hiddenTodos.length > 0 && (
        <li className="mt-1">
          <Accordion>
            <AccordionItem value="more" className="border-0">
              <AccordionTrigger className="flex cursor-default items-start justify-start gap-2 py-1 text-sm font-normal text-muted-foreground hover:text-primary [&>svg:last-child]:hidden">
                <MoreHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground/70" />
                <span>{moreLabel(hiddenTodos.length)}</span>
              </AccordionTrigger>
              <AccordionContent className="pt-2 pb-0">
                <ul className="-mx-2 space-y-2 px-2">
                  <TodoList todos={hiddenTodos} newTodoIds={newTodoIds} />
                </ul>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </li>
      )}
    </ul>
  )

  return (
    <Card
      className={cn("isolate w-full max-w-xl min-w-80 gap-4 py-4", className)}
      data-tool-ui-id={id}
      data-slot="plan"
    >
      <CardHeader
        className={cn(
          "flex flex-row items-start justify-between gap-4",
          compact && "px-4 pb-0"
        )}
      >
        <div className="space-y-1.5">
          <Heading
            className="font-heading text-base leading-5 font-medium text-pretty"
            dir="auto"
          >
            {title}
          </Heading>
          <CardDescription>{caption}</CardDescription>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {allComplete && (
          <Check className="mt-0.5 size-5 shrink-0 text-success" />
        )}
      </CardHeader>

      <CardContent className="min-w-0 px-4">
        <div
          className={cn(
            "min-w-0",
            !compact && "rounded-lg bg-muted/70 px-6 py-4"
          )}
        >
          <>
            <div className="mb-2 text-sm text-muted-foreground">
              {progressLabel(completedCount, todos.length)}
            </div>
            <ProgressBar progress={progress} isCelebrating={isCelebrating} />
          </>
          {todoList}
        </div>
      </CardContent>
    </Card>
  )
}

function PlanComponent(props: PlanProps) {
  return <PlanRoot key={props.id} {...props} />
}

export function PlanCompact(props: PlanProps) {
  return <PlanRoot key={props.id} {...props} compact />
}

type PlanComponentType = typeof PlanComponent & {
  Compact: typeof PlanCompact
}

export const Plan = Object.assign(PlanComponent, {
  Compact: PlanCompact,
}) as PlanComponentType
