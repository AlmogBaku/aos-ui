import {
  createGuestInvitationService,
  type GuestInvitationOptions,
} from "../auth/guest-invitation"
import {
  issueInvitationLink,
  type InvitationLinkInput,
} from "../auth/invitation-link"
import { loadProxyConfig, nodeConfigFileAccess } from "../config-file"
import { readSecretKeyFile } from "../secrets"
import type { ProxyCliDependencies } from "./types"

export type InviteFlags = InvitationLinkInput & {
  expiresIn: string
  config?: string
}

export async function createInvitationLink(
  flags: InviteFlags,
  dependencies: ProxyCliDependencies
) {
  // The configuration file is named, never discovered: minting a bearer
  // invitation stays an explicit act rather than a capability of the account.
  const { config: configFlag, ...link } = flags
  const config = await loadProxyConfig({
    flag: configFlag,
    getenv: dependencies.getenv,
    discover: false,
    ...nodeConfigFileAccess(dependencies),
  })
  if (!config.guest) throw new Error("Guest invitations are not configured")
  const keys = await Promise.all(
    config.guest.invitations.keys.map(async ({ id, secretFile }) => ({
      id,
      secret: await readSecretKeyFile(secretFile),
    }))
  )
  const options = {
    issuer: "aos-invite",
    audience: "aos-guest",
    deploymentId: config.deploymentId,
    runtimeId: config.runtime.id,
    keys,
    ttlSeconds: config.guest.invitations.ttlSeconds,
    clockSkewSeconds: config.guest.invitations.clockSkewSeconds,
    ...(dependencies.clock ? { now: dependencies.clock } : {}),
  } satisfies GuestInvitationOptions
  const invitations = createGuestInvitationService(options)
  return (
    await issueInvitationLink(link, {
      invitations,
      publicOrigin: config.guest.publicOrigin,
      ...(dependencies.randomBytes
        ? { randomBytes: dependencies.randomBytes }
        : {}),
    })
  ).url
}
