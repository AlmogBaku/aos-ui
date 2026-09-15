import { readFile } from "node:fs/promises"

import {
  createGuestInvitationService,
  type GuestInvitationOptions,
} from "../auth/guest-invitation"
import {
  issueInvitationLink,
  type InvitationLinkInput,
} from "../auth/invitation-link"
import { parseProxyConfig } from "../config"
import { readSecretKeyFile } from "../secrets"
import type { ProxyCliDependencies } from "./types"

export type InviteFlags = InvitationLinkInput & { expiresIn: string }

export async function createInvitationLink(
  flags: InviteFlags,
  dependencies: ProxyCliDependencies
) {
  const getenv = dependencies.getenv ?? ((name: string) => process.env[name])
  const configFile = getenv("AOS_RUNTIME_PROXY_CONFIG")
  if (!configFile)
    throw new Error("AOS_RUNTIME_PROXY_CONFIG must name the proxy config file")

  const config = parseProxyConfig(
    JSON.parse(await readFile(configFile, "utf8")) as unknown
  )
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
    await issueInvitationLink(flags, {
      invitations,
      publicOrigin: config.guest.publicOrigin,
      ...(dependencies.randomBytes
        ? { randomBytes: dependencies.randomBytes }
        : {}),
    })
  ).url
}
