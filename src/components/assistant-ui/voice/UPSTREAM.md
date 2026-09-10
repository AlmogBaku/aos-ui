# Selective Assistant UI Elements reuse

Source: [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui),
commit [`0afb5989cc3e2f1b9343f687025bbef009151ca0`](https://github.com/assistant-ui/assistant-ui/tree/0afb5989cc3e2f1b9343f687025bbef009151ca0).

- `../elements/composer-voice.tsx`: ComposerVoice from
  `packages/ui/src/components/react/assistant-ui/elements/composer.tsx`.
  Retains upstream recording layout, 14-bar geometry and completion controls.
  Local changes: the bars show bounded live levels from the active microphone
  instead of upstream's decorative sine motion, plus a localized transcribing
  label, elapsed-time clock formatting, logical layout, theme recording dot and
  reduced-motion treatment.
- `../elements/read-aloud.tsx`: upstream
  `packages/ui/src/components/react/assistant-ui/elements/read-aloud.tsx`.
  Local changes: localized accessible labels/time/speed, touch targets and LTR
  numeric clock. The current complete-audio adapter passes -1 for word
  highlighting, drives the timeline from real audio time, and adds local Blob
  seeking by pointer or keyboard. Assistant UI's speech adapter does not
  expose media seeking.
- `../elements/voice-surfaces.tsx`: selected surface/typography/ShimmerLabel
  helpers from `elements/surfaces.tsx` and equivalent range helpers from
  `elements/utils/range.ts`. No whole-composer or thread regeneration.

The surrounding runtime-agnostic capture/playback and PTT controllers,
mode-picker gesture, provider adapters, safety coordination and integration
wrappers are AOS code. They compose exported Assistant UI interfaces; packages
are not patched.

## Upstream license

MIT License

Copyright (c) 2025 AgentbaseAI Inc.

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
