import type { ToolDiffLabels } from "./locale"
import type { AosDiff } from "./tool-artifact"

export type ToolDiffProps = {
  diffs: readonly AosDiff[]
  labels: ToolDiffLabels
}

/** Every changed file with what happened to it; the diff's constant part. */
export function DiffChangesList({ diffs, labels }: ToolDiffProps) {
  const changes = diffs.flatMap((diff) => diff.changes)
  if (changes.length === 0) return null
  return (
    <ul aria-label={labels.changes} className="flex flex-col gap-1 text-sm">
      {changes.map((change, index) => (
        <li
          key={`${change.kind}:${change.oldPath ?? ""}:${change.path}:${index}`}
          className="flex min-w-0 items-baseline gap-2"
        >
          <span className="shrink-0 text-xs text-muted-foreground">
            {labels.changeKinds[change.kind]}
          </span>
          <span className="min-w-0 font-mono text-xs break-all">
            {change.oldPath && change.oldPath !== change.path ? (
              <>
                <bdi>{change.oldPath}</bdi> <span aria-hidden="true">→</span>
                <span className="sr-only">{labels.renamedTo}</span>{" "}
              </>
            ) : null}
            <bdi>{change.path}</bdi>
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The changes list and each raw patch as plain text. */
export function DiffTextFallback({ diffs, labels }: ToolDiffProps) {
  return (
    <div dir="ltr" className="flex min-w-0 flex-col gap-2">
      <DiffChangesList diffs={diffs} labels={labels} />
      {diffs.map((diff, index) =>
        diff.patch ? (
          <RawPatch key={index} patch={diff.patch} labels={labels} />
        ) : null
      )}
    </div>
  )
}

export function RawPatch({
  patch,
  labels,
}: {
  patch: string
  labels: ToolDiffLabels
}) {
  return (
    <pre
      dir="ltr"
      aria-label={labels.rawPatch}
      className="max-h-80 overflow-auto rounded-lg border border-border bg-card p-3 font-mono text-xs"
    >
      {patch}
    </pre>
  )
}
