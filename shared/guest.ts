export type GuestLocale = "en" | "he"

export type GuestUi = {
  lang?: GuestLocale
  name?: string
  logoUrl?: string
  accent?: string
  title?: string
  message?: string
}

export type GuestCapabilities = {
  attachments: boolean
  edit: boolean
  regenerate: boolean
  branches: boolean
  questions: boolean
  transcription: boolean
  speech: boolean
}

type GuestBootstrapBase = {
  conversation: string
  expiresAt: number
  ui?: GuestUi
  capabilities: GuestCapabilities
}

export type GuestBootstrap = GuestBootstrapBase &
  ({ state: "new"; prefill?: string } | { state: "existing"; prefill?: never })

export type GuestJson =
  | null
  | boolean
  | number
  | string
  | readonly GuestJson[]
  | { readonly [key: string]: GuestJson }

export type GuestDisplayKind = "chart" | "map" | "stats" | "plan"

export type GuestDisplay = {
  id: string
  kind: GuestDisplayKind
  payload: {
    args: { [key: string]: GuestJson }
    result?: GuestJson
  }
}

export type GuestArtifact = {
  id: string
  filename: string
  mimeType?: string
  sizeBytes?: number
  source:
    | { type: "provider"; reference: string }
    | { type: "inline"; encoding: "base64"; data: string }
}

export type GuestContentPart =
  | { type: "text"; text: string }
  | {
      type: "image"
      url: string
      filename?: string
      mime?: string
    }
  | {
      type: "file"
      url: string
      filename?: string
      mime?: string
    }
  | { type: "display"; display: GuestDisplay }
  | { type: "artifact"; artifact: GuestArtifact }

export type GuestMessage = {
  id: string
  role: "user" | "assistant"
  content: GuestContentPart[]
  parentId?: string
}

export type GuestQuestionOption = {
  label: string
  description: string
}

export type GuestQuestion = {
  header: string
  question: string
  options: GuestQuestionOption[]
  multiple?: boolean
  custom?: boolean
}

/** `id` is a gateway-owned opaque handle, never a native request identifier. */
export type GuestPendingQuestion = {
  id: string
  questions: GuestQuestion[]
}

export type GuestHistory = {
  messages: GuestMessage[]
  pendingQuestions: GuestPendingQuestion[]
  running: boolean
  branches?: Record<string, string[]>
}
