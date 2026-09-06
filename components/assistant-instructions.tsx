"use client"

import { useAssistantInstructions } from "@assistant-ui/react"

export function AssistantInstructions({
  instructions,
}: {
  instructions: string
}) {
  useAssistantInstructions(instructions)
  return null
}
