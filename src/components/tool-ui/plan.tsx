import { z } from "zod"

import { Plan } from "./plan/index"
import { normalizeRichToolState } from "./lifecycle"
import { useToolUiLocale } from "./locale"
import type { RichToolPart } from "./types"

import { present_planSchema as planResultSchema } from "@shared/presentation/tools"

const fixturePlanPayloadSchema = z.object({
  args: z.object({ title: z.string().optional() }),
  result: planResultSchema,
})

const openCodePlanPayloadSchema = z
  .object({ args: planResultSchema, result: z.unknown().optional() })
  .transform(({ args }) => ({ args: { title: args.title }, result: args }))

/** OpenCode retains custom tool display payloads in call arguments. */
export const planPayloadSchema = z.union([
  fixturePlanPayloadSchema,
  openCodePlanPayloadSchema,
])

export type PlanPayload = z.infer<typeof planPayloadSchema>

export function PlanTool({
  part,
  payload,
}: {
  part: RichToolPart
  payload: PlanPayload
}) {
  const state = normalizeRichToolState(part)
  const { direction, labels, locale } = useToolUiLocale()
  return (
    <div
      className="mt-3"
      data-slot="inline-plan"
      data-state={state.phase}
      dir={direction}
      lang={locale}
    >
      <Plan
        id={payload.result.id}
        title={payload.result.title}
        caption={labels.planCaption}
        todos={payload.result.steps.map((step) => ({
          id: step.id,
          label: step.label,
          statusLabel: labels.planSteps[step.status],
          status:
            step.status === "active"
              ? "in_progress"
              : step.status === "failed"
                ? "cancelled"
                : step.status,
        }))}
        maxVisibleTodos={4}
        progressLabel={labels.planProgress}
        moreLabel={labels.showMorePlanSteps}
      />
    </div>
  )
}
