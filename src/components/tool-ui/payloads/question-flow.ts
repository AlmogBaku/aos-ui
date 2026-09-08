import { z } from "zod"

const questionOptionSchema = z.union([
  z.string().min(1),
  z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
  }),
])

export const questionPayloadSchema = z
  .object({
    args: z.object({
      question: z.string().min(1),
      options: z.array(questionOptionSchema).optional(),
      allowFreeform: z.boolean().optional(),
    }),
    result: z.unknown().optional(),
  })
  .refine(
    ({ args }) =>
      args.allowFreeform === true || (args.options?.length ?? 0) > 0,
    {
      message: "A question requires options or a freeform answer",
      path: ["args", "options"],
    }
  )

export type QuestionPayload = z.infer<typeof questionPayloadSchema>
