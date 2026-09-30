import type { PresentArtifactResult } from "../../../shared/presentation/tools"
import { ViewTitle } from "./ui/view-title"
import type { ViewProps } from "./view"

/** The file `present_artifact` shows, named by its result. */
export function ArtifactView({ value }: ViewProps<PresentArtifactResult>) {
  return (
    <div className="p-3">
      <ViewTitle title={value.filename} />
    </div>
  )
}
