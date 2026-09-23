import { z } from "zod"

export const permissionPayloadSchema = z.object({
  args: z.object({ action: z.string().min(1) }),
  result: z.unknown().optional(),
})

export type PermissionPayload = z.infer<typeof permissionPayloadSchema>

/**
 * Assistant UI's approval carries only the question put to the operator, so
 * the operation a provider permission names travels in the part's provider
 * metadata. It is the same on a guarded call, whose own arguments stay the
 * tool's, and on a permission that stands alone.
 */
export const permissionProviderMetadata = (action: string) => ({
  aos: { permissionAction: action },
})

export function readPermissionAction(part: {
  readonly providerMetadata?: {
    readonly [provider: string]: { readonly [key: string]: unknown }
  }
}): string | undefined {
  const action = part.providerMetadata?.aos?.permissionAction
  return typeof action === "string" && action.trim() ? action : undefined
}
