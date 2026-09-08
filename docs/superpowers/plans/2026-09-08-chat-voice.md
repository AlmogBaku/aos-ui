# Chat voice v1: native runtime support, Assistant UI reuse

Approved scope: Hermes-native transcription, explicit voice turns and inline
read-aloud. This replaces earlier discussion drafts using a top player, browser
speech fallback, hands-free capture or timestamp/highlighting work. No earlier
voice-plan file was present in this checkout; this is the repository record of
the final approved plan.

### Correction from live UI review (2026-09-08)

The user reported working Hermes Desktop speech while AOS falsely displayed
"Configure speech-to-text". Native source at `b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b`
confirms that `/api/tools/toolsets/{name}/config` is a picker matrix, not the
effective speech resolver. Picker key checks use environment fields, while native
speech also resolves credential pools, inline provider settings and automatic
selection. Therefore negative picker hints are **unverified**, not proof of
unconfigured speech. They do not block an explicit request; Hermes still chooses
the provider, with no frontend fallback. Unavailable/malformed interfaces remain
disabled. Setup guidance moves to contextual mic/speaker help; only actual
operation failures/review notices appear under the composer. This supersedes the
draft's hard gate based on negative picker metadata.

## Product contract

- One microphone on desktop/mobile: tap records; 450 ms long press opens the
  Transcription / Voice turn picker. Arrow Down and Shift+F10 also open it;
  Escape dismisses and restores focus. Long-press release must not record.
- Default to Transcription, remembering only the local view preference.
  Mode changes do not request microphone permission.
- Reuse upstream ComposerVoice recording/transcribing presentation, 14-bar
  geometry, existing buttons and EN/HE labels. Drive those bars from the
  approved mic-correlated activity amendment rather than its decorative sine.
- Transcription Finish commits one editable transcript while preserving the
  existing draft and attachments. Discard restores the original draft.
- Voice-turn Send waits for both adapter finalization and committed composer
  text, then uses ordinary Send once. Requires a connected attached idle
  Session, empty draft/attachments/queue, no approval, and both STT and TTS.
- ActionBarPrimitive.Speak / StopSpeaking control the owning message. Upstream
  ReadAloud replaces only prose, preserving message identity and non-prose
  content. It always receives `spokenIndex={-1}`: no highlights; progress 0%.
  Actual elapsed/duration, real pause/resume and 1/1.25/1.5/2× playback are separate.

## Architecture and interfaces

`WorkspaceAdapter` and shared `RuntimeBundle` stay unchanged. The concrete
Hermes bundle adds a focused media controller/context; the existing runtime hook
supplies exported DictationAdapter and SpeechSynthesisAdapter implementations.
Assistant UI continues owning composer text, threads, messages, queues, branches
and speech-message association. Packages remain pinned and unpatched.

Selective upstream Elements are recorded in
[`voice/UPSTREAM.md`](../../../src/components/assistant-ui/voice/UPSTREAM.md).
The customized thread is extended, not regenerated; no simulated mock runtime
is imported into the app.

Provider-specific operations live in the Hermes adapter:

| Native interface                               | Use                                                    |
| ---------------------------------------------- | ------------------------------------------------------ |
| `GET /api/tools/toolsets/stt/config?profile=…` | Non-secret STT readiness                               |
| `GET /api/tools/toolsets/tts/config?profile=…` | Non-secret TTS readiness                               |
| `POST /api/audio/transcribe?profile=…`         | `{data_url, mime_type}` using the actual recorded MIME |
| `POST /api/audio/speak?profile=…`              | `{text}` returning complete generated audio            |

Capture immutable profile/Session identifiers, preserve native credentials,
base URL and authentication, validate responses and sanitize errors. Never call
`/api/audio/voice-config`, expose credentials, choose a fallback speech provider,
or add an AOS server. Unsupported runtime integrations omit voice; unavailable
native interfaces display a disabled action and contextual explanation independently.
Configuration hints are advisory as corrected above.

### Approved mic-correlated activity amendment (2026-09-08)

The upstream ComposerVoice bars are decorative: they derive height from bar
index and elapsed whole seconds, while DictationAdapter exposes no volume
signal. Keep the upstream 14-bar geometry and surrounding recording UI, but
replace the synthetic sine heights with a recent loudness history from the
same `MediaStream` already owned by `VoiceCapture`.

Implement a focused, dependency-free Web Audio meter. Attach
`MediaStreamAudioSourceNode -> AnalyserNode` without connecting a destination;
sample time-domain PCM, calculate DC-adjusted RMS, map it through a bounded
noise floor, and apply fast attack/slower release smoothing. Publish exactly
14 normalized samples at a throttled UI cadence through a dedicated external
store so the rest of the voice controller does not rerender at animation rate.
The recorder remains the only stream/track owner; meter disposal cancels its
frame, disconnects nodes and closes its AudioContext but never stops tracks.
Meter failure leaves recording functional with minimum-height bars. Reduced
motion removes transitions and lowers the publication cadence. Values stay
transient, aria-hidden, unlogged and unsent.

### Runtime-agnostic PTT auto-read correction (2026-09-09)

PTT reply ownership belongs to Assistant UI, not a provider protocol. When the
PTT completion action sends, record a one-shot latch containing the selected
thread scope and the IDs of messages already present. Observe the owning
Assistant UI thread state. The latch owns exactly one newly added user turn;
after its run is idle, select the newest newly added completed assistant message
containing text that follows that user turn, then invoke that exact message's
existing Speak action. Assistant activity before the user turn is not its reply.
Tool-only messages, reasoning and tool payloads are not speech candidates.
Ordinary sends never arm the latch.

Clear the latch after resolution, a thread/scope change, hiding the page,
recording again, interruption, authentication loss, unmount, a queued or second
user submission, or a settled failed/non-prose result. This coordination is
runtime-agnostic and requires only Assistant UI dictation/speech capabilities.
There are no Hermes event-sequence, history-row or native completion observers
in PTT; Hermes remains responsible only for its STT/TTS transport and capability
readiness.

Implementation sequence:

1. Add failing pure signal/store tests for silence, amplitude, smoothing,
   bounds, 14-sample history, throttling and idempotent cleanup.
2. Add failing capture integration tests proving one `getUserMedia` call, the
   identical stream reaches recorder and meter, visualization failure is
   contained, and every terminal capture path disposes the meter once.
3. Implement the isolated meter and wire it through `VoiceCapture` without
   changing Assistant UI adapters or Hermes transport.
4. Add failing ComposerVoice tests proving supplied microphone levels—not
   elapsed seconds—control heights in LTR and Hebrew RTL, then connect the
   dedicated meter subscription only to the recording presentation.
5. Update upstream attribution and operator documentation, run focused tests,
   and repeat the full verification and live-browser checks below.

Speech text is a deterministic Markdown AST projection of Assistant UI's prose
parts: preserve prose/list text and link labels, give localized code/table cues,
exclude reasoning/tool payloads. Saved messages are unchanged. Native
complete-audio synthesis is used without frontend streaming, chunking or text
truncation; native long-response completeness remains a live acceptance gate.

## Assistant UI turn ownership

Arm the observer only around an explicit finalized voice submission. Store the
owning thread scope and its baseline message IDs, then use Assistant UI's
messages, run state and composer queue as the authority. Require exactly one new
user message and a settled completed assistant prose message after it before
issuing one exact message-ID read command. Never match prompt/response text or
perform a global latest-message lookup.

Queued or superseding submissions, reconnects, duplicate/ambiguous activity,
interruption, approval, failure, tool-only completion and loss of scope disarm.
A terminal assistant result without prose also disarms even when a fast run's
`isRunning=true` edge was not rendered. Pending UI read commands expire if their
message never settles. Manual read-aloud remains available, and loading history
by itself never starts playback.

## Safety and lifecycle

- Capture at most 15 minutes / 5 MiB and request a speech-oriented 32 kbps
  encoder bitrate; a limit stops into review, never Send. The byte cap remains
  authoritative when a browser does not honor the requested bitrate.
  Empty, failed, discarded or stale transcripts send nothing. Explicit retry
  uses retained in-memory audio; never automatically retry chat submission.
- One HTMLAudioElement. Starting another read replaces it; starting capture
  stops speech. Natural completion never starts the microphone.
- Scope/authentication/unmount invalidates pending requests and releases tracks,
  audio and object URLs. Hidden page: keep active capture running until an
  explicit completion action or safety limit, pause playback and disarm
  automatic reading. Autoplay rejection leaves explicit Play available.
- Audio/transcripts are not logged or persisted as recordings. Ordinary sent
  chat text and view preferences retain their normal persistence behavior.
- Only the exact Hermes transcription Nginx route receives an 8 MiB body limit;
  authentication, native forwarding and adjacent limits stay intact.
- EN/HE, RTL, keyboard focus, touch targets and reduced motion are required.

## Testable delivery slices

1. **Native transcription:** validated audio client, independent metadata,
   MediaRecorder adapter, draft/cancel/finalization/retry controls, native
   ComposerVoice, mic gesture and localized readiness. Verify limits and proxy.
2. **Manual read-aloud:** deterministic projection, complete-audio adapter,
   in-message upstream ReadAloud, pause/resume/rate/time, blocked autoplay and
   cleanup. Verify tools, reasoning, actions and prose restoration.
3. **Voice-turn coordination:** safe-idle gate, committed-text barrier,
   ordinary submission, runtime-agnostic Assistant UI turn observer, exact
   completed prose reply ID, disarming adverse events and duplicate prevention.
   Preserve queues/approvals.

## Verification and release gate

Focused suites cover native payload validation and metadata; mic tap/hold and
keyboard gestures; real Assistant UI composer and speech association; capture
limits/silence/permission/retry/staleness; pause/rate/time/autoplay/resource
cleanup; runtime-agnostic turn ownership, queue/supersession and unsafe paths;
and browser desktop/mobile Hebrew/RTL orchestration with fake media endpoints.

Run before handoff:

```bash
bun run test
bun run typecheck
bun run lint
bun run build
bun run test:e2e
bunx vitest run test/containers/compose.test.ts
docker compose -f compose.yaml config --quiet
docker compose -f compose.yaml -f compose.opencode.yaml config --quiet
docker compose -f compose.yaml -f compose.hermes.yaml config --quiet
```

Build the affected static web image and run
`AOS_UI_AUDIO_SMOKE_IMAGE=<image-tag> bun run test/containers/hermes-audio-proxy-smoke.ts`
for the disposable proxy smoke. Verify a real 5 MiB blob/base64 upload through Nginx,
oversized rejection, unchanged adjacent-route limits, cookies/auth/header
forwarding, health and streaming. The mock upstream is not a speech provider.

Implementation/verification is in progress. **Release remains gated** on live
microphone/STT/TTS acceptance with an approved configured profile, repeated
explicit voice turns and long-response completeness. No synthetic fixture or
skipped journey can satisfy that gate.

Deferred: hands-free, durable audio notes, streamed TTS and synchronized word
highlighting.
