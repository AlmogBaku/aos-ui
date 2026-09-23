"use client"

import { createContext, useContext, type ReactNode } from "react"

import type { AosDiffChange } from "./tool-artifact"
import type { RichToolPhase } from "./types"

export type ToolUiLocale = "en" | "he"
export type ToolUiDirection = "ltr" | "rtl"
export type ToolUiToolName =
  | "question"
  | "permission"
  | "subagentActivity"
  | "skillActivity"
  | "toolActivity"
export type ToolUiActivityKind = "subagent" | "skill" | "tool"
export type ToolUiActivityStatus =
  "running" | "waiting" | "completed" | "failed"
export type ToolUiActionKind =
  | "skill"
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "command"
  | "search"
  | "fetch"
  | "think"
  | "switchMode"
  | "inspect"
  | "subagent"
  | "generic"
/** How a settled turn's collapsed work is headlined. */
export type TurnFoldKind =
  "worked" | "working" | "stopped" | "failed" | "truncated" | "refused"
/** What a run of tool calls did, counted per kind. */
export type ToolRunKind =
  | "readFiles"
  | "changedFiles"
  | "ranCommands"
  | "searchedCode"
  | "searchedWeb"
  | "loadedSkills"
  | "inspected"
  | "delegated"
  | "usedTools"

export type ToolDiffLabels = {
  /** Accessible name of the changed-files list. */
  changes: string
  changeKinds: Record<AosDiffChange["kind"], string>
  /** Read between a moved or copied file's old and new path. */
  renamedTo: string
  lineStats: (additions: number, deletions: number) => string
  copyPatch: string
  copied: string
  showFullDiff: string
  collapseDiff: string
  rawPatch: string
  loading: string
  unavailable: string
}

export type ToolTerminalLabels = {
  output: string
  command: string
  cwd: string
  running: string
  exitCode: (code: number) => string
  signal: (signal: string) => string
  finished: string
  started: string
  ended: (status: string) => string
  truncated: string
  noOutput: string
  copyOutput: string
  copied: string
  loading: string
  unavailable: string
}

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
    toolActions: Record<ToolUiActionKind, { active: string; complete: string }>
    /** The turn's work disclosure; the duration clause is dropped without one. */
    fold: Record<TurnFoldKind, (duration?: string) => string>
    /** One unit of a compact span, e.g. "17m" or "17 דק׳". */
    duration: {
      hours: (hours: number) => string
      minutes: (minutes: number) => string
      seconds: (seconds: number) => string
      /** A tool call that took less than a second. */
      underSecond: string
    }
    /** Accessible name of a tool call's full list of locations. */
    toolLocations: string
    /** The locations a tool row does not name, e.g. "+2 more". */
    moreLocations: (count: number) => string
    toolRun: Record<ToolRunKind, (count: number) => string>
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
    discarded: string
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
    answeredWith: (choice: string) => string
    expired: string
    failed: string
    unavailable: string
    allowOnce: string
    allowAlways: string
    allowSession: string
    rejectAlways: string
    reject: string
    scopeTitle: string
    scopeLabel: string
  }
  questionProgressLabel: string
  activities: Record<ToolUiActivityKind, string>
  activityStatuses: Record<ToolUiActivityStatus, string>
  activityTranscript: {
    title: string
    loading: string
    unavailable: string
  }
  subagent: {
    model: (model: string) => string
    depth: (depth: number) => string
    tokens: (tokens: string) => string
    duration: (duration: string) => string
    filesRead: (count: number) => string
    filesWritten: (count: number) => string
    openSession: string
  }
  generic: {
    malformed: (displayName: string) => string
    malformedExplanation: string
    copyJson: string
  }
  mcpApp: {
    loading: string
    unavailable: string
    frameTitle: (toolName: string) => string
    exitFullscreen: string
  }
  diff: ToolDiffLabels
  terminal: ToolTerminalLabels
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
    toolActions: {
      skill: { active: "Loading", complete: "Loaded" },
      read: { active: "Reading", complete: "Read" },
      edit: { active: "Editing", complete: "Edited" },
      delete: { active: "Deleting", complete: "Deleted" },
      move: { active: "Moving", complete: "Moved" },
      command: { active: "Running", complete: "Ran" },
      search: { active: "Searching", complete: "Searched" },
      fetch: { active: "Fetching", complete: "Fetched" },
      think: { active: "Thinking", complete: "Thought" },
      switchMode: { active: "Switching mode", complete: "Switched mode" },
      inspect: { active: "Inspecting", complete: "Inspected" },
      subagent: { active: "Delegating", complete: "Delegated" },
      generic: { active: "Using", complete: "Used" },
    },
    fold: {
      worked: (duration) => (duration ? `Worked for ${duration}` : "Worked"),
      working: (duration) => (duration ? `Working for ${duration}` : "Working"),
      stopped: (duration) =>
        duration ? `You stopped after ${duration}` : "You stopped",
      failed: (duration) => (duration ? `Failed after ${duration}` : "Failed"),
      truncated: (duration) =>
        duration
          ? `Stopped at the length limit after ${duration}`
          : "Stopped at the length limit",
      refused: (duration) =>
        duration ? `Declined after ${duration}` : "Declined",
    },
    duration: {
      hours: (hours) => `${hours}h`,
      minutes: (minutes) => `${minutes}m`,
      seconds: (seconds) => `${seconds}s`,
      underSecond: "<1s",
    },
    toolLocations: "Locations",
    moreLocations: (count) => `+${count} more`,
    toolRun: {
      readFiles: (count) =>
        count === 1 ? "read 1 file" : `read ${count} files`,
      changedFiles: (count) =>
        count === 1 ? "changed 1 file" : `changed ${count} files`,
      ranCommands: (count) =>
        count === 1 ? "ran 1 command" : `ran ${count} commands`,
      searchedCode: (count) =>
        count === 1 ? "searched code once" : `searched code ${count} times`,
      searchedWeb: (count) =>
        count === 1
          ? "searched the web once"
          : `searched the web ${count} times`,
      loadedSkills: (count) =>
        count === 1 ? "loaded 1 skill" : `loaded ${count} skills`,
      inspected: (count) =>
        count === 1 ? "inspected once" : `inspected ${count} times`,
      delegated: (count) =>
        count === 1 ? "delegated 1 task" : `delegated ${count} tasks`,
      usedTools: (count) =>
        count === 1 ? "used 1 tool" : `used ${count} tools`,
    },
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
    discarded: "Discarded",
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
    answeredWith: (choice) => `Answered: ${choice}`,
    expired: "This permission request expired. No permission was granted.",
    failed:
      "The provider did not record this decision. The request may be retried while active.",
    unavailable: "The provider did not supply an answerable choice.",
    allowOnce: "Allow once",
    allowAlways: "Always allow",
    allowSession: "Allow for this session",
    rejectAlways: "Always reject",
    reject: "Reject",
    scopeTitle: "Persistent scope",
    scopeLabel: "Persistent permission scope",
  },
  questionProgressLabel: "Question progress",
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
  subagent: {
    model: (model) => `Model ${model}`,
    depth: (depth) => `Depth ${depth}`,
    tokens: (tokens) => `${tokens} tokens`,
    duration: (duration) => `Took ${duration}`,
    filesRead: (count) => (count === 1 ? "Read 1 file" : `Read ${count} files`),
    filesWritten: (count) =>
      count === 1 ? "Wrote 1 file" : `Wrote ${count} files`,
    openSession: "Open session",
  },
  generic: {
    malformed: (displayName) => `Could not safely render ${displayName}`,
    malformedExplanation:
      "The tool returned data that did not match this renderer. The raw payload is preserved below.",
    copyJson: "Copy JSON",
  },

  mcpApp: {
    loading: "Loading the app…",
    unavailable: "The app could not be shown.",
    frameTitle: (toolName) => `${toolName} app`,
    exitFullscreen: "Exit full screen",
  },
  diff: {
    changes: "Changed files",
    changeKinds: {
      add: "Added",
      delete: "Deleted",
      modify: "Modified",
      move: "Moved",
      copy: "Copied",
    },
    renamedTo: "to",
    lineStats: (additions, deletions) =>
      `${additions} ${additions === 1 ? "line" : "lines"} added, ${deletions} removed`,
    copyPatch: "Copy patch",
    copied: "Copied",
    showFullDiff: "Show full diff",
    collapseDiff: "Collapse diff",
    rawPatch: "Patch",
    loading: "Loading diff…",
    unavailable: "Diff view unavailable. The patch text remains available.",
  },
  terminal: {
    output: "Terminal output",
    command: "Command",
    cwd: "Working directory",
    running: "Running",
    exitCode: (code) => `Exit code ${code}`,
    signal: (signal) => `Stopped by ${signal}`,
    finished: "Finished",
    started: "Command started",
    ended: (status) => `Command ended. ${status}`,
    truncated: "Output was truncated.",
    noOutput: "No output",
    copyOutput: "Copy output",
    copied: "Copied",
    loading: "Loading terminal…",
    unavailable:
      "Terminal view unavailable. The plain output remains available.",
  },
  toolNames: {
    question: "Question",
    permission: "Permission",
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
    toolActions: {
      skill: { active: "בטעינה", complete: "נטענה" },
      read: { active: "בקריאה", complete: "נקרא" },
      edit: { active: "בעריכה", complete: "נערך" },
      delete: { active: "במחיקה", complete: "נמחק" },
      move: { active: "בהעברה", complete: "הועבר" },
      command: { active: "בהרצה", complete: "הורץ" },
      search: { active: "בחיפוש", complete: "בוצע חיפוש" },
      fetch: { active: "באחזור", complete: "אוחזר" },
      think: { active: "בחשיבה", complete: "נשקל" },
      switchMode: { active: "בהחלפת מצב", complete: "המצב הוחלף" },
      inspect: { active: "בבדיקה", complete: "נבדק" },
      subagent: { active: "בהאצלה", complete: "הואצל" },
      generic: { active: "בשימוש", complete: "בוצע" },
    },
    fold: {
      worked: (duration) => (duration ? `עבד ${duration}` : "עבד"),
      working: (duration) => (duration ? `עובד ${duration}` : "עובד"),
      stopped: (duration) => (duration ? `עצרת אחרי ${duration}` : "עצרת"),
      failed: (duration) => (duration ? `נכשל אחרי ${duration}` : "נכשל"),
      truncated: (duration) =>
        duration ? `נעצר במגבלת האורך אחרי ${duration}` : "נעצר במגבלת האורך",
      refused: (duration) => (duration ? `סירב אחרי ${duration}` : "סירב"),
    },
    duration: {
      hours: (hours) => `${hours} שע׳`,
      minutes: (minutes) => `${minutes} דק׳`,
      seconds: (seconds) => `${seconds} שנ׳`,
      underSecond: "פחות משנייה",
    },
    toolLocations: "מיקומים",
    moreLocations: (count) => `ועוד ${count}`,
    toolRun: {
      readFiles: (count) =>
        count === 1 ? "קרא קובץ אחד" : `קרא ${count} קבצים`,
      changedFiles: (count) =>
        count === 1 ? "שינה קובץ אחד" : `שינה ${count} קבצים`,
      ranCommands: (count) =>
        count === 1 ? "הריץ פקודה אחת" : `הריץ ${count} פקודות`,
      searchedCode: (count) =>
        count === 1 ? "חיפש בקוד פעם אחת" : `חיפש בקוד ${count} פעמים`,
      searchedWeb: (count) =>
        count === 1 ? "חיפש ברשת פעם אחת" : `חיפש ברשת ${count} פעמים`,
      loadedSkills: (count) =>
        count === 1 ? "טען מיומנות אחת" : `טען ${count} מיומנויות`,
      inspected: (count) =>
        count === 1 ? "בדק פעם אחת" : `בדק ${count} פעמים`,
      delegated: (count) =>
        count === 1 ? "האציל משימה אחת" : `האציל ${count} משימות`,
      usedTools: (count) =>
        count === 1 ? "השתמש בכלי אחד" : `השתמש ב-${count} כלים`,
    },
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
    discarded: "נדחתה",
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
    answeredWith: (choice) => `נענה: ${choice}`,
    expired: "תוקף בקשת ההרשאה פג. לא ניתנה הרשאה.",
    failed: "הספק לא שמר את ההחלטה. אפשר לנסות שוב כל עוד הבקשה פעילה.",
    unavailable: "הספק לא סיפק אפשרות שניתן להשיב באמצעותה.",
    allowOnce: "אישור חד־פעמי",
    allowAlways: "אישור קבוע",
    allowSession: "אישור לסשן הזה",
    rejectAlways: "דחייה קבועה",
    reject: "דחייה",
    scopeTitle: "היקף הרשאה קבועה",
    scopeLabel: "היקף ההרשאה הקבועה",
  },
  questionProgressLabel: "התקדמות השאלה",
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
  subagent: {
    model: (model) => `מודל ${model}`,
    depth: (depth) => `עומק ${depth}`,
    tokens: (tokens) => `${tokens} אסימונים`,
    duration: (duration) => `נמשך ${duration}`,
    filesRead: (count) => (count === 1 ? "קרא קובץ אחד" : `קרא ${count} קבצים`),
    filesWritten: (count) =>
      count === 1 ? "כתב קובץ אחד" : `כתב ${count} קבצים`,
    openSession: "פתיחת שיחה",
  },
  generic: {
    malformed: (displayName) => `לא ניתן להציג בבטחה: ${displayName}`,
    malformedExplanation:
      "הכלי החזיר נתונים שאינם תואמים למציג זה. המטען הגולמי נשמר למטה.",
    copyJson: "העתקת JSON",
  },

  mcpApp: {
    loading: "היישומון נטען…",
    unavailable: "לא ניתן להציג את היישומון.",
    frameTitle: (toolName) => `יישומון ${toolName}`,
    exitFullscreen: "יציאה ממסך מלא",
  },
  diff: {
    changes: "קבצים ששונו",
    changeKinds: {
      add: "נוסף",
      delete: "נמחק",
      modify: "שונה",
      move: "הועבר",
      copy: "הועתק",
    },
    renamedTo: "אל",
    lineStats: (additions, deletions) =>
      `${additions === 1 ? "שורה אחת נוספה" : `${additions} שורות נוספו`}, ${deletions === 1 ? "שורה אחת הוסרה" : `${deletions} שורות הוסרו`}`,
    copyPatch: "העתקת השינויים",
    copied: "הועתק",
    showFullDiff: "הצגת כל השינויים",
    collapseDiff: "כיווץ השינויים",
    rawPatch: "טקסט השינויים",
    loading: "השינויים נטענים…",
    unavailable: "תצוגת השינויים אינה זמינה. טקסט השינויים עדיין זמין.",
  },
  terminal: {
    output: "פלט המסוף",
    command: "פקודה",
    cwd: "תיקיית עבודה",
    running: "בהרצה",
    exitCode: (code) => `קוד יציאה ${code}`,
    signal: (signal) => `נעצר על ידי ${signal}`,
    finished: "הסתיים",
    started: "הפקודה התחילה לרוץ",
    ended: (status) => `הפקודה הסתיימה. ${status}`,
    truncated: "הפלט קוצר.",
    noOutput: "אין פלט",
    copyOutput: "העתקת הפלט",
    copied: "הועתק",
    loading: "המסוף נטען…",
    unavailable: "תצוגת המסוף אינה זמינה. הפלט כטקסט פשוט עדיין זמין.",
  },
  toolNames: {
    question: "שאלה",
    permission: "הרשאה",
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

export function useToolDiffLabels(): ToolDiffLabels {
  return useToolUiLocale().labels.diff
}

export function useToolTerminalLabels(): ToolTerminalLabels {
  return useToolUiLocale().labels.terminal
}
