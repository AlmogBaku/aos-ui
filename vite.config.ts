import { defineConfig } from "vite";

// The probe is always served from the bundled assets at tauri://localhost
// (no dev server; see README), so this config only has to produce dist/.
export default defineConfig({
  clearScreen: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "safari16",
    // Keep every script an external file: the page CSP is `script-src 'self'`.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
});
