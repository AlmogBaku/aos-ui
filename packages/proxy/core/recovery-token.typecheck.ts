/**
 * Compile-time proof that a recovery position is opaque above the adapters:
 * whatever string a handle mints is what `recover` is asked with, and no
 * layer above an adapter can require a shape of it. `tsconfig.proxy.json`
 * typechecks this file; nothing imports or runs it.
 */
import type { RecoveryRequest, ServerTurnHandle } from "./runtime"

type Positioned = Pick<ServerTurnHandle, "recoveryPosition">

export const minted: Positioned = { recoveryPosition: () => "any-token" }

export const requested: RecoveryRequest = {
  sessionId: "s-1",
  turnId: "t-1",
  position: minted.recoveryPosition(),
}

export const structured: Positioned = {
  // @ts-expect-error A structured position is its adapter's own business.
  recoveryPosition: () => ({ epoch: "e-1", lastSeen: 0 }),
}
