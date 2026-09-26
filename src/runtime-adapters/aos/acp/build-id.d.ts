/**
 * The build id compiled into every browser chunk by the vite buildIdPlugin:
 * the entry chunk's content hash, so it changes with every deployment.
 * null on the dev server (no build). Only client chunks get the id: the service
 * worker must not read it, since its build would keep the placeholder.
 */
declare const __AOS_BUILD_ID__: string | null | undefined
