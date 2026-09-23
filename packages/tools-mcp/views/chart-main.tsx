import { render_chartSchema } from "../../../shared/presentation/tools"
import { ChartView } from "./chart-view"
import { startView } from "./view"

startView("chart", render_chartSchema, ChartView)
