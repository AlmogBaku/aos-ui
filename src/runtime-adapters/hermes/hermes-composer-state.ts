import {
  composerUsageFromTokens,
  type ComposerModelOption,
} from "@/components/assistant-ui/composer-features"
import type { ComposerUsage } from "@/components/assistant-ui/elements/composer-context"
import { isRecord, stringValue } from "./hermes-native-codec"

export type HermesModelOption = ComposerModelOption & {
  provider: string
  model: string
}
export type HermesComposerState = {
  model?: { options: readonly HermesModelOption[]; selectedId: string }
  context?: {
    usedTokens: number
    maxTokens: number
    estimated?: boolean
    breakdown?: {
      systemTokens: number
      toolTokens: number
      messageTokens: number
    }
  }
}

const SYSTEM_CATEGORIES = new Set([
  "system_prompt",
  "rules",
  "skills",
  "memory",
])
const TOOL_CATEGORIES = new Set([
  "tool_definitions",
  "mcp",
  "subagent_definitions",
])

function readContextBreakdown(value: unknown) {
  if (!Array.isArray(value)) return undefined
  let systemTokens = 0
  let toolTokens = 0
  let messageTokens = 0
  let recognized = false
  for (const item of value) {
    if (!isRecord(item)) continue
    const id = stringValue(item.id)
    const tokens = item.tokens
    if (
      !id ||
      typeof tokens !== "number" ||
      !Number.isSafeInteger(tokens) ||
      tokens < 0
    )
      continue
    if (SYSTEM_CATEGORIES.has(id)) systemTokens += tokens
    else if (TOOL_CATEGORIES.has(id)) toolTokens += tokens
    else if (id === "conversation") messageTokens += tokens
    else continue
    recognized = true
  }
  return recognized ? { systemTokens, toolTokens, messageTokens } : undefined
}

export function readHermesContext(
  value: unknown
): HermesComposerState["context"] {
  if (!isRecord(value)) return undefined
  const source = value.context_source
  const estimated = value.context_estimated
  if (
    !["provider_usage", "provider_usage_plus_estimate", "local_estimate"].includes(
      String(source)
    ) ||
    typeof estimated !== "boolean" ||
    (source === "provider_usage" ? estimated : !estimated)
  )
    return undefined
  const used = value.context_used
  const max = value.context_max
  const breakdown = readContextBreakdown(value.categories)
  return typeof used === "number" &&
    Number.isSafeInteger(used) &&
    used >= 0 &&
    typeof max === "number" &&
    Number.isSafeInteger(max) &&
    max > 0
      ? {
        usedTokens: used,
        maxTokens: max,
        ...(estimated ? { estimated: true } : {}),
        ...(breakdown ? { breakdown } : {}),
      }
    : undefined
}

export function toHermesComposerUsage(
  context: NonNullable<HermesComposerState["context"]>
): ComposerUsage {
  const used = Math.round(context.usedTokens / 1_000)
  const total = Math.round(context.maxTokens / 1_000)
  const breakdown = context.breakdown
  if (!breakdown) return { system: 0, tools: 0, messages: used, total }
  return composerUsageFromTokens({
    ...breakdown,
    usedTokens: context.usedTokens,
    maxTokens: context.maxTokens,
  })
}

export function readHermesModels(value: unknown): HermesComposerState["model"] {
  if (!isRecord(value) || !Array.isArray(value.providers))
    throw new Error("Hermes returned an invalid model catalog")
  const options: HermesModelOption[] = []
  for (const row of value.providers) {
    if (
      !isRecord(row) ||
      !Array.isArray(row.models) ||
      row.authenticated === false
    )
      continue
    const provider = stringValue(row.slug)
    if (!provider || !/^[\w.-]+$/u.test(provider)) continue
    for (const raw of row.models) {
      const model = stringValue(raw)
      // Native config.set parses flags from whitespace; catalog values must not
      // be able to introduce a different scope or provider.
      if (!model || /\s|^[-\u2012-\u2015]/u.test(model)) continue
      const id = JSON.stringify([provider, model])
      if (!options.some((option) => option.id === id))
        options.push({
          id,
          label: model,
          group: stringValue(row.name) ?? provider,
          provider,
          model,
        })
    }
  }
  const selectedId = JSON.stringify([value.provider, value.model])
  return { options, selectedId }
}
