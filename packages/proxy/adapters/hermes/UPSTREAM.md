# Hermes dashboard API references

The server-side `HermesDashboardClient` follows the Hermes dashboard HTTP
contract audited at NousResearch/hermes-agent commit
[`47685348eaca9d673719003b9e03a71becfa6423`](https://github.com/NousResearch/hermes-agent/tree/47685348eaca9d673719003b9e03a71becfa6423).
AOS's separately tested compatibility revision remains
[`b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b`](https://github.com/NousResearch/hermes-agent/tree/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b)
(`v2026.9.7`).

Contract references:

- [Authoritative Session HTTP routes](https://github.com/NousResearch/hermes-agent/blob/47685348eaca9d673719003b9e03a71becfa6423/hermes_cli/web_routers/sessions.py#L528-L564)
- [Desktop Session wrappers and pagination](https://github.com/NousResearch/hermes-agent/blob/47685348eaca9d673719003b9e03a71becfa6423/apps/desktop/src/api/sessions.ts#L392-L638)
- [Desktop multi-page history test](https://github.com/NousResearch/hermes-agent/blob/47685348eaca9d673719003b9e03a71becfa6423/apps/desktop/src/hermes.test.ts#L587-L638)
- [Desktop audio wrappers](https://github.com/NousResearch/hermes-agent/blob/47685348eaca9d673719003b9e03a71becfa6423/apps/desktop/src/api/system.ts#L171-L207)
- [Desktop toolset configuration wrapper](https://github.com/NousResearch/hermes-agent/blob/47685348eaca9d673719003b9e03a71becfa6423/apps/desktop/src/api/toolsets.ts#L1-L50)
- [Web dashboard API reference](https://github.com/NousResearch/hermes-agent/blob/47685348eaca9d673719003b9e03a71becfa6423/web/src/lib/api.ts)
- [Gateway event contract](https://github.com/NousResearch/hermes-agent/blob/47685348eaca9d673719003b9e03a71becfa6423/apps/shared/src/gateway-events.json)
- [JSON-RPC request channel](https://github.com/NousResearch/hermes-agent/blob/47685348eaca9d673719003b9e03a71becfa6423/apps/shared/src/json-rpc-channel.ts)
- [MIT license](https://github.com/NousResearch/hermes-agent/blob/47685348eaca9d673719003b9e03a71becfa6423/LICENSE)

The HTTP client contains only the route, query, and request-body construction
needed by the server adapter. The vendored `JsonRpcGatewayClient`
(`vendor/hermes-shared/`) is a byte-identical copy of the upstream shared
package at the pinned commit; see
[`vendor/hermes-shared/UPSTREAM.md`](vendor/hermes-shared/UPSTREAM.md) for
per-file hashes and the sync recipe. Runtime validation, provider-to-AOS
projection, bounded decoding, redaction, uncertain-send handling, and
authoritative reconciliation remain in the adapter and content modules. AOS
authenticates the socket with a `?token=` query parameter on the dial and uses no
WebSocket ticket subprotocol.
