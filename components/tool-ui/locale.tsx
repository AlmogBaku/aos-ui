"use client"

import { createContext, useContext, type ReactNode } from "react"

import type { RichToolPhase } from "./types"

export type ToolUiLocale = "en" | "he"
export type ToolUiDirection = "ltr" | "rtl"
export type ToolUiToolName =
  | "question"
  | "permission"
  | "plan"
  | "monty"
  | "chart"
  | "map"
  | "stats"
  | "subagentActivity"
  | "skillActivity"
  | "toolActivity"
export type ToolUiActivityKind = "subagent" | "skill" | "tool"
export type ToolUiActivityStatus =
  "running" | "waiting" | "completed" | "failed"

export type ToolUiLocaleLabels = {
  states: Record<RichToolPhase, string>
  common: {
    copied: string
    copyFailed: string
    retry: string
    displayLoading: string
    displayUnavailable: string
  }
  assistant: {
    toolCalls: (count: number) => string
    reasoning: string
    reasoningDuration: (seconds: number) => string
    copyCode: string
    imageContent: string
    imagePreview: string
    zoomImage: string
    zoomedImage: string
    closeImage: string
    imageLoading: string
    imageLoadFailed: string
    generatingImage: string
    imageGenerationFailed: string
    providerBlockedImage: string
    regenerateImage: string
    regeneratingImage: string
    downloadImage: string
    copyImage: string
    markdownLoading: string
    markdownUnavailable: string
  }
  question: {
    description: string
    answerOptions: string
    answerLabel: string
    placeholder: string
    submit: string
    recording: string
    response: string
    recorded: string
    expired: string
    failed: string
  }
  permission: {
    title: string
    defaultAction: (toolName: string) => string
    keepPermission: string
    persistentExplanation: string
    confirmAlways: string
    back: string
    sending: string
    answered: string
    expired: string
    failed: string
    unavailable: string
    allowOnce: string
    allowAlways: string
    rejectAlways: string
    reject: string
    scopeTitle: string
    scopeLabel: string
  }
  planSteps: Record<"pending" | "active" | "completed" | "failed", string>
  planCaption: string
  planProgressLabel: string
  planProgress: (done: number, total: number) => string
  questionProgressLabel: string
  showMorePlanSteps: (count: number) => string
  hideMorePlanSteps: string
  activities: Record<ToolUiActivityKind, string>
  activityStatuses: Record<ToolUiActivityStatus, string>
  activityTranscript: {
    title: string
    loading: string
    unavailable: string
  }
  generic: {
    malformed: (displayName: string) => string
    malformedExplanation: string
    copyJson: string
  }
  monty: {
    title: string
    description: string
    code: string
    copyCode: string
    inspectCode: string
    result: string
    copyResult: string
    inspectResult: string
  }
  chart: {
    unavailable: string
    loading: string
    showData: string
    hideData: string
    waiting: string
    value: string
    dataLabel: (title: string) => string
  }
  map: {
    unavailable: string
    loading: string
    showLocations: string
    hideLocations: string
    waiting: string
    locationsLabel: (title: string) => string
  }
  stats: {
    waiting: string
  }
  toolNames: Record<ToolUiToolName, string>
}

export const enToolUiLabels: ToolUiLocaleLabels = {
  states: {
    pending: "Needs response",
    submitting: "Submitting",
    answered: "Answered",
    running: "Running",
    complete: "Complete",
    failed: "Failed",
    unavailable: "Unavailable",
    expired: "Expired",
    cancelled: "Cancelled",
  },
  common: {
    copied: "Copied",
    copyFailed: "Copy failed",
    retry: "Retry",
    displayLoading: "Loading tool display…",
    displayUnavailable:
      "Tool display unavailable. The raw payload remains available.",
  },
  assistant: {
    toolCalls: (count) => `${count} tool ${count === 1 ? "call" : "calls"}`,
    reasoning: "Reasoning",
    reasoningDuration: (seconds) => `Reasoning (${seconds}s)`,
    copyCode: "Copy code",
    imageContent: "Image content",
    imagePreview: "Image preview",
    zoomImage: "Zoom image",
    zoomedImage: "Zoomed image preview",
    closeImage: "Close image",
    imageLoading: "Loading image…",
    imageLoadFailed: "Image could not be loaded",
    generatingImage: "Generating image…",
    imageGenerationFailed: "Image could not be generated",
    providerBlockedImage: "The provider blocked this image.",
    regenerateImage: "Regenerate image",
    regeneratingImage: "Regenerating image…",
    downloadImage: "Download image",
    copyImage: "Copy image",
    markdownLoading: "Loading formatted text…",
    markdownUnavailable:
      "Formatted text unavailable. The source remains available.",
  },
  question: {
    description: "Choose an option or write your own response.",
    answerOptions: "Answer options",
    answerLabel: "Your answer",
    placeholder: "Write a response",
    submit: "Submit answer",
    recording: "Recording your answer…",
    response: "Response:",
    recorded: "Recorded",
    expired: "This question expired before an answer was recorded.",
    failed:
      "The answer could not be recorded. Retry from the active request if it is still available.",
  },
  permission: {
    title: "Permission request",
    defaultAction: (toolName) => `Run ${toolName || "tool"}`,
    keepPermission: "Keep this permission?",
    persistentExplanation:
      "Future matching actions can proceed without asking again.",
    confirmAlways: "Confirm always",
    back: "Back",
    sending: "Sending your decision…",
    answered: "Your provider recorded this decision.",
    expired: "This permission request expired. No permission was granted.",
    failed:
      "The provider did not record this decision. The request may be retried while active.",
    unavailable: "The provider did not supply an answerable choice.",
    allowOnce: "Allow once",
    allowAlways: "Always allow",
    rejectAlways: "Always reject",
    reject: "Reject",
    scopeTitle: "Persistent scope",
    scopeLabel: "Persistent permission scope",
  },
  planSteps: {
    pending: "Pending",
    active: "In progress",
    completed: "Complete",
    failed: "Failed",
  },
  planCaption: "Attached to this response.",
  planProgressLabel: "Plan progress",
  planProgress: (done, total) => `${done} of ${total} plan steps complete`,
  questionProgressLabel: "Question progress",
  showMorePlanSteps: (count) =>
    `Show ${count} more ${count === 1 ? "step" : "steps"}`,
  hideMorePlanSteps: "Hide extra steps",
  activities: {
    subagent: "Subagent",
    skill: "Skill",
    tool: "Tool activity",
  },
  activityStatuses: {
    running: "Running",
    waiting: "Waiting",
    completed: "Completed",
    failed: "Failed",
  },
  activityTranscript: {
    title: "Transcript",
    loading: "Transcript is loading…",
    unavailable: "Transcript unavailable.",
  },
  generic: {
    malformed: (displayName) => `Could not safely render ${displayName}`,
    malformedExplanation:
      "The tool returned data that did not match this renderer. The raw payload is preserved below.",
    copyJson: "Copy JSON",
  },
  monty: {
    title: "Monty result",
    description:
      "Provider-executed code and its recorded output. Browser execution is disabled.",
    code: "Code",
    copyCode: "Copy code",
    inspectCode: "Inspect source code",
    result: "Result",
    copyResult: "Copy result",
    inspectResult: "Inspect full result",
  },
  chart: {
    unavailable: "Chart visual unavailable. The data table remains available.",
    loading: "Loading chart visual…",
    showData: "View chart data",
    hideData: "Hide chart data",
    waiting: "Waiting for chart data…",
    value: "Value",
    dataLabel: (title) => `${title} data`,
  },
  map: {
    unavailable: "Map visual unavailable. The location list remains available.",
    loading: "Loading map visual…",
    showLocations: "View map locations",
    hideLocations: "Hide map locations",
    waiting: "Waiting for map data…",
    locationsLabel: (title) => `${title} locations`,
  },
  stats: {
    waiting: "Waiting for metrics…",
  },
  toolNames: {
    question: "Question",
    permission: "Permission",
    plan: "Plan",
    monty: "Monty",
    chart: "Chart",
    map: "Map",
    stats: "Metrics",
    subagentActivity: "Subagent activity",
    skillActivity: "Skill activity",
    toolActivity: "Tool activity",
  },
}

export const heToolUiLabels: ToolUiLocaleLabels = {
  states: {
    pending: "נדרשת תשובה",
    submitting: "בשליחה",
    answered: "נענה",
    running: "בביצוע",
    complete: "הושלם",
    failed: "נכשל",
    unavailable: "לא זמין",
    expired: "פג תוקף",
    cancelled: "בוטל",
  },
  common: {
    copied: "הועתק",
    copyFailed: "ההעתקה נכשלה",
    retry: "ניסיון חוזר",
    displayLoading: "תצוגת הכלי נטענת…",
    displayUnavailable: "תצוגת הכלי אינה זמינה. נתוני המקור עדיין זמינים.",
  },
  assistant: {
    toolCalls: (count) =>
      count === 1 ? "קריאה אחת לכלי" : `${count} קריאות לכלים`,
    reasoning: "חשיבה",
    reasoningDuration: (seconds) => `חשיבה (${seconds} שנ׳)`,
    copyCode: "העתקת קוד",
    imageContent: "תוכן תמונה",
    imagePreview: "תצוגה מקדימה של תמונה",
    zoomImage: "הגדלת התמונה",
    zoomedImage: "תצוגת תמונה מוגדלת",
    closeImage: "סגירת התמונה",
    imageLoading: "התמונה נטענת…",
    imageLoadFailed: "לא ניתן לטעון את התמונה",
    generatingImage: "התמונה נוצרת…",
    imageGenerationFailed: "לא ניתן ליצור את התמונה",
    providerBlockedImage: "הספק חסם את התמונה.",
    regenerateImage: "יצירת התמונה מחדש",
    regeneratingImage: "התמונה נוצרת מחדש…",
    downloadImage: "הורדת התמונה",
    copyImage: "העתקת התמונה",
    markdownLoading: "הטקסט המעוצב נטען…",
    markdownUnavailable: "הטקסט המעוצב אינו זמין. המקור עדיין זמין.",
  },
  question: {
    description: "בחרו אפשרות או כתבו תשובה חופשית.",
    answerOptions: "אפשרויות תשובה",
    answerLabel: "התשובה שלך",
    placeholder: "כתיבת תשובה",
    submit: "שליחת תשובה",
    recording: "התשובה נשמרת…",
    response: "תשובה:",
    recorded: "נשמרה",
    expired: "תוקף השאלה פג לפני שנשמרה תשובה.",
    failed: "לא ניתן היה לשמור את התשובה. אפשר לנסות שוב כל עוד הבקשה פעילה.",
  },
  permission: {
    title: "בקשת הרשאה",
    defaultAction: (toolName) => `הפעלת ${toolName || "כלי"}`,
    keepPermission: "לשמור את ההרשאה?",
    persistentExplanation: "פעולות תואמות בעתיד יוכלו להתבצע בלי לבקש שוב.",
    confirmAlways: "אישור קבוע",
    back: "חזרה",
    sending: "ההחלטה נשלחת…",
    answered: "הספק שמר את ההחלטה.",
    expired: "תוקף בקשת ההרשאה פג. לא ניתנה הרשאה.",
    failed: "הספק לא שמר את ההחלטה. אפשר לנסות שוב כל עוד הבקשה פעילה.",
    unavailable: "הספק לא סיפק אפשרות שניתן להשיב באמצעותה.",
    allowOnce: "אישור חד־פעמי",
    allowAlways: "אישור קבוע",
    rejectAlways: "דחייה קבועה",
    reject: "דחייה",
    scopeTitle: "היקף הרשאה קבועה",
    scopeLabel: "היקף ההרשאה הקבועה",
  },
  planSteps: {
    pending: "ממתין",
    active: "בביצוע",
    completed: "הושלם",
    failed: "נכשל",
  },
  planCaption: "מצורפת לתשובה הזו.",
  planProgressLabel: "התקדמות התוכנית",
  planProgress: (done, total) => `${done} מתוך ${total} שלבים בתוכנית הושלמו`,
  questionProgressLabel: "התקדמות השאלה",
  showMorePlanSteps: (count) => `הצגת ${count} שלבים נוספים`,
  hideMorePlanSteps: "הסתרת השלבים הנוספים",
  activities: {
    subagent: "סוכן משנה",
    skill: "מיומנות",
    tool: "פעילות כלי",
  },
  activityStatuses: {
    running: "בביצוע",
    waiting: "בהמתנה",
    completed: "הושלם",
    failed: "נכשל",
  },
  activityTranscript: {
    title: "תמליל",
    loading: "התמליל נטען…",
    unavailable: "התמליל אינו זמין.",
  },
  generic: {
    malformed: (displayName) => `לא ניתן להציג בבטחה: ${displayName}`,
    malformedExplanation:
      "הכלי החזיר נתונים שאינם תואמים למציג זה. המטען הגולמי נשמר למטה.",
    copyJson: "העתקת JSON",
  },
  monty: {
    title: "תוצאת Monty",
    description: "הקוד הופעל אצל הספק והפלט תועד. הרצה בדפדפן מושבתת.",
    code: "קוד",
    copyCode: "העתקת קוד",
    inspectCode: "בדיקת קוד המקור",
    result: "תוצאה",
    copyResult: "העתקת תוצאה",
    inspectResult: "בדיקת התוצאה המלאה",
  },
  chart: {
    unavailable: "התרשים אינו זמין. טבלת הנתונים עדיין זמינה.",
    loading: "התרשים נטען…",
    showData: "הצגת נתוני התרשים",
    hideData: "הסתרת נתוני התרשים",
    waiting: "בהמתנה לנתוני התרשים…",
    value: "ערך",
    dataLabel: (title) => `${title} — נתוני תרשים`,
  },
  map: {
    unavailable: "המפה אינה זמינה. רשימת המיקומים עדיין זמינה.",
    loading: "המפה נטענת…",
    showLocations: "הצגת מיקומי המפה",
    hideLocations: "הסתרת מיקומי המפה",
    waiting: "בהמתנה לנתוני המפה…",
    locationsLabel: (title) => `${title} — מיקומים`,
  },
  stats: {
    waiting: "בהמתנה למדדים…",
  },
  toolNames: {
    question: "שאלה",
    permission: "הרשאה",
    plan: "תוכנית",
    monty: "Monty",
    chart: "תרשים",
    map: "מפה",
    stats: "מדדים",
    subagentActivity: "פעילות סוכן משנה",
    skillActivity: "פעילות מיומנות",
    toolActivity: "פעילות כלי",
  },
}

type ToolUiLocaleContextValue = {
  locale: ToolUiLocale
  direction: ToolUiDirection
  labels: ToolUiLocaleLabels
}

const localeValues: Record<ToolUiLocale, ToolUiLocaleContextValue> = {
  en: { locale: "en", direction: "ltr", labels: enToolUiLabels },
  he: { locale: "he", direction: "rtl", labels: heToolUiLabels },
}

const ToolUiLocaleContext = createContext<ToolUiLocaleContextValue>(
  localeValues.en
)

export function ToolUiLocaleProvider({
  locale = "en",
  children,
}: {
  locale?: ToolUiLocale
  children: ReactNode
}) {
  return (
    <ToolUiLocaleContext.Provider value={localeValues[locale]}>
      {children}
    </ToolUiLocaleContext.Provider>
  )
}

export function useToolUiLocale() {
  return useContext(ToolUiLocaleContext)
}
