export type TextResult = {
  content: Array<{ type: "text"; text: string }>
  details: Record<string, unknown>
}

export type NativeTool = {
  name: string
  label: string
  description: string
  parameters: unknown
  execute: (toolCallId: string, params: unknown) => Promise<TextResult>
}

export function textResult(
  text: string,
  details: Record<string, unknown>
): TextResult {
  return { content: [{ type: "text", text }], details }
}

export function requiredText(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} is required`)
  const result = value.trim()
  if (result.length > maximum)
    throw new Error(`${label} must be at most ${maximum} characters`)
  return result
}

export function optionalText(value: unknown, label: string, maximum: number) {
  if (value === undefined) return undefined
  return requiredText(value, label, maximum)
}

export function objectValue(value: unknown, label = "Input") {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
