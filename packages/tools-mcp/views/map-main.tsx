import { render_mapSchema } from "../../../shared/presentation/tools"
import { MapView } from "./map-view"
import { startView } from "./view"

startView("map", render_mapSchema, MapView)
