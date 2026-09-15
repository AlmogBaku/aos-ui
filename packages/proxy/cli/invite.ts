import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"

import ms from "ms"

import {
  createGuestInvitationService,
  type GuestInvitationOptions,
} from "../auth/guest-invitation"
import { parseProxyConfig } from "../config"
import { readSecretKeyFile } from "../secrets"
import type { ProxyCliDependencies } from "./types"

export type InviteFlags = {
  agent: string
  ref?: string
  expiresIn: string
  prefill?: string
  instruction?: string
  lang?: "en" | "he"
  name?: string
  logo?: string
  accent?: string
  title?: string
  message?: string
}

function optionalUi(flags: InviteFlags) {
  const ui = {
    ...(flags.lang ? { lang: flags.lang } : {}),
    ...(flags.name ? { name: flags.name } : {}),
    ...(flags.logo ? { logoUrl: flags.logo } : {}),
    ...(flags.accent ? { accent: flags.accent } : {}),
    ...(flags.title ? { title: flags.title } : {}),
    ...(flags.message ? { message: flags.message } : {}),
  }
  return Object.keys(ui).length === 0 ? undefined : ui
}

function durationSeconds(value: string) {
  const milliseconds = ms(value as ms.StringValue)
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0)
    throw new Error("--expires-in must be a positive duration")
  const seconds = milliseconds / 1_000
  if (!Number.isSafeInteger(seconds))
    throw new Error("--expires-in must resolve to whole seconds")
  return seconds
}

export async function createInvitationLink(
  flags: InviteFlags,
  dependencies: ProxyCliDependencies
) {
  const agent = flags.agent.trim()
  const instruction = flags.instruction?.trim()
  if (!agent) throw new Error("--agent is required")

  const entropy = dependencies.randomBytes ?? randomBytes
  const suppliedRef = flags.ref?.trim()
  const ref = suppliedRef || Buffer.from(entropy(16)).toString("base64url")
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
  const ui = optionalUi(flags)
  const { token } = await invitations.issue({
    agentId: agent,
    ref,
    expiresInSeconds: durationSeconds(flags.expiresIn),
    ...(instruction || flags.prefill
      ? {
          firstTurn: {
            ...(instruction ? { instruction } : {}),
            ...(flags.prefill ? { prefill: flags.prefill } : {}),
          },
        }
      : {}),
    ...(ui ? { ui } : {}),
  })
  return `${config.guest.publicOrigin}/#invite=${encodeURIComponent(token)}`
}
