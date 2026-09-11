import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin"
import {
  Object as TypeObject,
  Optional,
  String as TypeString,
  Unsafe,
} from "typebox"

import { presentArtifact } from "./present-artifact.js"
import { createPresentationTools } from "./presentation.js"

const artifactParameters = TypeObject(
  {
    path: TypeString({ minLength: 1, maxLength: 4_096 }),
    title: Optional(TypeString({ minLength: 1, maxLength: 160 })),
    mimeType: Optional(TypeString({ minLength: 1, maxLength: 255 })),
  },
  { additionalProperties: false }
)

// External tool contexts do not carry Gateway operator authority. Keep
// create_agent and start_session out of both registration and static metadata.
export default defineToolPlugin({
  id: "aos-ui",
  name: "AOS UI presentation tools",
  description:
    "Structured presentations and workspace artifact validation for AOS UI. Artifact publication, Session handoff, and Agent creation are unsupported.",
  tools: (tool) => [
    ...Object.values(createPresentationTools()).map((definition) =>
      tool({
        name: definition.name,
        label: definition.label,
        description: definition.description,
        parameters: Unsafe(definition.parameters as never),
        factory: () => definition as never,
      })
    ),
    tool({
      name: "present_artifact",
      label: "Validate artifact",
      description:
        "Validate one existing regular file from this Agent workspace. Artifact publication is unsupported: this returns a text-only fallback without download authority.",
      parameters: artifactParameters,
      factory: ({ toolContext }) => ({
        name: "present_artifact",
        label: "Validate artifact",
        description:
          "Validate one existing regular file from this Agent workspace. Artifact publication is unsupported: this returns a text-only fallback without download authority.",
        parameters: artifactParameters,
        execute: (_toolCallId, params) => {
          if (!toolContext.workspaceDir)
            throw new Error("OpenClaw did not provide an Agent workspace")
          return presentArtifact(toolContext.workspaceDir, params)
        },
      }),
    }),
  ],
})
