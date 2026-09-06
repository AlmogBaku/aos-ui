import { z } from "zod"

export const permissionPayloadSchema = z.object({
  args: z.object({ action: z.string().min(1) }),
  result: z.unknown().optional(),
})

export type PermissionPayload = z.infer<typeof permissionPayloadSchema>
