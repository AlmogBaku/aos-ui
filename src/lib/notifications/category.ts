import {
  categoryOf as gatewayCategoryOf,
  type PushCategory,
} from "@harness-gw/sdk/protocol"

/**
 * Which category, if any, an activity event notifies as. The gateway names its
 * own events; aos-ui reports created Agents itself, and a ready one notifies
 * as a completion, one that still needs its operator as a failure.
 */
export function categoryOf(type: string): PushCategory | undefined {
  switch (type) {
    case "agent-ready":
      return "completion"
    case "agent-activation-failed":
      return "failure"
    default:
      return gatewayCategoryOf(type)
  }
}
