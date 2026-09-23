/**
 * The model a Hermes Session is on, and the catalog id that names it.
 *
 * The workspace's model option and a run's model changes read a Session's
 * model through this one module, so a change a run reports is always an id the
 * option offers.
 */
import { isRecord } from "./native"

const MAX_MODEL_FIELD_LENGTH = 256

function modelField(value: unknown) {
  return typeof value === "string" &&
    value.trim() &&
    value.length <= MAX_MODEL_FIELD_LENGTH
    ? value.trim()
    : undefined
}

export function nativeProviderSlug(value: unknown) {
  const provider = modelField(value)
  return provider && /^[\w.-]+$/u.test(provider) ? provider : undefined
}

/** A model name Hermes can be asked for, without option-like leading dashes. */
export function nativeModelName(value: unknown) {
  const model = modelField(value)
  return model && !/\s|^[-\u2012-\u2015]/u.test(model) ? model : undefined
}

/**
 * The model a Session is on, as Hermes reports it for the Session itself. A pick
 * made while a turn streams is stashed for the next turn start, so the catalog —
 * which reports the model the live agent holds — still names the model the
 * Session is leaving.
 */
export function projectSessionModel(info: unknown) {
  if (!isRecord(info)) return undefined
  const provider = modelField(info.provider)
  const model = modelField(info.model)
  return provider && model ? { provider, model } : undefined
}

/** The Session's model under the catalog id the model option reads and writes. */
export function sessionModelChoice(info: unknown) {
  const current = projectSessionModel(info)
  const provider = nativeProviderSlug(current?.provider)
  const model = nativeModelName(current?.model)
  return provider && model
    ? { id: JSON.stringify([provider, model]), provider, model }
    : undefined
}

export type SessionModelChoice = NonNullable<
  ReturnType<typeof sessionModelChoice>
>
