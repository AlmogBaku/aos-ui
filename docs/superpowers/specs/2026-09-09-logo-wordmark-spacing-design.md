# Logo wordmark spacing design

## Goal

Make the AOS wordmark more distinctive by using Michroma with extra-wide letter spacing, while preserving the existing adaptive signet and workspace layout.

## Visual design

- Render every element using the shared `.aos-wordmark` class in Michroma at weight 400.
- Set wordmark letter spacing to `0.38em` and retain the existing `line-height: 1`.
- Continue using `/logo-adaptive.svg` as the product signet without changing its size, colors, or placement.
- Preserve all surrounding gaps, navigation dimensions, responsive behavior, and English/Hebrew layout behavior.

## Font delivery

Bundle Michroma locally through `@fontsource/michroma` and import its 400-weight stylesheet into the application CSS. This avoids a runtime dependency on Google Fonts and keeps static deployments deterministic.

The CSS custom property `--font-aos-wordmark` remains the single wordmark font boundary and will resolve to Michroma with a sans-serif fallback.

## Scope

The change is limited to the shared wordmark typography and its font dependency. It does not alter the logo artwork, product name, ordinary application typography, localization, or component structure.

## Verification

- Confirm the focused stylesheet/dependency change through the existing automated tests.
- Run TypeScript checking, linting, and the production build.
- Confirm that both current `.aos-wordmark` consumers inherit Michroma and `0.38em` tracking.
