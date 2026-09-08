import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@fontsource/michroma/400.css"

import { App } from "./app/app"
import "./app/globals.css"

const root = document.getElementById("root")
if (!root) throw new Error("Missing application root")

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
