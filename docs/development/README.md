# AOS contributor documentation

These documents are for engineers and coding agents changing the normalized
runtime gateway. Operator setup and product usage remain in the
[operator documentation](../README.md).

## Runtime adapters

- [Author a runtime adapter](runtime-adapter-authoring.md) — map a native harness
  to the proxy-owned run vocabulary; the ACP layer handles browser delivery.
- [Hermes V1 retrospective](hermes-v1-retrospective.md) — understand the
  implementation choices and the mistakes that exposed the adapter contract.
- [Gateway architecture](../design/aos-runtime-gateway-architecture.md) — the
  normative final-system boundaries.
- [Gateway V1](../design/aos-runtime-gateway-v1.md) — dated completion record of
  the Hermes-first slice that established the adapter seam; not normative.
- [Hermes adapter package map](../../packages/proxy/adapters/hermes/README.md) —
  module layout and turn-lifecycle guide for the primary adapter.
- [Hermes turn lifecycle](../../packages/proxy/adapters/hermes/TURN-LIFECYCLE.md) —
  detailed event sequencing within one native turn.
- [Hermes vendored client provenance](../../packages/proxy/adapters/hermes/vendor/hermes-shared/UPSTREAM.md) —
  per-file hashes and sync recipe; the live vendor pin is also recorded in
  `docs/research/hermes-transport-audit-2026-09.md`.

## Browser wire

- [ACP v2 browser wire](../runtimes/acp.md) — all AOS extension methods,
  `_meta.aos` shapes, error codes, and REST routes.

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
