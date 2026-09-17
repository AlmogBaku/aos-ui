# Vendored upstream — hermes-shared

## License

MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Pin

Repository: `NousResearch/hermes-agent`
Commit: `47685348eaca9d673719003b9e03a71becfa6423`

## Files (byte-identical to upstream)

All files listed below are byte-identical copies of the upstream sources at the
pinned commit. The sha256 column is the SHA-256 hash of the file content. The
git-blob column is the GitHub blob object hash.

| Vendor file                       | Upstream path                                     | sha256                                                             | git-blob                                   |
| --------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ |
| `json-rpc-gateway.ts`             | `apps/shared/src/json-rpc-gateway.ts`             | `ab80102da6d5e0cd5c831271f4bd353e0b2ecb711281f1d78745e9149da293a8` | `338272b762c8f6fb03c99f5e67640b8539e4aef7` |
| `json-rpc-channel.ts`             | `apps/shared/src/json-rpc-channel.ts`             | `9ab20d7e9ab8829650a98dc8967283439ae13b11b46f36f4d64ea1243a5250d8` | `46b1f1b0be2ee363aeec5fedd146b4d313f1a1b0` |
| `reconnect-backoff.ts`            | `apps/shared/src/reconnect-backoff.ts`            | `323c4cd02b95010a6fd7a197f2ccb5182507142677d01fa506b08c055c5ff1f8` | `8a1dd756b5eb5ae0b4c7a310647e04f7b15ef3fb` |
| `json-rpc-channel.test.ts`        | `apps/shared/src/json-rpc-channel.test.ts`        | `bb49e96d31602af46c9787fc35f8c8e6a7600409f09c9592faa40cd259dbc343` | `80685ba8df1078a654dffe45b3c410f93c8a8e6b` |
| `json-rpc-gateway-replay.test.ts` | `apps/shared/src/json-rpc-gateway-replay.test.ts` | `58e0edbaf4b166f02a482dbacc74ac55e8df6740914e30dda74e6bb89dcbdfd6` | `a5875738308ace1f0b2dc1d8d189da1efcf4604e` |
| `reconnect-backoff.test.ts`       | `apps/shared/src/reconnect-backoff.test.ts`       | `149cb74814b5bfde1249dd75490a7bb7131e6ce4151e0cce247aa432d519323f` | `8bca2b7f5c27cc87015cc3bc1febdc7775d1a477` |
| `LICENSE`                         | `LICENSE`                                         | `821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6` | `75410e73319c72cd3e991a501c5455eb78f38375` |

`snapshot.test.ts` and `gateway-events.ts` are AOS-authored files and are not
listed here.

## Shim rationale

`gateway-events.ts` replaces `apps/shared/src/gateway-events.ts` from the
upstream repository. The upstream file re-exports the 176 KB generated gateway
contract (`gateway-contract.generated.ts`), which contains typed signatures for
every Hermes native method and event. Vendoring that file would:

1. Increase the vendor snapshot size by ~176 KB.
2. Require re-vendoring every time the Hermes API surface changes, even for
   unrelated event types.
3. Pull in upstream build artifacts that are not part of the semantic contract
   the AOS adapter relies on.

The AOS adapter only needs the structural shape of `GatewayEvent` (type, seq,
session_id, payload) and the specific payload shape of `gateway.ready`
(heartbeat, replay_epoch). The shim exports exactly those, with loose index
types for everything else. Field-level validation is performed at the
`gateway.ts` adapter boundary before data is exposed to the rest of the stack.

## Sync recipe

To update to a new upstream pin:

1. Fetch each upstream file verbatim:

   ```sh
   NEW_PIN=<new commit SHA>
   DEST=packages/proxy/adapters/hermes/vendor/hermes-shared

   gh api "repos/NousResearch/hermes-agent/contents/apps/shared/src/json-rpc-gateway.ts?ref=${NEW_PIN}" \
     --jq '.content' | base64 -d > "${DEST}/json-rpc-gateway.ts"

   gh api "repos/NousResearch/hermes-agent/contents/apps/shared/src/json-rpc-channel.ts?ref=${NEW_PIN}" \
     --jq '.content' | base64 -d > "${DEST}/json-rpc-channel.ts"

   gh api "repos/NousResearch/hermes-agent/contents/apps/shared/src/reconnect-backoff.ts?ref=${NEW_PIN}" \
     --jq '.content' | base64 -d > "${DEST}/reconnect-backoff.ts"

   gh api "repos/NousResearch/hermes-agent/contents/apps/shared/src/json-rpc-channel.test.ts?ref=${NEW_PIN}" \
     --jq '.content' | base64 -d > "${DEST}/json-rpc-channel.test.ts"

   gh api "repos/NousResearch/hermes-agent/contents/apps/shared/src/json-rpc-gateway-replay.test.ts?ref=${NEW_PIN}" \
     --jq '.content' | base64 -d > "${DEST}/json-rpc-gateway-replay.test.ts"

   gh api "repos/NousResearch/hermes-agent/contents/apps/shared/src/reconnect-backoff.test.ts?ref=${NEW_PIN}" \
     --jq '.content' | base64 -d > "${DEST}/reconnect-backoff.test.ts"

   gh api "repos/NousResearch/hermes-agent/contents/LICENSE?ref=${NEW_PIN}" \
     --jq '.content' | base64 -d > "${DEST}/LICENSE"
   ```

2. Run the snapshot tests to confirm byte-identical copy and capture new hashes:

   ```sh
   bunx vitest run packages/proxy/adapters/hermes/vendor
   ```

   If the hashes changed, update the constants in `snapshot.test.ts` and the
   table in this file with the new sha256 values and new git-blob hashes
   (from `gh api ... --jq '.sha'`).

3. Review `gateway-events.ts` — if upstream added new fields that
   `json-rpc-gateway.ts` or `json-rpc-channel.ts` now reference from
   `./gateway-events.js`, extend the shim accordingly.

4. Update the pin in this file and in `docs/research/hermes-transport-audit-2026-09.md`.
