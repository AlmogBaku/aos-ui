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
    more: string
    audio: string
    video: string
    playbackSpeed: string
    view: (filename: string) => string
    loading: string
    unreachable: string
    noPreview: string
    tooLarge: string
    htmlTitle: string
    htmlView: string
    preview: string
    source: string
    copy: string
    copied: string
    copyFailed: string
    csvTruncated: (rows: number) => string
    pdfTitle: string
    previousPage: string
    nextPage: string
    page: (page: number, pages: number) => string
    pageShort: (page: number, pages: number) => string
    zoomIn: string
    zoomOut: string
    zoomFit: string
    zoomLevel: (percent: number) => string
    imageTitle: string
    sidebar: string
    outline: string
    pages: string
    goToPage: (page: number) => string
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
      more: "More actions",
      audio: "Audio",
      video: "Video",
      playbackSpeed: "Playback speed",
      view: (filename) => `View ${filename}`,
      loading: "Loading file…",
      unreachable: "Can't reach this file.",
      noPreview: "No preview is available for this file.",
      tooLarge: "This file is too large to preview.",
      htmlTitle: "HTML preview",
      htmlView: "HTML view",
      preview: "Preview",
      source: "Source",
      copy: "Copy",
      copied: "Copied",
      copyFailed: "Copy failed",
      csvTruncated: (rows) => `Showing the first ${rows} rows.`,
      pdfTitle: "PDF preview",
      previousPage: "Previous page",
      nextPage: "Next page",
      page: (page, pages) => `Page ${page} of ${pages}`,
      pageShort: (page, pages) => `${page}/${pages}`,
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      zoomFit: "Fit to view",
      zoomLevel: (percent) => `${percent}%`,
      imageTitle: "Image preview",
      sidebar: "Sidebar",
      outline: "Outline",
      pages: "Pages",
      goToPage: (page) => `Page ${page}`,
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
      more: "פעולות נוספות",
      audio: "שמע",
      video: "וידאו",
      playbackSpeed: "מהירות ניגון",
      view: (filename) => `הצגת ${filename}`,
      loading: "הקובץ נטען…",
      unreachable: "לא ניתן לגשת לקובץ הזה.",
      noPreview: "אין תצוגה מקדימה לקובץ הזה.",
      tooLarge: "הקובץ גדול מדי לתצוגה מקדימה.",
      htmlTitle: "תצוגה מקדימה של HTML",
      htmlView: "תצוגת HTML",
      preview: "תצוגה מקדימה",
      source: "קוד מקור",
      copy: "העתקה",
      copied: "הועתק",
      copyFailed: "ההעתקה נכשלה",
      csvTruncated: (rows) => `מוצגות ${rows} השורות הראשונות.`,
      pdfTitle: "תצוגה מקדימה של PDF",
      previousPage: "העמוד הקודם",
      nextPage: "העמוד הבא",
      page: (page, pages) => `עמוד ${page} מתוך ${pages}`,
      pageShort: (page, pages) => `${page}/${pages}`,
      zoomIn: "הגדלה",
      zoomOut: "הקטנה",
      zoomFit: "התאמה לתצוגה",
      zoomLevel: (percent) => `${percent}%`,
      imageTitle: "תצוגה מקדימה של תמונה",
      sidebar: "סרגל צד",
      outline: "תוכן עניינים",
      pages: "עמודים",
      goToPage: (page) => `עמוד ${page}`,
    },
  },
}
