/**
 * pino's browser build, imported by its path so every resolver loads it: Vite
 * picks it for `pino` by the package's `browser` field, Vitest's Node
 * resolution would not. It takes pino's own options and types.
 */
declare module "pino/browser.js" {
  import pino from "pino"
  export default pino
}
