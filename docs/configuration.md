# Configuration reference

The browser loads `/runtime-config.json` without caching. It has exactly two
runtime modes: `aos` for the normalized same-origin proxy and `fixture` for a
deterministic local preview. Native provider URLs, credentials, directories,
and model identifiers never belong in this public file.

```json
{
  "mode": "aos",
  "composerModelSelectorEnabled": true,
  "composerContextEnabled": true
}
```

Unknown fields are rejected.

### Artifact HTML assets {#artifact-html-assets}

Optional `artifactHtmlAssetOrigins` is an array of at most 16
credential-free HTTPS origins allowed as external asset sources inside
published HTML Artifacts. Omit it to block external HTML preview assets.

## Local development

Vite derives the same public shape when no configuration file is supplied.

| Variable                                 | Default                 | Use                                                                                                                          |
| ---------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `AOS_UI_RUNTIME_CONFIG_FILE`             | unset                   | Public runtime JSON file. Also read by the Bun proxy and static server at startup; required in every non-fixture deployment. |
| `AOS_UI_RUNTIME_MODE`                    | `aos`                   | `aos` or explicit `fixture`.                                                                                                 |
| `AOS_UI_PROXY_TARGET`                    | `http://127.0.0.1:4100` | Local normalized proxy target.                                                                                               |
| `AOS_UI_COMPOSER_MODEL_SELECTOR_ENABLED` | `true`                  | Set `false` to hide model selection.                                                                                         |
| `AOS_UI_COMPOSER_CONTEXT_ENABLED`        | `true`                  | Set `false` to hide context usage.                                                                                           |

The AOS proxy privately selects and authenticates exactly one Hermes, OpenClaw,
or OpenCode runtime. Hermes is the primary and first-supported harness. There
is no browser runtime mode or provider route for any of them.

### Compose host variables

These variables control how the Compose stack publishes its listeners on the
host. They are not read by the Vite dev server.

| Variable                      | Default     | Use                                                 |
| ----------------------------- | ----------- | --------------------------------------------------- |
| `AOS_UI_BIND_ADDRESS`         | `127.0.0.1` | Host bind address for the operator listener.        |
| `AOS_UI_WEB_PUBLISHED_PORT`   | `3000`      | Host-side published port for the operator listener. |
| `AOS_UI_GUEST_BIND_ADDRESS`   | `127.0.0.1` | Host bind address for the guest listener.           |
| `AOS_UI_GUEST_PUBLISHED_PORT` | `3001`      | Host-side published port for the guest listener.    |

## Private proxy configuration

The Bun proxy reads a private YAML configuration file. JSON is valid YAML and
still parses, so an existing `.json` file continues to work without
renaming. Start from the maintained example for the selected provider:
[`Hermes`](../deploy/proxy.hermes.example.yaml),
[`OpenClaw`](../deploy/proxy.openclaw.example.yaml), or
[`OpenCode`](../deploy/proxy.opencode.example.yaml).

**Resolution order.** The path is resolved as: `--config` flag, then
`AOS_UI_PROXY_CONFIG_FILE`, then the discovery path
`${XDG_CONFIG_HOME:-$HOME/.config}/aos-ui/proxy.yaml`. The `invite`
subcommand never discovers a default path; it requires `--config` or
`AOS_UI_PROXY_CONFIG_FILE`. A discovered path that does not exist is treated
as an empty document, so a deployment configured entirely through environment
overrides is valid. An explicitly supplied path that does not exist is an error.

**File checks.** Before parsing, the loader checks that the path is a regular
file (not a directory, device, or socket), is not group- or world-writable,
and is owned by the current process user or by root. Symlinks are followed.
Files larger than 1 MiB are rejected. These checks exist because the file
specifies listener addresses and can therefore widen the unauthenticated
operator surface. Compose bind-mounts preserve host ownership, so the file
must be owned by `AOS_UI_HOST_UID` (or by root) and must not be mode `0664`
or wider.

**YAML hardening.** The file must contain exactly one YAML document. Anchors
and aliases are not allowed. The keys `__proto__`, `constructor`, and
`prototype` are not allowed anywhere in the document. Any parser warning fails
the load.

| Field             | Meaning                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`         | Configuration format; V1 accepts only `1`.                                                                                                    |
| `deploymentId`    | Stable identifier bound into guest invitations.                                                                                               |
| `listen`          | Trusted operator listener. `host` must be `127.0.0.1`, `::1`, `0.0.0.0`, or `::`. Wildcard binds require `exposure: "private-container"`.     |
| `publicOrigin`    | Exact browser origin accepted for state-changing operator requests. Must be `https:` unless the host is `127.0.0.1`, `[::1]`, or `localhost`. |
| `runtime`         | One selected runtime: a stable ID plus the provider-specific private connection fields below.                                                 |
| `limits`          | Global execution, guest execution, event-peer, and subscriber queue bounds.                                                                   |
| `voice`           | Optional proxy speech provider for transcription and/or read-aloud (see [Voice providers](#voice-providers) below).                           |
| `guest`           | Optional distinct guest listener/origin and invitation signing keys (see below).                                                              |
| `shutdownGraceMs` | Whole shutdown budget after SIGTERM: drain, close the runtime, exit non-zero if forced.                                                       |

V1 selects one of the supported adapter kinds per deployment; unknown kinds are
rejected. Operator and guest listeners use the exact same runtime instance,
credentials, transport, and Session coordinator. There is no second guest
runtime or credential.

| `runtime.kind` | Required private fields                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `hermes`       | `baseUrl`, absolute owner-only `tokenFile`, and `sessionIdleMs` (1 000–86 400 000 ms)                    |
| `openclaw`     | WebSocket `baseUrl`, absolute owner-only `deviceIdentityFile`, and absolute owner-only `deviceTokenFile` |
| `opencode`     | `baseUrl`, absolute `directory`, `username`, and absolute owner-only `passwordFile`                      |

`runtime.sessionIdleMs` (Hermes only) controls how long the proxy keeps a Session attachment warm after
the last subscriber disconnects before closing only that Session. The shared
Hermes socket remains open.

When `guest` is configured, its `invitations` block accepts:

| Field              | Default  | Meaning                                                       |
| ------------------ | -------- | ------------------------------------------------------------- |
| `keys`             | required | Array of up to 3 `{id, secretFile}` objects for key rotation. |
| `ttlSeconds`       | `259200` | Invitation lifetime in seconds (60–2 592 000).                |
| `clockSkewSeconds` | `0`      | Accepted clock skew when validating tokens (0–60 s).          |

The operator listener intentionally has no application authentication. Network
access grants full operator access. Keep it on loopback or a trusted private
network, or put it behind an authenticated ingress. If `guest` is configured,
its listener and public origin must differ from the operator lane; guest access
requires a scoped, expiring JWT.

Every provider secret file (`runtime.tokenFile`, `runtime.passwordFile`, or
`runtime.deviceIdentityFile`/`runtime.deviceTokenFile` as applicable) and every
`guest.invitations.keys[].secretFile` must be absolute paths to regular,
non-symlinked, owner-only files with no group or other read bits, and between 1
and 8192 bytes. Guest invitation signing-key files must contain exactly 43
characters of base64url encoding a 32-byte value. Secret values never belong
directly in the YAML file, Compose environment, `VITE_*`, public runtime
configuration, or browser bundle. Unknown and legacy OIDC, operator-cookie,
Hermes browser-broker, and guest-Hermes fields are rejected.

For Compose runtime overlays, `AOS_UI_HOST_UID` and `AOS_UI_HOST_GID` select
the non-root proxy identity and the declared secret ownership. On Linux, use
the numeric owner of the source secret files because local Compose mounts them
without changing their host ownership.

The Bun proxy serves the built browser assets, `/runtime-config.json`, the
operator API, and—when configured—the separate guest surface. See
[Deployment](deployment.md) for Compose mounts and listener exposure.

### Built-in defaults {#built-in-defaults}

The loader starts from these defaults before merging the file and any
environment overrides. `deploymentId`, `publicOrigin`, and `runtime` have no
default; a minimal local file contains only those three fields.

| Field                                | Default     |
| ------------------------------------ | ----------- |
| `version`                            | `1`         |
| `listen.host`                        | `127.0.0.1` |
| `listen.port`                        | `4100`      |
| `limits.activeExecutions`            | `256`       |
| `limits.guestActiveExecutions`       | `32`        |
| `limits.operatorEventPeers`          | `256`       |
| `limits.subscriberEvents`            | `512`       |
| `limits.subscriberBytes`             | `2097152`   |
| `shutdownGraceMs`                    | `5000`      |
| `runtime.sessionIdleMs` (Hermes)     | `300000`    |
| `guest.invitations.ttlSeconds`       | `259200`    |
| `guest.invitations.clockSkewSeconds` | `0`         |
| `voice.*.mode`                       | `fallback`  |
| `voice.*.timeoutMs`                  | `60000`     |
| `voice.speech.format`                | `mp3`       |

### Environment overrides {#environment-overrides}

Every scalar field in the schema can be set or overridden by an environment
variable prefixed `AOS_UI_PROXY_`. Values are trimmed; an empty string after
trimming means the variable is not set. Integer fields must be whole numbers.
`AOS_UI_PROXY_RUNTIME_KIND` is read first and determines which runtime-specific
rows apply; using a runtime-specific variable with the wrong kind is an error.
A variable whose `Applies` is "only when file has `guest` block" fails if the
file contains no `guest` key, because env overrides cannot open a second
listener on their own. Push and voice variables create their respective blocks
when the file omits them. Arrays (`guest.invitations.keys`) are file-only; env
cannot remove a key already present in the file. The variables
`AOS_UI_PROXY_TARGET`, `AOS_UI_PROXY_HOST`, `AOS_UI_PROXY_PORT`, and
`AOS_UI_PROXY_CONFIG_FILE` are not overrides; they belong to other features.

To widen the listener from loopback to `0.0.0.0` using only environment
variables, set both `AOS_UI_PROXY_LISTEN_HOST=0.0.0.0` and
`AOS_UI_PROXY_LISTEN_EXPOSURE=private-container`; setting the host alone fails
schema validation.

| Variable                                            | Field                                | Type   | Applies                          |
| --------------------------------------------------- | ------------------------------------ | ------ | -------------------------------- |
| `AOS_UI_PROXY_DEPLOYMENT_ID`                        | `deploymentId`                       | string | always                           |
| `AOS_UI_PROXY_PUBLIC_ORIGIN`                        | `publicOrigin`                       | string | always                           |
| `AOS_UI_PROXY_LISTEN_HOST`                          | `listen.host`                        | string | always                           |
| `AOS_UI_PROXY_LISTEN_PORT`                          | `listen.port`                        | int    | always                           |
| `AOS_UI_PROXY_LISTEN_EXPOSURE`                      | `listen.exposure`                    | string | always                           |
| `AOS_UI_PROXY_RUNTIME_ID`                           | `runtime.id`                         | string | always                           |
| `AOS_UI_PROXY_RUNTIME_KIND`                         | `runtime.kind`                       | string | always                           |
| `AOS_UI_PROXY_RUNTIME_BASE_URL`                     | `runtime.baseUrl`                    | string | always                           |
| `AOS_UI_PROXY_RUNTIME_TOKEN_FILE`                   | `runtime.tokenFile`                  | string | hermes only                      |
| `AOS_UI_PROXY_RUNTIME_SESSION_IDLE_MS`              | `runtime.sessionIdleMs`              | int    | hermes only                      |
| `AOS_UI_PROXY_RUNTIME_DIRECTORY`                    | `runtime.directory`                  | string | opencode only                    |
| `AOS_UI_PROXY_RUNTIME_USERNAME`                     | `runtime.username`                   | string | opencode only                    |
| `AOS_UI_PROXY_RUNTIME_PASSWORD_FILE`                | `runtime.passwordFile`               | string | opencode only                    |
| `AOS_UI_PROXY_RUNTIME_DEVICE_IDENTITY_FILE`         | `runtime.deviceIdentityFile`         | string | openclaw only                    |
| `AOS_UI_PROXY_RUNTIME_DEVICE_TOKEN_FILE`            | `runtime.deviceTokenFile`            | string | openclaw only                    |
| `AOS_UI_PROXY_LIMITS_ACTIVE_EXECUTIONS`             | `limits.activeExecutions`            | int    | always                           |
| `AOS_UI_PROXY_LIMITS_GUEST_ACTIVE_EXECUTIONS`       | `limits.guestActiveExecutions`       | int    | always                           |
| `AOS_UI_PROXY_LIMITS_OPERATOR_EVENT_PEERS`          | `limits.operatorEventPeers`          | int    | always                           |
| `AOS_UI_PROXY_LIMITS_SUBSCRIBER_EVENTS`             | `limits.subscriberEvents`            | int    | always                           |
| `AOS_UI_PROXY_LIMITS_SUBSCRIBER_BYTES`              | `limits.subscriberBytes`             | int    | always                           |
| `AOS_UI_PROXY_GUEST_LISTEN_HOST`                    | `guest.listen.host`                  | string | only when file has `guest` block |
| `AOS_UI_PROXY_GUEST_LISTEN_PORT`                    | `guest.listen.port`                  | int    | only when file has `guest` block |
| `AOS_UI_PROXY_GUEST_LISTEN_EXPOSURE`                | `guest.listen.exposure`              | string | only when file has `guest` block |
| `AOS_UI_PROXY_GUEST_PUBLIC_ORIGIN`                  | `guest.publicOrigin`                 | string | only when file has `guest` block |
| `AOS_UI_PROXY_GUEST_INVITATIONS_TTL_SECONDS`        | `guest.invitations.ttlSeconds`       | int    | only when file has `guest` block |
| `AOS_UI_PROXY_GUEST_INVITATIONS_CLOCK_SKEW_SECONDS` | `guest.invitations.clockSkewSeconds` | int    | only when file has `guest` block |
| `AOS_UI_PROXY_PUSH_STATE_DIR`                       | `push.stateDir`                      | string | may create `push` block          |
| `AOS_UI_PROXY_PUSH_VAPID_SUBJECT`                   | `push.vapid.subject`                 | string | may create `push` block          |
| `AOS_UI_PROXY_PUSH_VAPID_PRIVATE_KEY_FILE`          | `push.vapid.privateKeyFile`          | string | may create `push` block          |
| `AOS_UI_PROXY_VOICE_TRANSCRIPTION_PROVIDER`         | `voice.transcription.provider`       | string | may create `voice` block         |
| `AOS_UI_PROXY_VOICE_TRANSCRIPTION_BASE_URL`         | `voice.transcription.baseUrl`        | string | may create `voice` block         |
| `AOS_UI_PROXY_VOICE_TRANSCRIPTION_API_KEY_FILE`     | `voice.transcription.apiKeyFile`     | string | may create `voice` block         |
| `AOS_UI_PROXY_VOICE_TRANSCRIPTION_MODEL`            | `voice.transcription.model`          | string | may create `voice` block         |
| `AOS_UI_PROXY_VOICE_TRANSCRIPTION_MODE`             | `voice.transcription.mode`           | string | may create `voice` block         |
| `AOS_UI_PROXY_VOICE_TRANSCRIPTION_TIMEOUT_MS`       | `voice.transcription.timeoutMs`      | int    | may create `voice` block         |
| `AOS_UI_PROXY_VOICE_TRANSCRIPTION_LANGUAGE`         | `voice.transcription.language`       | string | may create `voice` block         |
| `AOS_UI_PROXY_VOICE_SPEECH_PROVIDER`                | `voice.speech.provider`              | string | may create `voice` block         |
| `AOS_UI_PROXY_VOICE_SPEECH_BASE_URL`                | `voice.speech.baseUrl`               | string | may create `voice` block         |
| `AOS_UI_PROXY_VOICE_SPEECH_API_KEY_FILE`            | `voice.speech.apiKeyFile`            | string | may create `voice` block         |
| `AOS_UI_PROXY_VOICE_SPEECH_MODEL`                   | `voice.speech.model`                 | string | may create `voice` block         |
| `AOS_UI_PROXY_VOICE_SPEECH_MODE`                    | `voice.speech.mode`                  | string | may create `voice` block         |
| `AOS_UI_PROXY_VOICE_SPEECH_TIMEOUT_MS`              | `voice.speech.timeoutMs`             | int    | may create `voice` block         |
| `AOS_UI_PROXY_VOICE_SPEECH_VOICE`                   | `voice.speech.voice`                 | string | may create `voice` block         |
| `AOS_UI_PROXY_VOICE_SPEECH_FORMAT`                  | `voice.speech.format`                | string | may create `voice` block         |
| `AOS_UI_PROXY_SHUTDOWN_GRACE_MS`                    | `shutdownGraceMs`                    | int    | always                           |

### Errors {#config-errors}

When the configuration is invalid, the proxy logs a structured start-failure
event with name `ProxyConfigurationError`. The startup log entry
(`proxy.start_failed`) is the readable form; `redactForLog`'s every-error-is-opaque
rule applies to all other errors. The message begins with
`Invalid proxy configuration in <path>:` followed by one indented line per
field:

```
Invalid proxy configuration in /etc/aos-ui/proxy.yaml:
  runtime.tokenFile: Invalid input: expected string, received undefined
  limits: 1 unrecognized key
```

Field paths are reported; values are never included. Unrecognized keys are
reported as a count, not by name. When a variable set the failing field, its
name appears in parentheses after the message. File-check failures (not a
regular file, group- or world-writable, owned by another user, too large) name
the path and the constraint that failed.

Runtime slash-command suggestions are enabled on the operator surface. The
guest surface hides them by default; set
`AOS_UI_COMPOSER_SLASH_COMMANDS_ENABLED=true` on the proxy to show them there.
This flag is forwarded only by `compose.hermes.yaml`; other runtime overlays
do not pass it. This flag changes presentation only. A guest submission is
still routed by the runtime according to the invitation's existing message
permissions.

### Voice providers {#voice-providers}

Add a `voice` block to route transcription (`POST {baseUrl}/audio/transcriptions`)
and/or read-aloud synthesis (`POST {baseUrl}/audio/speech`) through an
OpenAI-compatible speech provider. Omitting the block leaves only the runtime's
native speech interfaces active. The block must contain at least one of
`transcription` or `speech`; the example proxy configs intentionally omit it.

```yaml
voice:
  transcription:
    provider: openai-compatible
    baseUrl: https://stt.example.test/v1
    apiKeyFile: /run/secrets/voice-stt-key
    model: whisper-1
    mode: fallback
    language: he
    timeoutMs: 60000
  speech:
    provider: openai-compatible
    baseUrl: https://tts.example.test/v1
    apiKeyFile: /run/secrets/voice-tts-key
    model: tts-1
    voice: alloy
    format: mp3
    mode: override
    timeoutMs: 60000
```

Each direction (`transcription`, `speech`) accepts:

| Field        | Default    | Meaning                                                                                                                                                                                                                             |
| ------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`   | required   | Must be `"openai-compatible"`.                                                                                                                                                                                                      |
| `baseUrl`    | required   | Base URL including the API version segment (e.g. `/v1`). Must be `https:` or a loopback host when `apiKeyFile` is set. Upstream redirects are refused.                                                                              |
| `apiKeyFile` | —          | Optional absolute path to an owner-only secret file carrying the API key. Same ownership rules as `runtime.tokenFile`. The key is never inline, never an environment value, and is unrelated to `AOS_UI_OPENAI_COMPATIBLE_API_KEY`. |
| `model`      | required   | Model identifier forwarded to the provider.                                                                                                                                                                                         |
| `mode`       | `fallback` | `"fallback"` or `"override"` (see below).                                                                                                                                                                                           |
| `timeoutMs`  | `60000`    | Per-request timeout in milliseconds (1 000–300 000).                                                                                                                                                                                |

`transcription` additionally accepts:

| Field      | Default | Meaning                                                  |
| ---------- | ------- | -------------------------------------------------------- |
| `language` | —       | Optional BCP-47-like language hint (e.g. `he`, `en-US`). |

`speech` additionally accepts:

| Field    | Default | Meaning                                        |
| -------- | ------- | ---------------------------------------------- |
| `voice`  | —       | Voice identifier forwarded to the provider.    |
| `format` | `mp3`   | Audio format: `mp3`, `opus`, `wav`, or `flac`. |

#### Mode semantics

`"fallback"` uses the proxy provider only where the runtime cannot serve speech:
at the capability level when the runtime reports speech unavailable (OpenClaw,
OpenCode), and at request time when the runtime's native call fails. On Hermes,
which advertises speech availability per transport, fallback is request-time
only: the native call is attempted first, and the proxy provider is used only
if that call fails.

`"override"` always uses the proxy provider, regardless of runtime capability.

Provider failures surface as `503 temporarily_unavailable`. An unsupported audio
type or oversized request surfaces as `400 invalid_request`. The proxy never logs
audio content or transcript text; it logs one redacted `voice.fallback` event
per direction naming the direction and the runtime's public error code.

### Web Push (optional)

Add a `push` block to enable closed-app OS notifications via Web Push. Omitting
the block leaves tab-only delivery active; no other behavior changes.

```yaml
push:
  stateDir: /var/lib/aos-ui/push
  vapid:
    subject: mailto:ops@example.com
    privateKeyFile: /run/secrets/vapid-private-key
```

`stateDir` must exist and be writable by the proxy user before the proxy starts.
It holds one JSON file of device registrations (push endpoints and their keys;
no conversation content), up to 32 per operator. The proxy refuses to start if
the directory is missing or unwritable — there is no silent fallback.

Generate a VAPID key pair once:

```bash
bunx web-push generate-vapid-keys
```

Keep only the private key (a 43-character base64url scalar). Write it to a
file, set its permissions to `0600`, and pass the path as `privateKeyFile`. The
public key is derived at proxy startup; do not configure it separately.

For Compose deployments, `compose.push.yaml` passes push settings to the proxy
as container environment variables; the private configuration file needs no
`push` block. Add `-f compose.push.yaml` after the runtime overlay and set
`AOS_UI_PUSH_STATE_DIR`, `AOS_UI_VAPID_PRIVATE_KEY_FILE`, and
`AOS_UI_PUSH_VAPID_SUBJECT` (see
[Deployment](deployment.md#web-push-state-and-vapid-secret)). Omitting the
overlay leaves tab-only delivery active with no additional variables required.
