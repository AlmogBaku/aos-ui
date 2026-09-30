import { presentArtifactResultSchema } from "../../../shared/presentation/tools"
import { ArtifactView } from "./artifact-view"
import { startView } from "./view"

startView("artifact", presentArtifactResultSchema, ArtifactView)
