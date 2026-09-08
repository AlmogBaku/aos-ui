import type { Locale } from "@/lib/i18n/config"
import type { ReadAloudLabels } from "../elements/read-aloud"
import type { CaptureError } from "./voice-capture"

export type VoiceLabels = {
  transcription: string
  voiceTurn: string
  modePicker: string
  record: string
  modeHint: string
  finish: string
  send: string
  discard: string
  retry: string
  starting: string
  recording: string
  transcribing: string
  limit: string
  readAloud: string
  stopSpeaking: string
  synthesizing: string
  autoplay: string
  loading: string
  configureTranscription: string
  configureSpeech: string
  unavailable: string
  browser: string
  idleRequired: string
  emptyRequired: string
  voiceNeedsBoth: string
  speechError: string
  playback: ReadAloudLabels
  errors: Record<CaptureError, string>
}

export const voiceLabels: Record<Locale, VoiceLabels> = {
  en: {
    transcription: "Transcription",
    voiceTurn: "Voice turn",
    modePicker: "Microphone mode",
    record: "Record",
    modeHint:
      "Tap to record. Hold, press Arrow Down, or Shift+F10 to change mode.",
    finish: "Finish",
    send: "Send",
    discard: "Discard recording",
    retry: "Retry transcription",
    starting: "Waiting for microphone",
    recording: "Recording",
    transcribing: "Transcribing",
    limit:
      "Recording stopped for review. Review the transcript before sending.",
    readAloud: "Read aloud",
    stopSpeaking: "Stop reading",
    synthesizing: "Generating audio",
    autoplay: "Press Play to listen.",
    loading: "Checking speech services",
    configureTranscription: "Configure speech-to-text for this runtime.",
    configureSpeech: "Configure text-to-speech for this runtime.",
    unavailable:
      "Speech service is unavailable. Check the runtime connection and voice setup.",
    browser:
      "Recording requires microphone access on HTTPS or localhost and a supported browser.",
    idleRequired:
      "Voice turns require an attached, idle Session with no pending approval.",
    emptyRequired:
      "Send or clear the draft, attachments, and queued messages before a voice turn.",
    voiceNeedsBoth: "Voice turns require both transcription and read-aloud.",
    speechError:
      "Audio could not be generated or played. You can try Read aloud again.",
    playback: {
      play: "Play",
      pause: "Pause",
      loading: "Generating audio",
      progress: "Read aloud progress",
      time: (e, d) => `${e} of ${d}`,
      speed: (r) => `Playback speed, currently ${r} times`,
    },
    errors: {
      permission:
        "Microphone permission was denied. Allow it in your browser and try again.",
      microphone:
        "The microphone could not record. Check the device and try again.",
      transcription: "Transcription failed. Retry the recording or discard it.",
      silence: "No speech was detected. Nothing was sent.",
      "too-large":
        "The recording reached the 5 MiB limit. Nothing was sent; record a shorter message.",
      authentication: "Sign in again to use voice.",
      unconfigured: "Configure speech for this runtime.",
      unavailable: "The speech service is unavailable.",
    },
  },
  he: {
    transcription: "תמלול",
    voiceTurn: "תור קולי",
    modePicker: "מצב המיקרופון",
    record: "הקלטה",
    modeHint: "לחיצה להקלטה. לחיצה ארוכה, חץ למטה או Shift+F10 לשינוי מצב.",
    finish: "סיום",
    send: "שליחה",
    discard: "ביטול ההקלטה",
    retry: "ניסיון תמלול חוזר",
    starting: "ממתין למיקרופון",
    recording: "מקליט",
    transcribing: "מתמלל",
    limit: "ההקלטה נעצרה לבדיקה. יש לבדוק את התמלול לפני השליחה.",
    readAloud: "הקראה",
    stopSpeaking: "עצירת ההקראה",
    synthesizing: "מפיק שמע",
    autoplay: "יש ללחוץ על ניגון כדי להאזין.",
    loading: "בודק שירותי קול",
    configureTranscription: "יש להגדיר תמלול עבור סביבת ההרצה הזו.",
    configureSpeech: "יש להגדיר הקראה עבור סביבת ההרצה הזו.",
    unavailable:
      "שירות הקול אינו זמין. יש לבדוק את החיבור ואת הגדרות הקול של סביבת ההרצה.",
    browser:
      "הקלטה דורשת הרשאת מיקרופון, דפדפן תומך וחיבור HTTPS או localhost.",
    idleRequired: "תור קולי דורש שיחה מחוברת ופנויה, ללא בקשת הרשאה ממתינה.",
    emptyRequired:
      "יש לשלוח או לנקות את הטיוטה, הקבצים וההודעות שבתור לפני תור קולי.",
    voiceNeedsBoth: "תור קולי דורש גם תמלול וגם הקראה.",
    speechError: "לא ניתן להפיק או לנגן שמע. אפשר לנסות להפעיל הקראה שוב.",
    playback: {
      play: "ניגון",
      pause: "השהיה",
      loading: "מפיק שמע",
      progress: "התקדמות ההקראה",
      time: (e, d) => `${e} מתוך ${d}`,
      speed: (r) => `מהירות הניגון כעת פי ${r}`,
    },
    errors: {
      permission: "הגישה למיקרופון נדחתה. יש לאפשר אותה בדפדפן ולנסות שוב.",
      microphone: "לא ניתן להקליט מהמיקרופון. יש לבדוק את המכשיר ולנסות שוב.",
      transcription: "התמלול נכשל. אפשר לנסות לתמלל שוב או לבטל את ההקלטה.",
      silence: "לא זוהה דיבור. לא נשלחה הודעה.",
      "too-large":
        "ההקלטה הגיעה למגבלת 5 MiB. לא נשלחה הודעה; יש להקליט הודעה קצרה יותר.",
      authentication: "יש להיכנס שוב כדי להשתמש בקול.",
      unconfigured: "יש להגדיר קול עבור סביבת ההרצה הזו.",
      unavailable: "שירות הקול אינו זמין.",
    },
  },
}
