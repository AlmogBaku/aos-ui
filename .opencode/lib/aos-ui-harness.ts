import { openCodeProviderInstructions } from "../../lib/harness/manifests"

const HARNESS_SENTINEL = "AOS presentation harness:"

export function appendAosUiHarness(
  system: string[],
  instructions = openCodeProviderInstructions
) {
  if (system.some((instruction) => instruction.includes(HARNESS_SENTINEL))) {
    return false
  }
  system.push(instructions)
  return true
}
