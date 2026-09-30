/** The two locales a view renders in; the host reports a BCP 47 tag. */
export type ViewLocale = "en" | "he"

export function viewLocale(tag: string | undefined): ViewLocale {
  return tag?.toLowerCase().startsWith("he") ? "he" : "en"
}

/** The tag a view formats numbers and dates with. */
export const INTL_LOCALE: Record<ViewLocale, string> = {
  en: "en-US",
  he: "he-IL",
}

export type ViewLabels = {
  waiting: string
  invalid: string
  cancelled: string
  chart: {
    showData: string
    hideData: string
    dataLabel: (title: string) => string
  }
  map: {
    loading: string
    fallbackTitle: string
    showLocations: string
    hideLocations: string
    locationsLabel: (title: string) => string
  }
  artifact: {
    refresh: string
    download: string
    open: string
    pip: string
    loading: string
    unreachable: string
    noPreview: string
    tooLarge: string
    htmlTitle: string
    pdfTitle: string
    previousPage: string
    nextPage: string
    page: (page: number, pages: number) => string
  }
}

export const VIEW_LABELS: Record<ViewLocale, ViewLabels> = {
  en: {
    waiting: "Waiting for data…",
    invalid: "This data could not be shown.",
    cancelled: "This tool call was cancelled.",
    chart: {
      showData: "View chart data",
      hideData: "Hide chart data",
      dataLabel: (title) => `${title} data`,
    },
    map: {
      loading: "Loading map…",
      fallbackTitle: "Map",
      showLocations: "View map locations",
      hideLocations: "Hide map locations",
      locationsLabel: (title) => `${title} locations`,
    },
    artifact: {
      refresh: "Refresh",
      download: "Download",
      open: "Open in new tab",
      pip: "Picture in picture",
      loading: "Loading file…",
      unreachable: "Can't reach this file.",
      noPreview: "No preview is available for this file.",
      tooLarge: "This file is too large to preview.",
      htmlTitle: "HTML preview",
      pdfTitle: "PDF preview",
      previousPage: "Previous page",
      nextPage: "Next page",
      page: (page, pages) => `Page ${page} of ${pages}`,
    },
  },
  he: {
    waiting: "בהמתנה לנתונים…",
    invalid: "לא ניתן להציג את הנתונים.",
    cancelled: "הפעלת הכלי בוטלה.",
    chart: {
      showData: "הצגת נתוני התרשים",
      hideData: "הסתרת נתוני התרשים",
      dataLabel: (title) => `${title} — נתוני תרשים`,
    },
    map: {
      loading: "המפה נטענת…",
      fallbackTitle: "מפה",
      showLocations: "הצגת מיקומי המפה",
      hideLocations: "הסתרת מיקומי המפה",
      locationsLabel: (title) => `${title} — מיקומים`,
    },
    artifact: {
      refresh: "רענון",
      download: "הורדה",
      open: "פתיחה בכרטיסייה חדשה",
      pip: "תמונה בתוך תמונה",
      loading: "הקובץ נטען…",
      unreachable: "לא ניתן לגשת לקובץ הזה.",
      noPreview: "אין תצוגה מקדימה לקובץ הזה.",
      tooLarge: "הקובץ גדול מדי לתצוגה מקדימה.",
      htmlTitle: "תצוגה מקדימה של HTML",
      pdfTitle: "תצוגה מקדימה של PDF",
      previousPage: "העמוד הקודם",
      nextPage: "העמוד הבא",
      page: (page, pages) => `עמוד ${page} מתוך ${pages}`,
    },
  },
}
