# Hermes dashboard API references

The server-side `HermesDashboardClient` follows the Hermes dashboard HTTP
contract audited at NousResearch/hermes-agent commit
[`643b3f450df1c6c884b2de8d0832d0af9b6ed272`](https://github.com/NousResearch/hermes-agent/tree/643b3f450df1c6c884b2de8d0832d0af9b6ed272).
AOS's separately tested compatibility revision remains
[`b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b`](https://github.com/NousResearch/hermes-agent/tree/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b)
(`v2026.9.7`).

Contract references:

- [Authoritative Session HTTP routes](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/hermes_cli/web_routers/sessions.py#L528-L564)
- [Desktop Session wrappers and pagination](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/src/api/sessions.ts#L392-L638)
- [Desktop multi-page history test](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/src/hermes.test.ts#L587-L638)
- [Desktop audio wrappers](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/src/api/system.ts#L171-L207)
- [Desktop toolset configuration wrapper](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/src/api/toolsets.ts#L1-L50)
- [Web dashboard API reference](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/web/src/lib/api.ts)
- [Gateway event contract](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/shared/src/gateway-events.json)
- [JSON-RPC request channel](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/shared/src/json-rpc-channel.ts)
- [WebSocket ticket subprotocol handling](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/hermes_cli/web_server_chat.py#L202-L217)
- [MIT license](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/LICENSE)

The client contains only the route, query, and request-body construction needed
by the existing server adapter. No Hermes implementation source is vendored.
Runtime validation and provider-to-AOS projection remain in the adapter and
content modules. AOS continues to own credentials, bounded decoding, ticket
subprotocol use, redaction, uncertain-send handling, and authoritative
reconciliation.
