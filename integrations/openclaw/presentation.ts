import { presentationToolDefinitions } from "../../shared/presentation/tools.js"
import { z } from "zod"

import type { NativeTool } from "./tool-contract.js"
import { textResult } from "./tool-contract.js"

type PresentationTools = Record<
  keyof typeof presentationToolDefinitions,
  NativeTool
>

export function createPresentationTools(): PresentationTools {
  return Object.fromEntries(
    Object.entries(presentationToolDefinitions).map(([name, definition]) => [
      name,
      {
        name,
        label: name.replaceAll("_", " "),
        description: definition.description,
        parameters: z.toJSONSchema(definition.schema, {
          unrepresentable: "any",
          io: "input",
        }) as Record<string, unknown>,
        async execute(_toolCallId: string, params: unknown) {
          const value = definition.schema.parse(params)
          const title =
            "title" in value && typeof value.title === "string"
              ? value.title
              : "Structured presentation"
          return textResult(
            `${title}\n\nStructured fallback:\n${JSON.stringify(value, null, 2)}`,
            {
              ok: true,
              type: "aos.presentation",
              presentation: { kind: name, value },
            }
          )
        },
      } satisfies NativeTool,
    ])
  ) as PresentationTools
}
