// AOS shim — replaces upstream apps/shared/src/gateway-events.ts
//
// The upstream file re-exports the 176 KB generated gateway contract
// (gateway-contract.generated.ts), which embeds every native method and event
// type and is not vendored here. AOS only needs the structural shape of
// GatewayEvent and the name of the one event the vendored client acts on
// ('gateway.ready'). Loose types are intentional: the proxy adapter enforces
// field-level validation at its own boundary before exposing data to the rest
// of the stack.

export type GatewayEventName = string

export interface GatewayEventMap {
  "gateway.ready": {
    heartbeat?: boolean | null
    replay_epoch?: string
    [k: string]: unknown
  }
  [type: string]: unknown
}

export interface GatewayEvent<K extends GatewayEventName = GatewayEventName> {
  payload?: GatewayEventMap[K]
  seq?: number
  session_id?: string
  type: K
}
