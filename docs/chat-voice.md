# Use voice

AOS supports microphone transcription and read-aloud synthesis. Speech is served
by the runtime's native interfaces where available, or by an optional
OpenAI-compatible proxy provider configured in the private proxy configuration.
There is no browser speech fallback and no separate voice Agent.

Voice support is implemented for evaluation but still requires live acceptance with an approved, speech-enabled profile or a configured proxy provider. Browser mocks verify orchestration, not provider availability or long-response completeness.

## Configure speech

1. Connect AOS to a runtime by following the relevant runtime guide ([Hermes](runtimes/hermes.md), [OpenClaw](runtimes/openclaw.md), or [OpenCode](runtimes/opencode.md)).
2. For Hermes: configure STT, TTS, or both in the owning native Hermes profile. AOS neither selects providers nor stores their credentials. Hermes makes the final provider selection when speech is requested.
3. For OpenClaw or OpenCode, or to override or supplement Hermes native speech: configure a proxy provider (see [Configure a proxy speech provider](#configure-a-proxy-speech-provider) below).
4. Open a Session. AOS checks non-secret native configuration hints independently for STT and TTS.
5. Use HTTPS or `localhost` and grant microphone permission only when you start recording.

For local development, run the normalized AOS proxy and the Vite dev server:

```bash
# Terminal 1
bun run proxy:serve -- --config /absolute/private/path/proxy.yaml

# Terminal 2
AOS_UI_RUNTIME_MODE=aos \
AOS_UI_PROXY_TARGET=http://127.0.0.1:4100 \
  bun run dev
```

The proxy privately selects and authenticates Hermes; there is no direct
browser Hermes runtime mode.

Selecting a microphone mode does not request permission. The choice is a local view preference, not a Hermes profile setting.

## Configure a proxy speech provider

The proxy can route speech requests to an OpenAI-compatible provider via the
`voice` block in the private proxy configuration. See
[Voice providers](configuration.md#voice-providers) for the full field
reference, `mode` semantics, and key-file rules.

In `"fallback"` mode (default), the provider is used only where the runtime
cannot serve speech natively: always for OpenClaw and OpenCode, and at
request-time for Hermes when its native call fails. In `"override"` mode, the
proxy provider is always used instead of the runtime.

With `"override"`, recordings and read-aloud text are sent only to the configured
provider. With `"fallback"`, they are sent to the runtime first and to the
provider when the runtime fails — even when the runtime advertises native speech.

## Transcribe into the composer

Tap the microphone, speak, then choose **Finish**. AOS appends the final transcript to the existing draft. Review or edit it before using the ordinary Send action. Existing attachments remain attached.

While capture and finalization are active, typing and attachment changes are disabled. **Discard recording** restores the draft from before capture. Silence or failed transcription sends nothing; an eligible failure can be retried from the in-memory recording.

Capture stops at 15 minutes or 5 MiB and always moves to review. When a new recorder chunk would cross the byte limit, AOS transcribes through the last complete safe chunk. A first chunk larger than the cap cannot be uploaded.

AOS requests mono 16 kHz capture with echo cancellation, noise suppression, automatic gain, and a 32 kbps bitrate. Browser constraints are advisory; the byte cap is authoritative.

## Send a voice turn

Hold the microphone for 450 ms, then choose **Voice turn**. With keyboard focus on the microphone, Arrow Down or Shift+F10 opens the same menu; Escape closes it and restores focus.

Voice turn requires:

- an attached, connected, idle Session;
- no pending approval;
- an empty draft, attachment list, and queue; and
- both native STT and TTS.

Record and choose **Send**. AOS transcribes, submits once through the ordinary composer, then arms automatic reading for that exact turn. It reads only the newest completed assistant prose after the submitted user message. Reasoning, tool payloads, and tool-only results are excluded.

A second submission, reconnect, interruption, failure, ambiguous message activity, scope change, authentication loss, or hidden page disarms automatic reading. AOS never retries a possibly accepted chat submission.

## Read a response aloud

Choose the speaker action beside an assistant response. Read-aloud replaces that message's prose while tools, reasoning, attachments, and actions remain inspectable. Stop restores ordinary Markdown and does not stop the Agent.

Pause and Play reuse the generated audio. Successful synthesis is also cached for one hour in browser IndexedDB, so reading the same unchanged message again within that hour does not make another synthesis request. The cache belongs to one browser profile and origin; it is not shared across devices, browsers, developers, or differently hosted AOS instances. Edited projected text gets a new entry, while playback speed does not affect cache identity. Playback speed cycles through 1×, 1.25×, 1.5×, and 2×. Starting another response replaces playback; starting a recording stops it. If autoplay is blocked, choose Play explicitly.

Hermes does not provide word timestamps through this interface, so AOS drives progress from elapsed audio time without synchronized word highlighting. Once audio is ready, its timeline can seek within the already-generated Blob by click/touch or keyboard; zero or missing duration reports 0%, and progress is clamped to 0–100%.

## Privacy and lifecycle

Recordings remain in browser memory. Successfully generated read-aloud audio has an absolute one-hour IndexedDB expiry beginning after synthesis succeeds; reads do not extend it. The app prunes expired entries when the cache initializes and with one full-cache sweep every five minutes while active. Every lookup also validates expiry, so expired audio is never reused when browser suspension or closure delays physical deletion. Browser eviction, private-browsing policy, or clearing site data can remove entries earlier.

Scope changes, authentication loss, or unmounting release microphone tracks, active audio, and temporary object URLs without clearing unexpired cached audio. Ordinary chat messages and the local mode preference also persist. The proxy does not log audio content or transcript text; when it routes a request to a proxy provider it logs one redacted `voice.fallback` event naming the direction and the runtime's public error code.

**Data flow.** With `mode: "override"`, recordings and read-aloud text are sent only to the configured proxy provider. With `mode: "fallback"`, they are sent to the runtime first and to the configured proxy provider when the runtime's native call fails — even when the runtime advertises native speech capability.

Switching browser tabs or windows does not stop active capture; use Finish, Send, or Discard. Hiding the page pauses audio and disarms pending automatic reading.

## Troubleshoot voice

- **Microphone unavailable:** use HTTPS or `localhost`; check device support, browser permission, native login, and profile STT configuration.
- **Voice turn unavailable:** clear the draft, attachments, and queue; wait for an idle attached Session; resolve approvals; confirm both STT and TTS.
- **Read-aloud unavailable:** check native TTS configuration and authentication, or configure a proxy speech provider. Retry explicitly after generation failure or autoplay rejection.
- **Upload rejected (400):** the proxy provider returned `invalid_request` for the audio type or size. Check that the audio format is supported by the configured provider and that the request fits within the provider's size limits.
- **Provider unavailable (503):** the proxy provider returned an error or timed out. Check provider connectivity, `baseUrl`, and `apiKeyFile`. The `timeoutMs` default is 60 seconds; lower values may time out on slow providers.
- **Guest audio rate-limited (503):** guest conversations are budgeted at 2 concurrent in-flight audio operations and 60 audio operations per 10 minutes per conversation, shared across all tabs and devices on the same invitation link. A guest exceeding this budget receives `503`; the limit resets automatically.
- **Redirects refused:** the proxy refuses upstream redirects from the configured `baseUrl`. Point `baseUrl` directly at the serving endpoint.
- **Upload rejected (body size):** The transcription route (`POST /api/aos/v1/agents/:agentId/audio/transcribe`) accepts a 7 500 000-byte JSON body. The speech route (`POST /api/aos/v1/agents/:agentId/audio/speak`) accepts a 40 000-byte body. The 8 MiB Hermes WebSocket frame guard is a separate upstream limit. Check your reverse proxy for a smaller limit on either route.
- **Long response is incomplete:** the current integration uses the provider's complete-audio response rather than streaming or chunking. Test the configured provider's limit before release.

See [Troubleshooting](troubleshooting.md) for authentication, WebSocket, and container issues.

## Complete live acceptance

Use an approved configured profile and disposable Session. Check desktop and mobile capture, editable transcription, repeated voice turns, manual playback, pause/resume/speed, autoplay rejection, scope and visibility changes, and a long-response completeness case.

Record the provider, browser, native version, and outcome without retaining speech or transcript contents. Hands-free mode, durable audio notes, streamed TTS, and word-synchronized highlighting are outside the current feature.
