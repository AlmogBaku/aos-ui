# AOS contributor documentation

These documents are for engineers and coding agents changing AOS UI. The
gateway, its runtime adapters, the wire protocol, and the `@harness-gw/sdk`
client are maintained in [harness-gw](https://github.com/AlmogBaku/harness-gw); operator setup and product usage
remain in the [operator documentation](../README.md).

## Gateway and wire

- [harness-gw protocol](https://github.com/AlmogBaku/harness-gw/blob/main/docs/protocol.md) — ACP v2, the `_hgw/*`
  extension methods, `_meta.hgw` shapes, error codes, origins, and the
  `/api/v1` HTTP API.
- [Author a runtime adapter](https://github.com/AlmogBaku/harness-gw/blob/main/docs/development/runtime-adapter-authoring.md) —
  map a native harness to the gateway-owned turn vocabulary.
- [Gateway architecture](https://github.com/AlmogBaku/harness-gw/blob/main/docs/design/aos-runtime-gateway-architecture.md) —
  the normative final-system boundaries.
- [Hermes adapter package map](https://github.com/AlmogBaku/harness-gw/blob/main/src/adapters/hermes/README.md),
  [turn lifecycle](https://github.com/AlmogBaku/harness-gw/blob/main/src/adapters/hermes/TURN-LIFECYCLE.md), and
  [vendored client provenance](https://github.com/AlmogBaku/harness-gw/blob/main/src/adapters/hermes/UPSTREAM.md) —
  the primary adapter's layout, event sequencing, and upstream pin.

A client change that needs the SDK is made and tested in harness-gw, then
consumed here through the `@harness-gw/sdk` package (a local tarball until the
first release).

## AOS UI

- [Regenerate PWA icons](pwa-icons.md) — rasterize the adaptive logo with its
  light palette substituted; the generated PNGs are committed.
- [Hermes V1 retrospective](hermes-v1-retrospective.md) — understand the
  implementation choices and the mistakes that exposed the adapter contract.
  It predates the gateway's move to harness-gw, so its paths are historical.

Provider research records evidence rather than requirements:

- [Hermes Desktop connection](../research/hermes-desktop-gateway-connection.md)
- [Hermes native client reuse](../research/hermes-native-client-reuse.md)
- [Hermes transport audit 2026-09](../research/hermes-transport-audit-2026-09.md)
- [Transport research for OpenClaw and OpenCode](../research/opencode-openclaw-runtime-transport-seams.md)
- [Multi-harness gateway architecture](../research/multi-harness-gateway-architecture.md)
- [OpenCode and OpenClaw server clients](../research/opencode-openclaw-server-clients.md)

## Historical plans (dated completion records)

- [Hermes V1 implementation](../superpowers/plans/2026-09-14-complete-hermes-v1.md) — 2026-09-15
- [Hermes native contract alignment](../superpowers/plans/2026-09-13-hermes-native-contract-alignment.md) — 2026-09
- [AOS runtime proxy phases 2 and 3](../superpowers/plans/2026-09-14-aos-runtime-proxy-phases-2-3.md) — 2026-09-20
