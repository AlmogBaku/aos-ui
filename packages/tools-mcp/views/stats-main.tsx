import { render_statsSchema } from "../../../shared/presentation/tools"
import { StatsView } from "./stats-view"
import { startView } from "./view"

startView("stats", render_statsSchema, StatsView)
