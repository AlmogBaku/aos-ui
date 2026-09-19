import type { SessionConfigOption } from "@agentclientprotocol/sdk/experimental/v2"

import type { ConfigOptionsOf, ConfigWriteOf } from "./types"

const MODEL_CONFIG_ID = "model"
const THOUGHT_CONFIG_ID = "thought_level"

export const configOptionsOf = ((models) => {
  const options: SessionConfigOption[] = [
    {
      type: "select",
      configId: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      currentValue: models.selectedId,
      options: models.options.map(({ id, label }) => ({
        value: id,
        name: label,
      })),
    },
  ]
  const efforts = models.options.find(
    (option) => option.id === models.selectedId
  )?.efforts
  if (efforts?.length)
    options.push({
      type: "select",
      configId: THOUGHT_CONFIG_ID,
      name: "Thought level",
      category: "thought_level",
      // ACP requires a current value; the provider's own default reports no
      // effort, which stays unset rather than claiming one of the ladder's ids.
      currentValue: models.effortId ?? "",
      options: efforts.map((id) => ({ value: id, name: id })),
    })
  return options
}) satisfies ConfigOptionsOf

export const configWriteOf = ((configId, value) => {
  if (typeof value !== "string") return undefined
  if (configId === MODEL_CONFIG_ID) return { selectedId: value }
  if (configId === THOUGHT_CONFIG_ID) return { effortId: value }
  return undefined
}) satisfies ConfigWriteOf
