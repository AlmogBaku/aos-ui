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
  },
}
