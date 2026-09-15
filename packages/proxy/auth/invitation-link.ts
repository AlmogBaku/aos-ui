import { randomBytes } from "node:crypto"

import ms from "ms"
import { z } from "zod"

import {
  GuestInvitationError,
  type GuestInvitationService,
} from "./guest-invitation"

export class InvitationLinkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvitationLinkError"
  }
}

const InvitationLinkInputSchema = z.strictObject({
  agent: z.string(),
  ref: z.string().optional(),
  expiresIn: z.string().optional(),
  prefill: z.string().optional(),
  instruction: z.string().optional(),
  lang: z.enum(["en", "he"]).optional(),
  name: z.string().optional(),
  logo: z.string().optional(),
  accent: z.string().optional(),
  title: z.string().optional(),
  message: z.string().optional(),
})

export type InvitationLinkInput = z.input<typeof InvitationLinkInputSchema>

function durationSeconds(value: string) {
  const milliseconds = ms(value as ms.StringValue)
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0)
    throw new InvitationLinkError("expiresIn must be a positive duration")
  const seconds = milliseconds / 1_000
  if (!Number.isSafeInteger(seconds))
    throw new InvitationLinkError("expiresIn must resolve to whole seconds")
  return seconds
}

export async function issueInvitationLink(
  input: unknown,
  options: {
    invitations: GuestInvitationService
    publicOrigin: string
    randomBytes?: (size: number) => Uint8Array
  }
) {
  const parsed = InvitationLinkInputSchema.safeParse(input)
  if (!parsed.success) throw new InvitationLinkError("Invalid invitation input")
  const flags = parsed.data
  const agentId = flags.agent.trim()
  if (!agentId) throw new InvitationLinkError("agent is required")
  const suppliedRef = flags.ref?.trim()
  const ref =
    suppliedRef ||
    Buffer.from((options.randomBytes ?? randomBytes)(16)).toString("base64url")
  const instruction = flags.instruction?.trim()
  const ui = {
    ...(flags.lang ? { lang: flags.lang } : {}),
    ...(flags.name ? { name: flags.name } : {}),
    ...(flags.logo ? { logoUrl: flags.logo } : {}),
    ...(flags.accent ? { accent: flags.accent } : {}),
    ...(flags.title ? { title: flags.title } : {}),
    ...(flags.message ? { message: flags.message } : {}),
  }
  let token: string
  try {
    const issued = await options.invitations.issue({
      agentId,
      ref,
      expiresInSeconds: durationSeconds(flags.expiresIn ?? "72h"),
      ...(instruction || flags.prefill
        ? {
            firstTurn: {
              ...(instruction ? { instruction } : {}),
              ...(flags.prefill ? { prefill: flags.prefill } : {}),
            },
          }
        : {}),
      ...(Object.keys(ui).length === 0 ? {} : { ui }),
    })
    token = issued.token
  } catch (error) {
    if (error instanceof GuestInvitationError)
      throw new InvitationLinkError("Invalid invitation input")
    throw error
  }
  return {
    agentId,
    url: `${options.publicOrigin}/#invite=${encodeURIComponent(token)}`,
  }
}
