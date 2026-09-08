# Browser recording quality for speech transcription

Research date: 2026-09-09

## Recommendation

For Chat voice v1, request **one channel** and prefer **WebM/Opus at 32
kbps**. Keep `sampleRate: { ideal: 16_000 }` only as a browser hint, not a
requirement. Preserve the browser-produced recording and MIME type; do not add
a client-side decode/resample/re-encode pipeline.

Keep the **5 MiB hard cap** and use a **15-minute product ceiling**. A 32 kbps
elementary stream is about 3.6 MB (3.43 MiB) over 15 minutes, leaving about
1.57 MiB for container overhead and browser bitrate overshoot. Because browser
constraints and bitrate targets are not guarantees, the byte cap remains
authoritative and may still stop recording earlier.

**24 kbps Opus is too aggressive as the default without a representative
accuracy evaluation.** It is likely usable for clean close-mic speech, but
neither ElevenLabs nor OpenAI publishes a Scribe/Whisper accuracy benchmark or
input recommendation at that bitrate. Moving to 32 kbps avoids an unnecessary,
irreversible quality cut; shortening the ceiling to 15 minutes preserves
meaningful size headroom.

If 32 kbps proves too variable across browsers, shorten the nominal duration
before lowering the bitrate. Transcription quality should take priority over
maximizing recording duration inside 5 MiB.

## Documented facts

### ElevenLabs Scribe

- The batch transcription endpoint accepts all major audio/video formats. The
  documented MIME list includes Opus, Ogg, WebM, MP3, AAC, WAV, FLAC and M4A.
  The current overview says 3 GB and 10 hours for standard mode; the API
  reference separately says the uploaded file must be under 5 GB. This
  documentation discrepancy does not affect AOS's much smaller 5 MiB cap.
  [ElevenLabs STT overview](https://elevenlabs.io/docs/overview/capabilities/speech-to-text/),
  [ElevenLabs create-transcript API](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)
- ElevenLabs defines a special `pcm_s16le_16` input as 16-bit, 16 kHz,
  little-endian, single-channel PCM and says it lowers latency versus an
  encoded waveform. It does **not** claim that this format improves accuracy,
  and uncompressed PCM cannot fit a 15-minute recording inside 5 MiB.
  [ElevenLabs create-transcript API](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)
- ElevenLabs publishes no Scribe input bitrate recommendation and no word-error
  measurements comparing 24 and 32 kbps Opus. Its audio-format page lists
  48 kHz Opus at 32, 64, 96, 128 and 192 kbps for **TTS output**. The 32 kbps
  floor is useful context, but it is not an STT input guarantee.
  [ElevenLabs supported audio formats](https://elevenlabs.io/docs/help-center/troubleshooting/what-audio-formats-do-you-support)

### OpenAI transcription and Whisper

- OpenAI's current file-transcription guide recommends `gpt-transcribe` for
  bounded recorded speech, limits files to 25 MB, and lists MP3, MP4, MPEG,
  MPGA, M4A, WAV and WebM inputs. The API reference additionally lists FLAC and
  Ogg. Neither page specifies a minimum sample rate, channel count or bitrate.
  [OpenAI file transcription](https://developers.openai.com/api/docs/guides/speech-to-text),
  [OpenAI transcription API](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)
- The original Whisper pipeline resamples decoded audio to 16 kHz, downmixes it
  to mono, and creates log-Mel features. This is documented in both the paper
  and OpenAI's released loader. Therefore, 16 kHz mono is aligned with
  Whisper's internal representation; it does not establish that lossy 24 kbps
  capture preserves all useful speech information.
  [Whisper paper](https://cdn.openai.com/papers/whisper.pdf),
  [OpenAI Whisper audio loader](https://github.com/openai/whisper/blob/main/whisper/audio.py)
- OpenAI characterizes Whisper as robust to varied accents, background noise
  and technical language, but its model card recommends evaluating the model
  in the actual deployment domain. OpenAI publishes no 24-versus-32 kbps Opus
  transcription result.
  [Whisper model card](https://github.com/openai/whisper/blob/main/model-card.md)

## Engineering inferences

These conclusions are not vendor guarantees:

- **Mono is appropriate for one-person dictation.** It avoids spending bits on
  a redundant second channel. Multi-speaker/multichannel recordings are a
  different product case.
- **Requesting 16 kHz is reasonable, forcing it client-side is not.** Whisper
  resamples internally, ElevenLabs accepts encoded waveforms, and the browser
  may ignore an ideal media constraint. Extra client transcoding increases CPU
  use and risks a second lossy encode without evidence of better recognition.
- **Opus is the right first preference for Chrome/Firefox.** Both providers
  accept WebM/Opus-family input, and its compression makes the product's 5 MiB
  budget feasible. Preserve a supported browser fallback such as MP4 and send
  its actual MIME type.
- **32 kbps is a cautious compromise, not a proven optimum.** It fits the
  nominal envelope, is the lowest Opus bitrate ElevenLabs itself exposes for
  generated speech, and avoids pushing below any bitrate the vendors document.
- Echo cancellation, noise suppression and automatic gain can help ordinary
  laptop/phone dictation, especially while device audio is playing, but the
  reviewed vendor sources publish no setting-specific accuracy data. Validate
  clean speech, background noise, quiet speakers, Hebrew/English, clipping and
  Bluetooth input in live acceptance.

## Acceptance measurement

Before locking the bitrate, compare 24 and 32 kbps against either the browser's
higher/default setting on the same representative utterances. Record exact
word error rate (or transcript edit distance) plus file size across Chrome,
Safari and mobile where supported. Include quiet speech, noise, proper nouns,
code terms, Hebrew and English. Do not adopt 24 kbps merely because it fits the
byte budget; adopt it only if the measured accuracy loss is negligible for the
product's real audio.
