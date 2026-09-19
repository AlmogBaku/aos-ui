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
- [Gateway V1](../design/aos-runtime-gateway-v1.md) — the Hermes-first slice
  that established the adapter seam.

Provider research records evidence rather than requirements:

- [Hermes Desktop connection](../research/hermes-desktop-gateway-connection.md)
- [Hermes native client reuse](../research/hermes-native-client-reuse.md)
- [Transport research for OpenClaw and OpenCode](../research/opencode-openclaw-runtime-transport-seams.md)
