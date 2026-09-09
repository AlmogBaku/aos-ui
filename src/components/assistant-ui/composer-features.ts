export type ComposerModelOption = {
  readonly id: string
  readonly label: string
  readonly group?: string | undefined
}

export type ComposerFeatureViewModel = {
  readonly model?:
    | {
        readonly options: readonly ComposerModelOption[]
        readonly selectedId: string
        readonly select: (id: string) => Promise<void>
      }
    | undefined
  readonly context?:
    | {
        readonly usedTokens: number
        readonly maxTokens: number
        readonly estimated?: boolean | undefined
      }
    | undefined
}
