# PWA icons

Generated from `public/logo-adaptive.svg`. Regenerate them only when the logo
changes; `vite.config.ts` lists the results in the web manifest and
`index.html` links the Apple touch icon.

That SVG fills its two groups with the `--logo-shell` and `--logo-core` custom
properties declared on `:root`, so it can follow `prefers-color-scheme` in the
browser. The generator's rasterizer (resvg) ignores `:root` custom properties
and renders both groups flat black, which loses the teal core. Substitute the
light-mode palette into a temporary copy first:

```bash
sed -e 's/var(--logo-shell)/#27272B/' -e 's/var(--logo-core)/#319F98/' \
  public/logo-adaptive.svg > /tmp/aos-logo-light.svg
bunx @vite-pwa/assets-generator --preset minimal-2023 /tmp/aos-logo-light.svg
```

The generator writes beside its source, so move the five PNGs here and keep the
temporary SVG out of the repository. The preset's `favicon.ico` is intentionally
not kept: nothing references it, because `index.html` uses the adaptive SVG as
its icon.

The generator is deliberately not a dependency. The `pwa-*` icons stay
transparent so Android can mask the notification icon; the maskable and Apple
touch icons keep the preset's opaque white background and 0.3 padding.
