# Use voice with Hermes

AOS uses Hermes's native speech services for transcription and read-aloud. The
planned OpenClaw lane is unavailable in the current normalized deployment.
There is no browser speech fallback, extra AOS speech server, or separate voice
Agent.

Voice support is implemented for evaluation but still requires live acceptance with an approved, speech-enabled Hermes profile. Browser mocks verify orchestration, not provider availability or long-response completeness.

## Configure speech

1. Connect AOS to Hermes by following [Run with Hermes](runtimes/hermes.md).
2. Configure STT, TTS, or both in the owning native Hermes profile. AOS neither selects providers nor stores their credentials.
3. Open a Session owned by that profile. AOS checks non-secret native configuration hints independently for STT and TTS; Hermes makes the final provider selection when speech is requested.
4. Use HTTPS or `localhost` and grant microphone permission only when you start recording.

For local development, Vite provides the required same-origin forwarding:

```bash
AOS_UI_RUNTIME_MODE=hermes \
AOS_UI_HERMES_BASE_URL=/hermes \
AOS_UI_HERMES_TARGET=http://127.0.0.1:9119 \
  bun run dev
```

Selecting a microphone mode does not request permission. The choice is a local view preference, not a Hermes profile setting.

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

Pause and Play reuse the generated audio. Successful synthesis is also cached for one hour in browser IndexedDB, so reading the same unchanged message again within that hour does not make another Hermes synthesis request. The cache belongs to one browser profile and origin; it is not shared across devices, browsers, developers, or differently hosted AOS instances. Edited projected text gets a new entry, while playback speed does not affect cache identity. Playback speed cycles through 1×, 1.25×, 1.5×, and 2×. Starting another response replaces playback; starting a recording stops it. If autoplay is blocked, choose Play explicitly.

Hermes does not provide word timestamps through this interface, so AOS drives progress from elapsed audio time without synchronized word highlighting. Once audio is ready, its timeline can seek within the already-generated Blob by click/touch or keyboard; zero or missing duration reports 0%, and progress is clamped to 0–100%.

## Privacy and lifecycle

Recordings remain in browser memory. Successfully generated read-aloud audio has an absolute one-hour IndexedDB expiry beginning after synthesis succeeds; reads do not extend it. The app prunes expired entries when the cache initializes and with one full-cache sweep every five minutes while active. Every lookup also validates expiry, so expired audio is never reused when browser suspension or closure delays physical deletion. Browser eviction, private-browsing policy, or clearing site data can remove entries earlier.

Scope changes, authentication loss, or unmounting release microphone tracks, active audio, and temporary object URLs without clearing unexpired cached audio. Ordinary chat messages and the local mode preference also persist. AOS does not log audio or transcript content.

Switching browser tabs or windows does not stop active capture; use Finish, Send, or Discard. Hiding the page pauses audio and disarms pending automatic reading.

## Troubleshoot voice

- **Microphone unavailable:** use HTTPS or `localhost`; check device support, browser permission, native login, and profile STT configuration.
- **Voice turn unavailable:** clear the draft, attachments, and queue; wait for an idle attached Session; resolve approvals; confirm both STT and TTS.
- **Read-aloud unavailable:** check native TTS configuration and authentication. Retry explicitly after generation failure or autoplay rejection.
- **Upload rejected:** AOS permits 8 MiB only on the exact Hermes transcription proxy route, enough for the 5 MiB recording plus JSON/base64 overhead. Check any upstream proxy for a smaller limit.
- **Long response is incomplete:** the current integration uses Hermes's complete-audio response rather than streaming or chunking. Test the configured provider's limit before release.

See [Troubleshooting](troubleshooting.md) for authentication, WebSocket, and container issues.

## Complete live acceptance

Use an approved configured profile and disposable Session. Check desktop and mobile capture, editable transcription, repeated voice turns, manual playback, pause/resume/speed, autoplay rejection, scope and visibility changes, and a long-response completeness case.

Record the provider, browser, native version, and outcome without retaining speech or transcript contents. Hands-free mode, durable audio notes, streamed TTS, and word-synchronized highlighting are outside the current feature.
