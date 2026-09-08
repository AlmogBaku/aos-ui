# Multi-engine AOS implementation plan

Status: superseded by the implemented native-runtime architecture.

The former plan proposed an AOS application server, a Hermes bridge, SQLite
correlation state, and AOS-owned Agent metadata. Those choices were rejected.
Do not use the historical proposal as implementation guidance.

The maintained specification is split across:

- [`PRODUCT.md`](../../../PRODUCT.md) for product scope and ownership;
- [`README.md`](../../../README.md) for supported deployment and verification;
- [`AGENTS.md`](../../../AGENTS.md) for contributor invariants;
- [`src/runtime-adapters/contracts.ts`](../../../src/runtime-adapters/contracts.ts)
  for the browser/provider boundary; and
- [`integrations/hermes/README.md`](../../../integrations/hermes/README.md) for
  the exact native Hermes revision, interfaces, installation, and current
  upstream creator limitation.

AOS is a static Vite/React application. OpenCode and Hermes are independent
native integrations and remain authoritative for Agents, metadata, Sessions,
history, execution, credentials, and permissions. AOS has no runtime registry,
Hermes bridge, management server, or operational database. Generic AG-UI and
fixture mode remain explicit, separate compositions; Monty remains optional.
