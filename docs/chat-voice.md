# Chat voice: setup and use

Voice v1 uses Hermes's native speech services. AOS remains a static frontend;
there is no additional server, speech-provider account integration, browser
speech fallback or separate voice Agent. OpenCode, generic AG-UI and fixture
deployments do not expose voice controls.

Release status: implemented for evaluation, **pending approved-profile live
microphone, transcription and playback acceptance**. Mocked browser tests prove
orchestration, not provider availability or long-response audio completeness.

## Configure Hermes

1. Run the existing Hermes composition and configure native authentication as
   described in the [operator guide](../README.md#hermes).
2. Configure speech-to-text (STT) and/or text-to-speech (TTS) in the owning native
   Hermes profile. AOS does not select a different provider, edit configuration
   or collect provider credentials. A native default is Hermes's decision.
3. Open an existing Session belonging to that profile. AOS reads the non-secret
   `stt` and `tts` toolset configuration metadata independently. These are picker
   hints, not an authoritative voice-readiness API: native speech also supports
   automatic selection and credential pools that the picker checks can miss.
   Valid but negative hints are unverified, not a reason to block an explicit
   speech request. Hermes resolves its configured provider when you use speech.
   Unavailable interfaces/connectivity remain disabled with contextual help.
4. Use HTTPS or `localhost` for recording and allow microphone permission when
   you explicitly start recording. A plain HTTP LAN address is not a secure
   microphone context. Production TLS belongs to the operator's deployment;
   the default Compose stack does not provide it.

For local development, Vite already forwards `/hermes` to the native endpoint:

```bash
AOS_UI_RUNTIME_MODE=hermes \
AOS_UI_HERMES_BASE_URL=/hermes \
AOS_UI_HERMES_TARGET=http://127.0.0.1:9119 \
bun run dev
```

Setup/connectivity guidance belongs to the microphone or speaker tooltip, not
a permanent paragraph under the composer. Recording failures and review notices
appear only after an operation. Changing microphone mode never asks for microphone permission. The selected
mode is a local view preference, not a native profile setting.

## Transcribe a draft

Tap the microphone, speak, then choose **Finish**. The final transcript is
appended to the existing composer draft, where you can edit it before ordinary
Send. Existing attachments remain attached. Typing and attachment changes are
disabled during recording/finalization. **Discard recording** restores the
pre-recording draft.

Recording stops at 15 minutes or 5 MiB. A limit always goes to review, never
Send. If a recorder chunk would cross the byte cap, AOS transcribes the capture
up to its last safe chunk. A first chunk larger than the complete cap cannot be
uploaded; make a shorter recording. Silence and failed transcription send nothing. A failed recording
can be explicitly retried from memory without another microphone capture;
review the resulting transcript before sending.

AOS requests mono, 16 kHz speech capture with echo cancellation, noise
suppression, automatic gain and a 32 kbps recording bitrate so a typical
15-minute Opus capture remains below the byte and proxy-body limits. Browser
constraints are advisory; the 5 MiB cap is therefore authoritative and can end
a recording earlier.

## Send an explicit voice turn

Hold the same microphone for **450 ms**, then choose **Voice turn**. With
keyboard focus on the mic, Arrow Down or Shift+F10 opens the same picker;
Escape dismisses it and restores focus. Releasing a long press does not record.

Voice turn requires an attached, connected, safely idle Session, no pending
approval, an empty draft/attachment list and queue, and both native STT and TTS.
Blocked recording does not prevent opening the mode picker.

Tap to record and choose **Send** when finished. AOS waits for final transcription
and the committed composer text, submits once through ordinary Send, then
arms a one-shot read for that Assistant UI turn. After the run settles, AOS
reads the newest completed assistant prose after the single submitted user
message. Reasoning, tool payloads and tool-only results are never candidates.
Typed and queued messages do not enable automatic reading. Recording never
restarts automatically.

The one-shot ownership rule is runtime-agnostic; Hermes supplies STT/TTS
transport and readiness only. A queued or second user submission, reconnection,
interruption, failed or non-prose completion, ambiguous message activity, scope
change, authentication loss or hidden page disarms automatic reading. If the
turn cannot be identified safely, use the response's speaker action manually.
AOS never retries a possibly accepted chat submission automatically.

## Read an assistant response

Choose the small speaker beside Retry. Assistant UI's ReadAloud appears inside
that assistant message in place of its prose; tools, reasoning, attachments,
branches and message actions remain inspectable. Stop or natural completion
restores ordinary Markdown. Stopping speech does not stop the Agent.

Pause and Play resume the same generated audio without generating it again.
Speed cycles through 1×, 1.25×, 1.5× and 2×. Elapsed time and duration come from
the audio element. Hermes supplies no word timestamps here: `spokenIndex=-1`
means no highlighted words and the upstream word-progress bar stays at 0%.

Starting another response replaces playback; recording stops playback. If the
browser blocks autoplay, choose Play explicitly. Switching tabs or windows does
not stop an active capture; it continues until Finish, Send, Discard or a safety
limit. Hiding the page pauses audio and disarms pending automatic reading.

## Troubleshoot safely

- **Mic unavailable:** check HTTPS/localhost, browser/device support, microphone
  permission, native login and the owning profile's STT configuration.
- **Voice turn unavailable:** clear or send the draft, attachments and queue;
  wait for the Session to attach and become idle; resolve any approval; ensure
  both native speech interfaces are available.
- **Read-aloud unavailable or fails:** check native TTS configuration/login.
  Use Play after autoplay rejection. Generation failures leave the original
  message intact and allow an explicit Read aloud retry.
- **Incomplete long audio:** v1 uses the native complete-audio endpoint and its
  limits. AOS neither truncates the text nor streams/chunks synthesis. Validate
  completeness with the actual configured provider before release.
- **Large-upload rejection:** production Nginx allows an 8 MiB request body only
  on the exact Hermes transcription route, enough for the 5 MiB recording plus
  base64/JSON overhead. Other routes keep their existing limit. An upstream
  proxy can impose a smaller limit; align it only for this route.

Recordings and generated audio exist only in browser memory. Scope changes,
authentication loss and unmount invalidate pending operations and release
microphone tracks, audio and object URLs. Only ordinary chat messages and the
view preference persist. Audio and transcript contents are not logged. Do not
put credentials in public runtime configuration or `VITE_*` variables.

## Live acceptance before release

Use an explicitly approved configured profile and disposable Session; never
modify existing user profiles for a routine test. Check desktop and mobile
permission/capture, editable transcription, repeated explicit voice turns,
manual inline playback, pause/resume/speed, autoplay rejection, scope changes,
visibility changes and a long-response completeness case. Record the provider,
browser, native version and outcome without recording audio/transcript contents.

Hands-free, durable audio notes, streamed TTS and synchronized word highlighting
remain deferred. See the [implementation plan](superpowers/plans/2026-09-08-chat-voice.md)
for the native interfaces, ownership rules and automated verification matrix.
