"use client"

import { useId, useMemo } from "react"
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs"

import { CodeDiff } from "./code-diff"
import { DiffChangesList, RawPatch, type ToolDiffProps } from "./tool-diff-text"

/** Lines past which a file's diff starts collapsed. */
const MAX_COLLAPSED_LINES = 40

function parsePatch(patch: string): FileDiffMetadata[] | undefined {
  try {
    const files = parsePatchFiles(patch, undefined, true).flatMap(
      (parsed) => parsed.files
    )
    return files.length > 0 ? files : undefined
  } catch {
    return undefined
  }
}

function PatchView({
  id,
  patch,
  labels,
}: { id: string; patch: string } & Pick<ToolDiffProps, "labels">) {
  const files = useMemo(() => parsePatch(patch), [patch])
  if (!files) return <RawPatch patch={patch} labels={labels} />
  return files.map((file, index) => (
    <CodeDiff
      key={`${file.name}:${index}`}
      id={`${id}-${index}`}
      fileDiff={file}
      labels={labels}
      maxCollapsedLines={MAX_COLLAPSED_LINES}
    />
  ))
}

/** The changed files, then each patch rendered as a syntax-highlighted diff. */
export function ToolDiff({ diffs, labels }: ToolDiffProps) {
  const id = useId()
  return (
    <div dir="ltr" className="flex min-w-0 flex-col gap-2">
      <DiffChangesList diffs={diffs} labels={labels} />
      {diffs.map((diff, index) =>
        diff.patch ? (
          <PatchView
            key={index}
            id={`${id}-${index}`}
            patch={diff.patch}
            labels={labels}
          />
        ) : null
      )}
    </div>
  )
}
