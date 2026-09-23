import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
} from "@agentclientprotocol/sdk/experimental/v2"

import type { SessionModelsResponse } from "../../protocol"

import type { ConfigOptionsOf, ConfigWriteOf } from "./types"

const MODEL_CONFIG_ID = "model"
const THOUGHT_CONFIG_ID = "thought_level"

/** One ACP group per provider, in the order the catalog first names them. */
function modelGroupsOf(
  options: SessionModelsResponse["options"]
): SessionConfigSelectGroup[] {
  const groups = new Map<string, SessionConfigSelectGroup>()
  for (const { id, label, group } of options) {
    const known = groups.get(group)
    if (known) known.options.push({ value: id, name: label })
    else
      groups.set(group, {
        groupId: group,
        name: group,
        options: [{ value: id, name: label }],
      })
  }
  return [...groups.values()]
}

export const configOptionsOf = ((models) => {
  const options: SessionConfigOption[] = [
    {
      type: "select",
      configId: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      currentValue: models.selectedId,
      options: modelGroupsOf(models.options),
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
      // ACP requires a name; an effort the provider left unnamed goes by its id.
      options: efforts.map(({ id, name }) => ({ value: id, name: name ?? id })),
    })
  return options
}) satisfies ConfigOptionsOf

export const configWriteOf = ((configId, value) => {
  if (typeof value !== "string") return undefined
  if (configId === MODEL_CONFIG_ID) return { selectedId: value }
  if (configId === THOUGHT_CONFIG_ID) return { effortId: value }
  return undefined
}) satisfies ConfigWriteOf
